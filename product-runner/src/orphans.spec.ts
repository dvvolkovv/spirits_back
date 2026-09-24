import {
  freeProductPort,
  listeningInodes,
  pm2Pids,
  portFromHealthUrl,
  portHolders,
  ProcView,
  releasePort,
} from './orphans';

// ── Подставная /proc ──────────────────────────────────────────────────────────
//
// Строки таблиц сняты с живого контейнера (проба 24.09.2026, образ
// linkeon-product:base): сирота pid 131 держал `:::3000` сокетом 3157549.

const TCP_HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
const TCP6_HEADER =
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** Слушающий `:::3000` из живой пробы — дословно. */
const LIVE_TCP6_LISTEN_3000 =
  '   0: 00000000000000000000000000000000:0BB8 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 3157549 1 0000000000000000 100 0 0 10 0';

interface FakeProcess {
  pid: number;
  ppid: number;
  /** inode сокетов, открытых процессом. */
  sockets?: string[];
  /** Ставит обработчик на SIGTERM и не умирает от него. */
  ignoresTerm?: boolean;
  /** Умирает от SIGTERM не сразу, а через столько пауз ожидания. */
  termAfterSleeps?: number;
  /** Чужой uid: kill отвечает EPERM. */
  foreign?: boolean;
}

interface FakeSocket {
  inode: string;
  port: number;
  v6?: boolean;
  /** 0A — LISTEN, 01 — ESTABLISHED. */
  state?: string;
}

function tableLine(i: number, s: FakeSocket): string {
  const zero = s.v6 ? '0'.repeat(32) : '00000000';
  const port = s.port.toString(16).toUpperCase().padStart(4, '0');
  const remote = s.state && s.state !== '0A' ? `${zero}:D431` : `${zero}:0000`;
  return `   ${i}: ${zero}:${port} ${remote} ${s.state ?? '0A'} 00000000:00000000 00:00000000 00000000  1000        0 ${s.inode} 1 0000000000000000 100 0 0 10 0`;
}

function machine(processes: FakeProcess[], sockets: FakeSocket[], files: Record<string, string> = {}) {
  const alive = new Map(processes.map((p) => [p.pid, { ...p }]));
  const dying = new Map<number, number>();
  const signals: Array<[number, string]> = [];
  let sleeps = 0;

  // Сокет живёт, пока его держит хоть один живой процесс — как в ядре.
  const open = (s: FakeSocket) => [...alive.values()].some((p) => p.sockets?.includes(s.inode));

  const proc: ProcView = {
    read(path) {
      if (path === '/proc/net/tcp')
        return [TCP_HEADER, ...sockets.filter((s) => !s.v6 && open(s)).map((s, i) => tableLine(i, s))].join('\n') + '\n';
      if (path === '/proc/net/tcp6')
        return [TCP6_HEADER, ...sockets.filter((s) => s.v6 && open(s)).map((s, i) => tableLine(i, s))].join('\n') + '\n';
      const status = /^\/proc\/(\d+)\/status$/.exec(path);
      if (status) {
        const p = alive.get(Number(status[1]));
        return p ? `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${p.pid}\nPid:\t${p.pid}\nPPid:\t${p.ppid}\n` : null;
      }
      return files[path] ?? null;
    },
    list(path) {
      if (path === '/proc') return ['self', 'net', 'sys', ...[...alive.keys()].map(String)];
      const fd = /^\/proc\/(\d+)\/fd$/.exec(path);
      if (fd) {
        const p = alive.get(Number(fd[1]));
        return p ? ['0', '1', '2', ...(p.sockets ?? []).map((_, i) => String(20 + i))] : [];
      }
      return [];
    },
    link(path) {
      const m = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(path);
      if (!m) return null;
      const p = alive.get(Number(m[1]));
      if (!p) return null;
      const n = Number(m[2]);
      if (n < 20) return 'pipe:[1]';
      const inode = p.sockets?.[n - 20];
      return inode ? `socket:[${inode}]` : null;
    },
  };

  const kill = (pid: number, signal: NodeJS.Signals) => {
    signals.push([pid, signal]);
    const p = alive.get(pid);
    if (!p) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    if (p.foreign) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    if (signal === 'SIGKILL') alive.delete(pid);
    else if (p.termAfterSleeps) dying.set(pid, p.termAfterSleeps);
    else if (!p.ignoresTerm) alive.delete(pid);
  };

  const sleep = async () => {
    sleeps += 1;
    for (const [pid, left] of [...dying]) {
      if (left <= 1) {
        dying.delete(pid);
        alive.delete(pid);
      } else dying.set(pid, left - 1);
    }
  };

  return { proc, kill, sleep, signals, alive, sleepsDone: () => sleeps };
}

/**
 * Картина demo 23.09.2026 и пробы 24.09.2026: pm2 держит product в errored
 * (pid 0), а порт держит копия, которую pm2 не ведёт, — ребёнок демона pm2.
 */
function demoPicture(over: Partial<Record<'orphan', Partial<FakeProcess>>> = {}) {
  return machine(
    [
      { pid: 1, ppid: 0 }, // tini
      { pid: 7, ppid: 1 }, // раннер: node dist/index.js
      { pid: 20, ppid: 1 }, // PM2 God Daemon
      { pid: 131, ppid: 20, sockets: ['3157549'], ...over.orphan }, // сирота
    ],
    [{ inode: '3157549', port: 3000, v6: true }],
    { '/home/node/.pm2/pm2.pid': '20' },
  );
}

const quick = { graceMs: 300, pollMs: 100 };

// ── Порт продукта ─────────────────────────────────────────────────────────────

describe('portFromHealthUrl', () => {
  it('берёт порт из адреса проверки здоровья', () => {
    // Такой адрес пишут в реестр оба пути заведения: provisioning.service.ts и
    // product-provision.sh.
    expect(portFromHealthUrl('http://127.0.0.1:3000/health')).toBe(3000);
    expect(portFromHealthUrl('http://localhost:8080/api/healthz')).toBe(8080);
    expect(portFromHealthUrl('http://[::1]:3000/health')).toBe(3000);
  });

  it('без явного порта — порт схемы', () => {
    expect(portFromHealthUrl('http://127.0.0.1/health')).toBe(80);
  });

  it('адрес не на этой машине — порта продукта в нём нет', () => {
    // Порт внешнего адреса принадлежит чужой машине (или nginx хоста). Снимать
    // процессы по нему здесь, в контейнере, значило бы стрелять вслепую.
    expect(portFromHealthUrl('https://demo.p.linkeon.io/health')).toBeNull();
    expect(portFromHealthUrl('http://10.0.0.5:3000/health')).toBeNull();
  });

  it('нет адреса или он битый — порта нет', () => {
    expect(portFromHealthUrl(null)).toBeNull();
    expect(portFromHealthUrl('не адрес')).toBeNull();
  });
});

// ── Кто держит порт ───────────────────────────────────────────────────────────

describe('listeningInodes', () => {
  it('находит слушающий сокет в живой строке /proc/net/tcp6', () => {
    const tcp6 = `${TCP6_HEADER}\n${LIVE_TCP6_LISTEN_3000}\n`;

    expect([...listeningInodes([tcp6], 3000)]).toEqual(['3157549']);
  });

  it('IPv4-таблица разбирается так же', () => {
    const tcp = `${TCP_HEADER}\n${tableLine(0, { inode: '777', port: 3000 })}\n`;

    expect([...listeningInodes([tcp], 3000)]).toEqual(['777']);
  });

  it('берёт только LISTEN и только свой порт', () => {
    // Установленное соединение на тот же порт — не держатель: убить его значит
    // оборвать посетителя, а порт это не освободит.
    const tcp = [
      TCP_HEADER,
      tableLine(0, { inode: '100', port: 3000, state: '01' }),
      tableLine(1, { inode: '200', port: 9229 }),
    ].join('\n');

    expect(listeningInodes([tcp], 3000).size).toBe(0);
  });
});

describe('portHolders', () => {
  it('сопоставляет сокет процессу через /proc/<pid>/fd', () => {
    const m = demoPicture();

    expect(portHolders(3000, m.proc)).toEqual([131]);
  });

  it('никто не слушает — никого', () => {
    const m = machine([{ pid: 1, ppid: 0 }], []);

    expect(portHolders(3000, m.proc)).toEqual([]);
  });
});

// ── Освобождение порта ────────────────────────────────────────────────────────

describe('releasePort', () => {
  it('снимает копию, которую pm2 не ведёт (картина demo 23.09)', async () => {
    const m = demoPicture();

    const r = await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(r.killed).toEqual([131]);
    expect(m.alive.has(131)).toBe(false);
    expect(r.survivors).toEqual([]);
  });

  it('текущий процесс pm2 не трогает', async () => {
    // Законного держателя перезапускает сам pm2 — сигнал от нас в обход pm2
    // выглядел бы для него падением.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1 },
        { pid: 32, ppid: 20, sockets: ['500'] },
      ],
      [{ inode: '500', port: 3000, v6: true }],
    );

    const r = await releasePort({ port: 3000, keep: [32], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
    expect(r.killed).toEqual([]);
  });

  it('потомков процесса pm2 тоже не трогает', async () => {
    // Продукт вправе держать порт дочерним процессом; его дерево гасит pm2.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1 },
        { pid: 32, ppid: 20 },
        { pid: 40, ppid: 32, sockets: ['501'] },
      ],
      [{ inode: '501', port: 3000 }],
    );

    await releasePort({ port: 3000, keep: [32], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
  });

  it('раннер и PID 1 не трогает никогда, даже если они держат порт', async () => {
    const m = machine(
      [
        { pid: 1, ppid: 0, sockets: ['600'] },
        { pid: 7, ppid: 1, sockets: ['601'] },
      ],
      [
        { inode: '600', port: 3000 },
        { inode: '601', port: 3000, v6: true },
      ],
    );

    const r = await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
    expect(r.killed).toEqual([]);
  });

  it('демона pm2 не трогает, даже когда порт держит он сам', async () => {
    // В cluster-режиме слушающий сокет принадлежит мастеру — демону pm2.
    // Снять его значит погасить все приложения pm2 разом.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1, sockets: ['700'] },
      ],
      [{ inode: '700', port: 3000, v6: true }],
    );

    await releasePort({ port: 3000, keep: [], spare: [20], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
  });

  it('предков процесса pm2 не трогает', async () => {
    // Демон — родитель ведомого процесса. Даже без pm2.pid он опознаётся по
    // дереву.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1, sockets: ['701'] },
        { pid: 32, ppid: 20 },
      ],
      [{ inode: '701', port: 3000 }],
    );

    await releasePort({ port: 3000, keep: [32], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
  });

  it('процессы, не слушающие этот порт, не трогает', async () => {
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1 },
        { pid: 50, ppid: 1, sockets: ['800'] }, // отладчик на 9229
        { pid: 51, ppid: 1, sockets: ['801'] }, // соединение на 3000, не LISTEN
      ],
      [
        { inode: '800', port: 9229 },
        { inode: '801', port: 3000, state: '01' },
      ],
    );

    await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([]);
  });

  it('сначала SIGTERM, а не сразу SIGKILL', async () => {
    const m = demoPicture();

    await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.signals).toEqual([[131, 'SIGTERM']]);
  });

  it('не возвращается, пока сирота не отпустил порт', async () => {
    // Сигнал — ещё не свободный порт. Перезапуск сразу после kill поймал бы
    // тот же EADDRINUSE, ради которого всё это.
    const m = demoPicture({ orphan: { termAfterSleeps: 2 } });

    const r = await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, ...quick });

    expect(m.alive.has(131)).toBe(false);
    expect(m.sleepsDone()).toBeGreaterThanOrEqual(2);
    expect(r.survivors).toEqual([]);
    // Умер от SIGTERM вовремя — добивать было незачем.
    expect(m.signals).toEqual([[131, 'SIGTERM']]);
  });

  it('глухого к SIGTERM добивает SIGKILL после срока', async () => {
    const m = demoPicture({ orphan: { ignoresTerm: true } });

    const r = await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, graceMs: 300, pollMs: 100 });

    expect(m.signals).toEqual([
      [131, 'SIGTERM'],
      [131, 'SIGKILL'],
    ]);
    // Добивание — только после срока, а не следом за первым сигналом.
    expect(m.sleepsDone()).toBeGreaterThanOrEqual(3);
    expect(m.alive.has(131)).toBe(false);
    expect(r.survivors).toEqual([]);
  });

  it('неснимаемый держатель возвращается выжившим, а не зависанием', async () => {
    const m = demoPicture({ orphan: { foreign: true } });

    const r = await releasePort({ port: 3000, keep: [], proc: m.proc, kill: m.kill, sleep: m.sleep, selfPid: 7, graceMs: 300, pollMs: 100 });

    expect(r.survivors).toEqual([131]);
    // Ожидание ограничено сроком: два окна по три паузы, не больше.
    expect(m.sleepsDone()).toBeLessThanOrEqual(6);
  });
});

// ── Что знает pm2 ─────────────────────────────────────────────────────────────

describe('pm2Pids', () => {
  // Выводы `pm2 pid product` сняты с pm2 7.0.4 в контейнере пробы.
  const execOut = (out: string) => jest.fn(async () => out);

  it('запущенный продукт — его pid', async () => {
    await expect(pm2Pids('product', execOut('266\n'))).resolves.toEqual([266]);
  });

  it('errored или stopped (pm2 печатает 0) — живого процесса у pm2 нет', async () => {
    await expect(pm2Pids('product', execOut('0\n'))).resolves.toEqual([]);
  });

  it('pm2 такого приложения не знает (пустой вывод) — неизвестно, а не «никого»', async () => {
    // Разница решающая. «Никого» разрешает снять любого держателя порта; а
    // если демон pm2 умер и поднят заново пустым, держатель порта — это и
    // есть работающий сайт, и снимать его нельзя: перезапустить его потом
    // будет некому.
    await expect(pm2Pids('product', execOut('\n'))).resolves.toBeNull();
  });

  it('pm2 не ответил — неизвестно', async () => {
    const failing = jest.fn(async () => {
      throw new Error('spawn pm2 ENOENT');
    });

    await expect(pm2Pids('product', failing)).resolves.toBeNull();
  });

  it('служебные строки pm2 вокруг pid не мешают', async () => {
    const out = '[PM2] Spawning PM2 daemon with pm2_home=/home/node/.pm2\n[PM2] PM2 Successfully daemonized\n401\n';

    await expect(pm2Pids('product', execOut(out))).resolves.toEqual([401]);
  });

  it('спрашивает pm2 именно про этот процесс', async () => {
    const exec = execOut('266\n');

    await pm2Pids('product', exec);

    expect(exec).toHaveBeenCalledWith('pm2', ['pid', 'product']);
  });
});

// ── Сборка целиком: что делает раннер перед перезапуском ──────────────────────

describe('freeProductPort', () => {
  const env = { HOME: '/home/node' } as NodeJS.ProcessEnv;

  it('картина demo: pm2 в errored, порт держит сирота — сирота снят, клиенту сказано', async () => {
    const m = demoPicture();
    const phases: string[] = [];

    await freeProductPort({
      healthUrl: 'http://127.0.0.1:3000/health',
      onPhase: (p) => phases.push(p),
      execFileFn: jest.fn(async () => '0\n'),
      env,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(m.signals).toEqual([[131, 'SIGTERM']]);
    expect(phases.join('\n')).toMatch(/131/);
  });

  it('pm2 продукт не знает — порт не трогается', async () => {
    const m = demoPicture();

    await freeProductPort({
      healthUrl: 'http://127.0.0.1:3000/health',
      execFileFn: jest.fn(async () => ''),
      env,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(m.signals).toEqual([]);
  });

  it('демона pm2 опознаёт по pm2.pid и не трогает', async () => {
    // Картина cluster-режима: порт держит сам демон, pm2 product в errored.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 7, ppid: 1 },
        { pid: 20, ppid: 1, sockets: ['900'] },
      ],
      [{ inode: '900', port: 3000, v6: true }],
      { '/home/node/.pm2/pm2.pid': '20\n' },
    );

    await freeProductPort({
      healthUrl: 'http://127.0.0.1:3000/health',
      execFileFn: jest.fn(async () => '0\n'),
      env,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(m.signals).toEqual([]);
  });

  it('PM2_HOME главнее HOME', async () => {
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 20, ppid: 1, sockets: ['901'] },
      ],
      [{ inode: '901', port: 3000 }],
      { '/srv/pm2/pm2.pid': '20' },
    );

    await freeProductPort({
      healthUrl: 'http://127.0.0.1:3000/health',
      execFileFn: jest.fn(async () => '0\n'),
      env: { HOME: '/home/node', PM2_HOME: '/srv/pm2' } as NodeJS.ProcessEnv,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(m.signals).toEqual([]);
  });

  it('порт продукта неизвестен — pm2 даже не спрашивается', async () => {
    const m = demoPicture();
    const exec = jest.fn(async () => '0\n');

    await freeProductPort({
      healthUrl: 'https://demo.p.linkeon.io/health',
      execFileFn: exec,
      env,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(exec).not.toHaveBeenCalled();
    expect(m.signals).toEqual([]);
  });

  it('законный процесс pm2 на порту — тишина: ни сигналов, ни сообщений клиенту', async () => {
    // Обычный ход. Сообщение на каждом ходе было бы шумом в чате клиента.
    const m = machine(
      [
        { pid: 1, ppid: 0 },
        { pid: 7, ppid: 1 },
        { pid: 20, ppid: 1 },
        { pid: 32, ppid: 20, sockets: ['902'] },
      ],
      [{ inode: '902', port: 3000, v6: true }],
      { '/home/node/.pm2/pm2.pid': '20' },
    );
    const phases: string[] = [];

    await freeProductPort({
      healthUrl: 'http://127.0.0.1:3000/health',
      onPhase: (p) => phases.push(p),
      execFileFn: jest.fn(async () => '32\n'),
      env,
      proc: m.proc,
      kill: m.kill,
      sleep: m.sleep,
      selfPid: 7,
      log: () => undefined,
    });

    expect(m.signals).toEqual([]);
    expect(phases).toEqual([]);
  });
});
