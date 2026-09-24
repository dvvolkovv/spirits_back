import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

/**
 * Сироты на порту продукта: процессы, которые держат порт, а pm2 их не ведёт.
 *
 * ОТКУДА ОНИ БЕРУТСЯ — измерено, а не предположено (demo 23.09.2026, проба на
 * машине продуктов 24.09.2026, образ linkeon-product:base, pm2 7.0.4):
 *
 * pm2 гасит процесс своим TreeKill, а тот зовёт `ps -e -o pid=,ppid=`. В образе
 * `ps` не было. spawn падает с ENOENT, и Node шлёт ДВА события — 'error' и
 * 'close'; TreeKill зовёт свой обратный вызов на обоих. Отсюда два
 * processIsDead, два «pid=32 msg=process tree killed» в pm2.log на один
 * «Stopping app:product» — и restartProcessId дважды зовёт startProcessId. Две
 * копии стартуют одновременно: одна занимает порт, вторую pm2 записывает к себе
 * вместо первой, и она крутится в EADDRINUSE до errored. Первая остаётся
 * ребёнком демона pm2 (PPid — демон), но pm2 о ней больше не знает.
 *
 * Дальше pm2 бессилен: `pm2 restart product` у errored-процесса ничего не
 * гасит — только запускает ещё одну копию в занятый порт. Так demo 23.09 и
 * пережил ход: откат вернул файлы, pm2 трижды по 16 раз упал в EADDRINUSE
 * (47 перезапусков), а сирота отдавала отменённую правку.
 *
 * Сироту плодил ЛЮБОЙ перезапуск живого продукта — и агента, и раннера. На
 * пробе без procps рестарт от раннера на чистом контейнере тоже оставил сироту;
 * с procps — ни одной за шесть рестартов. Корень снят в образе (docker/Dockerfile
 * ставит procps). Здесь — страховка: сирота могла остаться от старого образа, от
 * агента, запустившего сервер руками, от следующей поломки pm2. Без уборки она
 * переживает и перезапуск, и откат: pm2 ведь о ней не знает.
 *
 * Лишних демонов pm2 здесь не ищут и не гасят сознательно: демон в контейнере
 * один (HOME=/home/node, PM2_HOME не задан — агент и раннер ходят в него же;
 * рестарт агента 23.09 записан в /home/node/.pm2/pm2.log), и сирота была его
 * ребёнком, а не чужого демона. Снимать приходится держателя ПОРТА, откуда бы он
 * ни взялся, а не угадывать, кто его родил.
 *
 * Инструментов в образе нет (ps появился только с этой правкой, fuser, ss,
 * lsof нет совсем) — всё через /proc.
 */

/** Имя продукта в pm2. Задаёт docker/entrypoint.sh: `pm2 start … --name product`. */
export const PM2_APP = 'product';

/** Перезапуск продукта, живущего под pm2, когда restart_cmd в реестре пуст. */
export const PM2_RESTART_CMD = `pm2 restart ${PM2_APP}`;

/** Чтение /proc. Отказ чтения — не исключение, а «нет данных»: процессы умирают прямо во время обхода. */
export interface ProcView {
  read(path: string): string | null;
  list(path: string): string[];
  link(path: string): string | null;
}

export const realProc: ProcView = {
  read: (path) => {
    try {
      return fs.readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  list: (path) => {
    try {
      return fs.readdirSync(path);
    } catch {
      return [];
    }
  },
  link: (path) => {
    try {
      return fs.readlinkSync(path);
    } catch {
      return null;
    }
  },
};

export type ExecFileFn = (file: string, args: string[]) => Promise<string>;

const execFileAsync = promisify(execFile);

/**
 * execFile, а не exec: имя приложения — константа, шелл не нужен. Срок — чтобы
 * повисший pm2 не повесил ход: без ответа pm2 порт просто не трогаем.
 */
const realExecFile: ExecFileFn = async (file, args) =>
  (await execFileAsync(file, args, { timeout: 15_000, maxBuffer: 1024 * 1024 })).stdout;

const LOOPBACK_HOSTS = new Set(['localhost', '::1']);

/**
 * Порт продукта — из адреса проверки здоровья. Такой адрес
 * (`http://127.0.0.1:3000/health`) пишут в реестр оба пути заведения.
 *
 * Только для адресов на ЭТОЙ машине: порт внешнего адреса принадлежит чужой
 * машине или nginx хоста, и снимать по нему процессы в контейнере значило бы
 * стрелять вслепую.
 */
export function portFromHealthUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host) && !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return null;
  if (parsed.port) return Number(parsed.port);
  if (parsed.protocol === 'http:') return 80;
  if (parsed.protocol === 'https:') return 443;
  return null;
}

/** Состояние LISTEN в /proc/net/tcp{,6}. */
const TCP_LISTEN = '0A';

/**
 * inode слушающих сокетов на порту — из текста /proc/net/tcp и /proc/net/tcp6.
 * Строка: `sl local_address rem_address st … uid timeout inode …`, порт —
 * шестнадцатеричный хвост local_address.
 */
export function listeningInodes(tables: string[], port: number): Set<string> {
  const inodes = new Set<string>();
  for (const table of tables) {
    for (const line of table.split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 10) continue;
      const localPort = parseInt(fields[1].split(':').pop() ?? '', 16);
      if (fields[3] === TCP_LISTEN && localPort === port && fields[9] !== '0') inodes.add(fields[9]);
    }
  }
  return inodes;
}

function pids(proc: ProcView): number[] {
  return proc
    .list('/proc')
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

/** pid-ы процессов, у которых открыт слушающий сокет на порту. */
export function portHolders(port: number, proc: ProcView): number[] {
  const inodes = listeningInodes([proc.read('/proc/net/tcp') ?? '', proc.read('/proc/net/tcp6') ?? ''], port);
  if (!inodes.size) return [];
  const holders: number[] = [];
  for (const pid of pids(proc)) {
    for (const fd of proc.list(`/proc/${pid}/fd`)) {
      const socket = /^socket:\[(\d+)\]$/.exec(proc.link(`/proc/${pid}/fd/${fd}`) ?? '');
      if (socket && inodes.has(socket[1])) {
        holders.push(pid);
        break;
      }
    }
  }
  return holders;
}

/** pid → родитель, по /proc/<pid>/status. */
function parents(proc: ProcView): Map<number, number> {
  const table = new Map<number, number>();
  for (const pid of pids(proc)) {
    const ppid = /^PPid:\s*(\d+)/m.exec(proc.read(`/proc/${pid}/status`) ?? '');
    if (ppid) table.set(pid, Number(ppid[1]));
  }
  return table;
}

function ancestors(pid: number, table: Map<number, number>): number[] {
  const out: number[] = [];
  const seen = new Set<number>([pid]);
  for (let p = table.get(pid); p !== undefined && p > 0 && !seen.has(p); p = table.get(p)) {
    seen.add(p);
    out.push(p);
  }
  return out;
}

function descendants(pid: number, table: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [child, parent] of table) children.set(parent, [...(children.get(parent) ?? []), child]);
  const out: number[] = [];
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (out.includes(next) || next === pid) continue;
    out.push(next);
    queue.push(...(children.get(next) ?? []));
  }
  return out;
}

export interface ReleaseInput {
  port: number;
  /** Процессы, которые ведёт pm2. Их, их потомков и предков (демон) не трогаем. */
  keep: number[];
  /** Ещё процессы, которые трогать нельзя, — демон pm2 из pm2.pid. */
  spare?: number[];
  proc?: ProcView;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<unknown>;
  /** pid самого раннера. */
  selfPid?: number;
  /** Сколько ждать, пока процесс отпустит порт после сигнала. */
  graceMs?: number;
  pollMs?: number;
}

export interface ReleaseResult {
  /** Кому послан сигнал. */
  killed: number[];
  /** Кто держит порт и после SIGKILL (чужой uid, D-состояние). */
  survivors: number[];
}

/**
 * Снимает с порта всех, кого не ведёт pm2. Никогда не трогает PID 1, раннер
 * (и его предков), процессы pm2 с их деревом и демона pm2.
 *
 * Возвращается, только когда порт отпущен или вышел срок: сигнал — ещё не
 * свободный порт, и перезапуск сразу после kill поймал бы тот же EADDRINUSE.
 */
export async function releasePort(input: ReleaseInput): Promise<ReleaseResult> {
  const proc = input.proc ?? realProc;
  const kill = input.kill ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const selfPid = input.selfPid ?? process.pid;
  const graceMs = input.graceMs ?? 3000;
  const pollMs = input.pollMs ?? 100;

  const table = parents(proc);
  const untouchable = new Set<number>([1, selfPid, ...ancestors(selfPid, table), ...(input.spare ?? [])]);
  for (const pid of input.keep) {
    untouchable.add(pid);
    for (const p of ancestors(pid, table)) untouchable.add(p);
    for (const p of descendants(pid, table)) untouchable.add(p);
  }

  const targets = portHolders(input.port, proc).filter((pid) => !untouchable.has(pid));
  if (!targets.length) return { killed: [], survivors: [] };

  const signal = (who: number[], sig: NodeJS.Signals) => {
    for (const pid of who) {
      try {
        kill(pid, sig);
      } catch {
        // ESRCH — уже умер сам; EPERM — не наш: останется в survivors.
      }
    }
  };
  const stillHolding = () => {
    const now = new Set(portHolders(input.port, proc));
    return targets.filter((pid) => now.has(pid));
  };
  const waitReleased = async () => {
    for (let waited = 0; ; waited += pollMs) {
      const left = stillHolding();
      if (!left.length || waited >= graceMs) return left;
      await sleep(pollMs);
    }
  };

  // Сначала вежливо: у продукта может быть обработчик SIGTERM, дописывающий своё.
  signal(targets, 'SIGTERM');
  let left = await waitReleased();
  if (left.length) {
    signal(left, 'SIGKILL');
    left = await waitReleased();
  }
  return { killed: targets, survivors: left };
}

/**
 * pid-ы приложения по мнению pm2 (`pm2 pid <app>`; выводы сняты с pm2 7.0.4).
 *
 * - `[pid…]` — запущено;
 * - `[]` — pm2 его знает, но сейчас не запущено (errored, stopped: pm2 печатает
 *   0) — ни один держатель порта не его;
 * - `null` — pm2 не ответил или приложения не знает (пустой вывод). Это НЕ «никого»:
 *   если демон pm2 умер и поднят заново пустым, держатель порта — и есть
 *   работающий сайт, а перезапустить его после снятия будет некому.
 */
export async function pm2Pids(app: string, execFileFn: ExecFileFn): Promise<number[] | null> {
  let out: string;
  try {
    out = await execFileFn('pm2', ['pid', app]);
  } catch {
    return null;
  }
  const numbers = out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
  if (!numbers.length) return null;
  return numbers.filter((pid) => pid > 0);
}

/** Демон pm2 — из pm2.pid в PM2_HOME (по умолчанию ~/.pm2). */
function pm2DaemonPid(env: NodeJS.ProcessEnv, proc: ProcView): number | null {
  const home = env.PM2_HOME || (env.HOME ? `${env.HOME}/.pm2` : null);
  if (!home) return null;
  const pid = parseInt((proc.read(`${home}/pm2.pid`) ?? '').trim(), 10);
  return pid > 0 ? pid : null;
}

export interface FreeProductPortInput {
  healthUrl: string | null;
  /** Строки для клиента: уходят в поток хода через фазы деплоя. */
  onPhase?: (message: string) => void;
  execFileFn?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  proc?: ProcView;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  sleep?: (ms: number) => Promise<unknown>;
  selfPid?: number;
  /** Строка в лог контейнера — для оператора (`docker logs <slug>`). */
  log?: (line: string) => void;
}

/**
 * Перед перезапуском продукта под pm2: освободить его порт от процессов, которых
 * pm2 не ведёт. Законного держателя (текущий процесс pm2) не трогает — его
 * перезапустит сам pm2.
 *
 * В обычном ходе молчит: держатель порта — процесс pm2, снимать некого, и
 * строка в чате на каждом ходе была бы шумом.
 */
export async function freeProductPort(input: FreeProductPortInput): Promise<void> {
  const report = input.onPhase ?? (() => {});
  const log = input.log ?? ((line: string) => console.log(line));
  const proc = input.proc ?? realProc;

  const port = portFromHealthUrl(input.healthUrl);
  if (port === null) return;

  const keep = await pm2Pids(PM2_APP, input.execFileFn ?? realExecFile);
  if (keep === null) {
    report(`pm2 не знает процесс ${PM2_APP} — порт ${port} не трогаю`);
    log(`[runner] порт ${port}: pm2 не знает ${PM2_APP} (или не ответил) — держателей порта не трогаю`);
    return;
  }

  const daemon = pm2DaemonPid(input.env ?? process.env, proc);
  const result = await releasePort({
    port,
    keep,
    spare: daemon ? [daemon] : [],
    proc,
    kill: input.kill,
    sleep: input.sleep,
    selfPid: input.selfPid,
  });

  if (result.killed.length) {
    report(`порт ${port} держала копия продукта вне pm2 (pid ${result.killed.join(', ')}) — остановлена`);
    log(`[runner] порт ${port}: сняты процессы вне pm2: ${result.killed.join(', ')} (pm2 ведёт: ${keep.join(', ') || 'никого'})`);
  }
  if (result.survivors.length) {
    report(`порт ${port} так и держат процессы вне pm2 (pid ${result.survivors.join(', ')}) — снять не удалось`);
    log(`[runner] порт ${port}: не сняты: ${result.survivors.join(', ')}`);
  }
}
