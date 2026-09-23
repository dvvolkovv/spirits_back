import { createServer, IncomingMessage, ServerResponse } from 'http';
import { AddressInfo } from 'net';
import { HostApi, HostJob, JobReport, PollOutcome } from './api';
import { DEFAULT_POLL_TIMEOUT_MS, HostConfig, loadConfig } from './config';
import {
  HostDeps,
  KNOWN_KINDS,
  deliver,
  loop,
  main,
  provisionOverrides,
  realDeps,
  redact,
  tick,
} from './index';
import { FakeHost, deps as fakeDeps } from './fake-host';
import { ProvisionDeps, hostDeps, provision as provisionReal } from './provision';
import { SleepJob } from './sleep';

const JOB: HostJob = {
  jobId: 'j-1',
  productId: 'p-1',
  slug: 'shop',
  kind: 'site',
  name: 'Магазин',
  runnerToken: 'a'.repeat(64),
  secrets: {},
};

const CONFIG: HostConfig = {
  linkeonUrl: 'https://test.linkeon.io',
  hostToken: 'x'.repeat(64),
  pollIntervalMs: 3000,
  pollTimeoutMs: 10_000,
  requestTimeoutMs: 10_000,
  reportAttempts: 3,
  reportRetryMs: 10_000,
};

function makeDeps(config: Partial<HostConfig> = {}) {
  const poll = jest.fn(async (): Promise<PollOutcome> => ({ ok: true, job: null }));
  const complete = jest.fn(async (_jobId: string, _report: JobReport): Promise<boolean> => true);
  const provision = jest.fn(async (_job: HostJob): Promise<{ port?: number }> => ({ port: 8003 }));
  const sleepProduct = jest.fn(async (_job: SleepJob): Promise<void> => undefined);
  const wakeProduct = jest.fn(async (_job: SleepJob): Promise<void> => undefined);
  const sleepFn = jest.fn(async (_ms: number): Promise<unknown> => undefined);
  const logs: string[] = [];

  const deps: HostDeps = {
    config: { ...CONFIG, ...config },
    api: { poll, complete },
    provision,
    sleepProduct,
    wakeProduct,
    sleep: sleepFn,
    log: (message: string) => {
      logs.push(message);
    },
  };
  return { deps, poll, complete, provision, sleepProduct, wakeProduct, sleep: sleepFn, logs };
}

/** Последний отчёт, доехавший до `complete`. */
function lastReport(complete: jest.Mock): JobReport {
  const calls = complete.mock.calls;
  return calls[calls.length - 1][1] as JobReport;
}

// ---------------------------------------------------------------------------
// Настоящий HTTP.
//
// Стыки 2 (конверт) и 3 (маршруты отдают 201) на моках не проверяются в
// принципе: мок отдаёт ровно то, что в нём написано, и `{ ok: true }` в
// заглушке доказывает форму заглушки, а не то, что `res.ok` истинен на 201.
// Именно эти два стыка и сломались на живом HTTP в предыдущей задаче.
// ---------------------------------------------------------------------------

interface Seen {
  method: string;
  url: string;
  auth?: string;
  contentType?: string;
  body: string;
}

interface Harness {
  base: string;
  seen: Seen[];
  close: () => Promise<void>;
}

function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<Harness> {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        auth: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks).toString('utf8'),
      });
      handler(req, res, Buffer.concat(chunks).toString('utf8'));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        seen,
        close: () =>
          new Promise<void>((done) => {
            // Иначе keep-alive от undici держит сокет и close() не вызывает
            // колбэк — прогон висит до таймаута jest.
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      });
    });
  });
}

/** Ровно то, что делает Nest: @Post по умолчанию отвечает 201, а не 200. */
function reply(res: ServerResponse, status: number, body: string, contentType = 'application/json') {
  res.writeHead(status, { 'content-type': contentType });
  res.end(body);
}

async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (api: HostApi, h: Harness) => Promise<void>,
  config: Partial<HostConfig> = {},
) {
  const h = await startServer(handler);
  try {
    await fn(new HostApi({ ...CONFIG, ...config, linkeonUrl: h.base }), h);
  } finally {
    await h.close();
  }
}

describe('HostApi против настоящего HTTP', () => {
  it('опрос: 201 с конвертом {job:null} — это пустая очередь, а не отказ', async () => {
    // Стык 3. Nest отвечает на @Post кодом 201; сверка `status === 200` дала бы
    // ложный отказ на КАЖДОМ успешном опросе, и агент не забрал бы ни одного
    // задания при полностью исправном сервере.
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ job: null })),
      async (api) => {
        const r = await api.poll();
        expect(r).toEqual({ ok: true, job: null });
      },
    );
  });

  it('опрос: задание достаётся из конверта, а не подменяется конвертом', async () => {
    // Стык 2. `{ job: {...} }` истинно как объект целиком — без разворота
    // провижининг уехал бы на объекте без слага и без jobId.
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ job: JOB })),
      async (api) => {
        const r = await api.poll();
        expect(r.ok).toBe(true);
        expect(r.ok && r.job).toEqual(JOB);
      },
    );
  });

  it('опрос идёт на маршрут агента с Bearer-токеном хоста', async () => {
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ job: null })),
      async (api, h) => {
        await api.poll();
        expect(h.seen[0].method).toBe('POST');
        // Префикс контроллера пустой, /webhook даёт setGlobalPrefix.
        expect(h.seen[0].url).toBe('/webhook/products/host/poll');
        expect(h.seen[0].auth).toBe(`Bearer ${CONFIG.hostToken}`);
        // Заголовок объявил JSON — тело обязано быть валидным JSON, иначе
        // разборщик тела на той стороне вправе ответить 400.
        expect(() => JSON.parse(h.seen[0].body)).not.toThrow();
      },
    );
  });

  it('опрос: 500 — отказ, а не пустая очередь', async () => {
    // Пустая очередь и лежащий сервер — разные состояния: у них разная пауза,
    // и путать их значит молотить в стену раз в три секунды.
    await withServer(
      (_req, res) => reply(res, 500, '{"message":"Internal server error"}'),
      async (api) => {
        const r = await api.poll();
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toContain('500');
      },
    );
  });

  it('опрос: HTML вместо JSON не роняет агента', async () => {
    // Страница ошибки прокси приезжает с кодом 200 и телом <html>.
    await withServer(
      (_req, res) => reply(res, 200, '<html><body>502 Bad Gateway</body></html>', 'text/html'),
      async (api) => {
        await expect(api.poll()).resolves.toMatchObject({ ok: false });
      },
    );
  });

  it('опрос: ответ без конверта — громкий отказ, а не тихая пустая очередь', async () => {
    // Если конверт исчезнет на сервере, `body?.job ?? null` объявил бы очередь
    // пустой навсегда: задания копятся, в журнале ни строки.
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify(JOB)),
      async (api) => {
        const r = await api.poll();
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toContain('конверт');
      },
    );
  });

  it('опрос: задание без jobId не берётся в работу', async () => {
    // Отчитаться о нём было бы нечем никогда — на хосте остался бы контейнер,
    // о котором сервер не узнает.
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ job: { ...JOB, jobId: '' } })),
      async (api) => {
        const r = await api.poll();
        expect(r.ok).toBe(false);
        expect(r.ok === false && r.error).toContain('jobId');
      },
    );
  });

  it(
    'опрос: молчащий сервер не держит агента дольше срока',
    async () => {
      // Опрос агента КОРОТКИЙ (маршрут отвечает немедленно), поэтому молчание —
      // это всегда неисправность, а не штатное окно long-poll. Без своего
      // срока агент завис бы навсегда: процесс жив, продукты не заводятся.
      await withServer(
        () => {
          /* ответа не будет вовсе */
        },
        async (api) => {
          const started = Date.now();
          await expect(api.poll()).resolves.toMatchObject({ ok: false });
          expect(Date.now() - started).toBeLessThan(1000);
        },
        { pollTimeoutMs: 150 },
      );
    },
    3000,
  );

  it('отчёт: 201 принимается, тело несёт исход и порт', async () => {
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ ok: true })),
      async (api, h) => {
        await expect(api.complete('j-1', { ok: true, port: 8003 })).resolves.toBe(true);
        expect(h.seen[0].url).toBe('/webhook/products/host/jobs/j-1/complete');
        expect(JSON.parse(h.seen[0].body)).toEqual({ ok: true, port: 8003 });
        expect(h.seen[0].contentType).toContain('application/json');
      },
    );
  });

  it('отчёт: 500 виден вызывающему как недоставленный', async () => {
    // Вызывающий обязан знать разницу: недоставленный отчёт об успехе — это
    // живой контейнер, о котором сервер не знает.
    await withServer(
      (_req, res) => reply(res, 500, '{"message":"Internal server error"}'),
      async (api) => {
        await expect(api.complete('j-1', { ok: true, port: 8003 })).resolves.toBe(false);
      },
    );
  });

  it('отчёт: оборванное соединение — false, а не исключение', async () => {
    await withServer(
      (req) => req.socket.destroy(),
      async (api) => {
        await expect(api.complete('j-1', { ok: false, error: 'нет места' })).resolves.toBe(false);
      },
    );
  });

  it(
    'отчёт живёт по своему сроку, а не по сроку опроса',
    async () => {
      // Сроки разные не случайно: опрос повторяется каждые три секунды и его
      // потеря дёшева, а отчёт держит задание. Отчёт, унаследовавший срок
      // опроса, на молчащем сервере задержал бы агента вшестеро дольше
      // собственного бюджета досылки.
      await withServer(
        () => {
          /* ответа не будет вовсе */
        },
        async (api) => {
          const started = Date.now();
          await expect(api.complete('j-1', { ok: true, port: 8003 })).resolves.toBe(false);
          expect(Date.now() - started).toBeLessThan(1000);
        },
        { requestTimeoutMs: 150, pollTimeoutMs: 60_000 },
      );
    },
    3000,
  );

  it('отчёт: id задания не уводит POST на чужой маршрут', async () => {
    await withServer(
      (_req, res) => reply(res, 201, JSON.stringify({ ok: true })),
      async (api, h) => {
        await api.complete('../poll', { ok: true });
        expect(h.seen[0].url).toBe('/webhook/products/host/jobs/..%2Fpoll/complete');
      },
    );
  });
});

describe('loadConfig агента хоста', () => {
  const base = { LINKEON_URL: 'https://test.linkeon.io/', HOST_TOKEN: 'x'.repeat(64) };

  it('без LINKEON_URL агент не стартует', () => {
    expect(() => loadConfig({ HOST_TOKEN: 'x'.repeat(64) })).toThrow(/LINKEON_URL/);
  });

  it('без HOST_TOKEN агент не стартует', () => {
    // Иначе агент уходит в вечный 401, а снаружи это выглядит как «кнопка
    // Новый продукт не работает».
    expect(() => loadConfig({ LINKEON_URL: 'https://x' })).toThrow(/HOST_TOKEN/);
  });

  it('пустая переменная — это «не задана», а не «задана пустой»', () => {
    // `HOST_TOKEN=` в env-файле — самый частый вид «задал, но не задал».
    // Пропущенный сюда, он даёт вечный 401: HostGuard отвергает пустой токен
    // молча.
    expect(() => loadConfig({ ...base, HOST_TOKEN: '' })).toThrow(/HOST_TOKEN/);
    expect(() => loadConfig({ ...base, LINKEON_URL: '' })).toThrow(/LINKEON_URL/);
  });

  it('хвостовой слеш срезается', () => {
    // https://host//webhook/... nginx нормализует не всегда.
    expect(loadConfig(base).linkeonUrl).toBe('https://test.linkeon.io');
  });

  it('умолчания: пауза три секунды, отчёт досылается', () => {
    const c = loadConfig(base);
    expect(c.pollIntervalMs).toBe(3000);
    expect(c.reportAttempts).toBeGreaterThan(1);
    expect(c.reportRetryMs).toBeGreaterThan(0);
  });

  it('опрос агента не длинный — срок опроса не переписан с раннера', () => {
    // У раннера 35 секунд стоят потому, что сервер держит соединение 30.
    // Маршрут агента возвращается немедленно, и 35 секунд здесь были бы
    // числом без причины — заглохший TCP держал бы агента втрое дольше нужного.
    expect(DEFAULT_POLL_TIMEOUT_MS).toBeLessThan(35_000);
    expect(loadConfig(base).pollTimeoutMs).toBe(DEFAULT_POLL_TIMEOUT_MS);
  });

  it('мусор в POLL_INTERVAL_MS роняет старт, а не превращается в горячий цикл', () => {
    // Number('3s') === NaN, а setTimeout(NaN) — это setTimeout(0): опечатка в
    // env-файле стала бы молчаливым обстрелом API с частотой сети.
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '3s' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '0' })).toThrow(/POLL_INTERVAL_MS/);
    expect(() => loadConfig({ ...base, POLL_INTERVAL_MS: '-1' })).toThrow(/POLL_INTERVAL_MS/);
  });
});

describe('tick агента хоста', () => {
  it('пустая очередь — не ошибка и не действие', async () => {
    const { deps, provision, complete, sleep } = makeDeps();

    await expect(tick(deps)).resolves.toBeUndefined();

    expect(provision).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    // Стык 1: сервер не держит соединение, паузу держит агент.
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('нет связи — пауза дольше обычной, процесс жив', async () => {
    const { deps, poll, sleep } = makeDeps();
    poll.mockResolvedValue({ ok: false, error: 'fetch failed' });

    await expect(tick(deps)).resolves.toBeUndefined();

    expect(sleep.mock.calls[0][0]).toBeGreaterThan(3000);
  });

  it('успех докладывается с портом', async () => {
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });

    await tick(deps);

    expect(complete).toHaveBeenCalledWith('j-1', { ok: true, port: 8003 });
  });

  it('бот: успех без порта не отправляет ключ port', async () => {
    // `{ ok: true, port: undefined }` читается в логе и в теле как «порт
    // потерян». У бота публикации порта нет вовсе.
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: { ...JOB, kind: 'bot' } });
    provision.mockResolvedValue({});

    await tick(deps);

    expect(Object.keys(lastReport(complete))).toEqual(['ok']);
  });

  it('падение провижининга докладывается, а не проглатывается', async () => {
    // Непойманная ошибка оставила бы задание в running, и продукт висел бы в
    // provisioning до реаппера с чужой формулировкой про истёкший срок.
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    provision.mockRejectedValue(new Error('нет места на диске'));

    await expect(tick(deps)).resolves.toBeUndefined();

    const report = lastReport(complete);
    expect(report.ok).toBe(false);
    expect(report.ok === false && report.error).toContain('нет места на диске');
  });

  it('отказ без сообщения не уезжает пустой причиной', async () => {
    // Сервер на пустую причину пишет в карточку «без причины», и владелец
    // видит отказ без единого слова о том, что случилось.
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    provision.mockRejectedValue(new Error('   '));

    await tick(deps);

    const report = lastReport(complete);
    expect(report.ok === false && report.error).toBe('провижининг отказал без сообщения');
  });

  it('остатки на хосте уезжают в отчёт и стоят ПЕРЕД сообщением', async () => {
    // Сервер подрезает причину до 2000 символов с головы, а вывод docker со
    // stderr эти 2000 выбирает целиком: приписанные в хвост остатки не доехали
    // бы никогда — то есть ровно тогда, когда они и нужны. Без них владелец
    // видит «нет места», жмёт «повторить» и получает «контейнер уже есть».
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    const e: any = new Error('x'.repeat(3000));
    e.leftovers = ['vhost shop (reload nginx отказал)', 'контейнер shop оставлен нарочно'];
    provision.mockRejectedValue(e);

    await tick(deps);

    const report = lastReport(complete);
    const text = report.ok === false ? report.error : '';
    expect(text.slice(0, 200)).toContain('vhost shop');
    expect(text.indexOf('vhost shop')).toBeLessThan(text.indexOf('xxx'));
  });

  it('отчёт об отказе не уносит в кабинет ни секреты клиента, ни токен Claude', async () => {
    // execFile кладёт в message ВСЮ командную строку — проверено на node 20:
    //   "Command failed: /bin/sh -c exit 3 -- -e SECRET=hunter2"
    // Отчёт уезжает в products.provision_error и показывается в карточке, то
    // есть черновик выкладывал туда наш общий CLAUDE_CODE_OAUTH_TOKEN.
    const secret = '7788:AAHsecretvalue';
    const token = 'r'.repeat(64);
    const oauth = 'sk-ant-oat01-живойтокен';
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({
      ok: true,
      job: { ...JOB, runnerToken: token, secrets: { BOT_TOKEN: secret } },
    });
    provision.mockRejectedValue(
      new Error(
        `Command failed: docker run -d --name shop -e BOT_TOKEN=${secret} `
          + `-e RUNNER_TOKEN=${token} -e CLAUDE_CODE_OAUTH_TOKEN=${oauth} linkeon-product:base\n`
          + 'docker: no space left on device',
      ),
    );

    await tick(deps);

    const report = lastReport(complete);
    const text = report.ok === false ? report.error : '';
    expect(text).not.toContain(secret);
    expect(text).not.toContain(token);
    expect(text).not.toContain(oauth);
    // Диагностика при этом обязана уцелеть — ради неё отчёт и существует.
    expect(text).toContain('no space left on device');
  });

  it('журнал агента не содержит ни секретов задания, ни токена раннера', async () => {
    // Журнал хоста читается шире, чем карточка продукта.
    const secret = '7788:AAHsecretvalue';
    const token = 'r'.repeat(64);
    const { deps, poll, logs } = makeDeps();
    poll.mockResolvedValue({
      ok: true,
      job: { ...JOB, runnerToken: token, secrets: { BOT_TOKEN: secret } },
    });

    await tick(deps);

    const journal = logs.join('\n');
    expect(journal).not.toContain(secret);
    expect(journal).not.toContain(token);
    // Но опознать задание по журналу должно быть можно.
    expect(journal).toContain('j-1');
    expect(journal).toContain('shop');
  });

  it('сорванная доставка отчёта об успехе досылается тем же успехом', async () => {
    // САМЫЙ ДОРОГОЙ СЛУЧАЙ. В черновике `complete` стоял внутри того же try,
    // что и провижининг: отказ доставки ловил общий catch и вторым уходил
    // отчёт { ok: false } — ложь о необратимом. Сервер на такой отчёт ставит
    // продукту failed, а на хосте живой контейнер держит слаг и порт.
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    complete.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await tick(deps);

    expect(complete).toHaveBeenCalledTimes(2);
    for (const [, report] of complete.mock.calls) {
      expect(report).toEqual({ ok: true, port: 8003 });
    }
  });

  it('исчерпанная досылка не превращает успех в отказ и не роняет агента', async () => {
    const { deps, poll, complete, logs } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    complete.mockResolvedValue(false);

    await expect(tick(deps)).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(CONFIG.reportAttempts);
    for (const [, report] of complete.mock.calls) {
      expect(report).toEqual({ ok: true, port: 8003 });
    }
    // Человеку остаётся всё, чем закрыть задание руками: порт хранится только
    // в отчёте, восстановить его серверу неоткуда.
    const journal = logs.join('\n');
    expect(journal).toContain('ВНИМАНИЕ');
    expect(journal).toContain('j-1');
    expect(journal).toContain('8003');
  });

  it('исключение из complete не убивает оборот — стык 4', async () => {
    // Черновик звал complete в catch без обёртки: отказ всплывал из tick в
    // for(;;) и убивал процесс агента. Задание после этого висит десять минут
    // и заканчивается формулировкой про срок, которая неверна.
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    complete.mockRejectedValue(new Error('ECONNRESET'));

    await expect(tick(deps)).resolves.toBeUndefined();

    expect(complete).toHaveBeenCalledTimes(CONFIG.reportAttempts);
    // И ни одна попытка не превратилась в ложь про отказ: провижининг прошёл,
    // контейнер поднят. Именно сюда уезжал черновик, ловивший отказ доставки
    // тем же catch, что и отказ развёртывания.
    for (const [, report] of complete.mock.calls) {
      expect(report).toEqual({ ok: true, port: 8003 });
    }
  });

  it('отчёт об отказе тоже досылается, а не теряется с первой попытки', async () => {
    // Потерянный отчёт об отказе — это чужая формулировка в карточке: владелец
    // читает «не уложилось в 10 минут» вместо настоящей причины.
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    provision.mockRejectedValue(new Error('нет места на диске'));
    complete.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await tick(deps);

    expect(complete).toHaveBeenCalledTimes(2);
    for (const [, report] of complete.mock.calls) {
      expect(report).toMatchObject({ ok: false });
    }
  });

  it('между попытками досылки есть пауза, а после последней — нет', async () => {
    const { deps, poll, complete, sleep } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    complete.mockResolvedValue(false);

    await tick(deps);

    const waits = sleep.mock.calls.map(([ms]) => ms);
    expect(waits).toEqual([CONFIG.reportRetryMs, CONFIG.reportRetryMs]);
  });

  it('доставка с первой попытки не спит и не повторяется', async () => {
    const { deps, poll, complete, sleep } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });

    await tick(deps);

    expect(complete).toHaveBeenCalledTimes(1);
    // Ни паузы досылки, ни паузы опроса: пока агент работал, кнопку мог
    // нажать второй клиент, и очередь разбирается подряд.
    expect(sleep).not.toHaveBeenCalled();
  });
});

describe('deliver', () => {
  it('исход не меняется ни при каком отказе доставки', async () => {
    // Свойство, ради которого исход вычисляется ОТДЕЛЬНО от доставки.
    const { deps, complete } = makeDeps();
    complete.mockResolvedValue(false);

    await deliver(JOB, { ok: true, port: 8003 }, deps);

    for (const [, report] of complete.mock.calls) {
      expect(report).toEqual({ ok: true, port: 8003 });
    }
  });
});

describe('redact', () => {
  it('значение секрета, подобранное клиентом, не снимает маску с нашего токена', () => {
    // Значение секрета не проверяется ничем, кроме нулевого байта, и приезжает
    // от клиента через кабинет. Секрет со значением, равным префиксу НАШЕГО
    // аргумента, вырезался бы у обоих вхождений — и правилу про `-e ИМЯ=`
    // после этого нечего было бы сопоставлять. Оба правила смотрят в исходный
    // текст, поэтому подменять больше нечего.
    const oauth = 'sk-ant-oat01-НАСТОЯЩИЙ';
    const evil = '-e CLAUDE_CODE_OAUTH_TOKEN=';

    const out = redact(
      `Command failed: docker run -e EVIL=${evil} -e CLAUDE_CODE_OAUTH_TOKEN=${oauth} image`,
      { ...JOB, secrets: { EVIL: evil } },
    );

    expect(out).not.toContain(oauth);
  });

  it('значение с пробелами маскируется целиком, а не до первого пробела', () => {
    // Правило про `-e ИМЯ=` режет по \S*. Порога длины у второго правила
    // больше нет: раньше семисимвольное значение маскировалось на одну восьмую.
    const secret = 'a b c d';

    const out = redact(`Command failed: docker run -e K=${secret} image`, {
      ...JOB,
      secrets: { K: secret },
    });

    expect(out).not.toContain('b c d');
  });

  it('соседние отрезки склеиваются, а не множат звёздочки', () => {
    const out = redact('run -e A=xyz image', { ...JOB, secrets: { A: 'xyz' } });

    expect(out).toBe('run -e A=*** image');
  });

  it('вырезает многострочное значение секрета целиком', () => {
    // -e ИМЯ=… обрезается по пробелу, а приватный ключ многострочный: второе
    // правило (известные значения) закрывает то, что не берёт первое.
    const key = '-----BEGIN KEY-----\nAAAA\nBBBB\n-----END KEY-----';
    const out = redact(`Command failed: docker run -e SSH_KEY=${key} image`, {
      ...JOB,
      secrets: { SSH_KEY: key },
    });

    expect(out).not.toContain('AAAA');
    expect(out).not.toContain('BBBB');
  });

  it('не трогает диагностику, в которой секретов нет', () => {
    const out = redact('docker: no space left on device', JOB);
    expect(out).toBe('docker: no space left on device');
  });
});

describe('цикл', () => {
  it('между пустыми оборотами есть НАСТОЯЩАЯ пауза', async () => {
    // Проверяется фейковыми таймерами, а не подменённым sleep: мок доказал бы
    // только что функция вызвана, и `sleep = () => Promise.resolve()` прошёл бы
    // такую проверку, оставив горячий цикл.
    jest.useFakeTimers();
    try {
      const { deps, poll } = makeDeps();
      delete (deps as { sleep?: unknown }).sleep;
      let turns = 0;
      poll.mockImplementation(async () => {
        turns += 1;
        return { ok: true, job: null };
      });

      const done = loop(deps, () => turns < 2);

      await jest.advanceTimersByTimeAsync(0);
      expect(turns).toBe(1);

      await jest.advanceTimersByTimeAsync(2999);
      expect(turns).toBe(1);

      await jest.advanceTimersByTimeAsync(1);
      expect(turns).toBe(2);

      await jest.advanceTimersByTimeAsync(3000);
      await done;
    } finally {
      jest.useRealTimers();
    }
  });

  it('брошенный poll не убивает цикл и не даёт горячего оборота', async () => {
    // Наш клиент не бросает по построению, но зависимость подменяема, а цена
    // единственного промаха — мёртвый агент на машине с чужими продуктами.
    const { deps, poll, sleep, logs } = makeDeps();
    poll.mockRejectedValue(new Error('TypeError: fetch is not a function'));
    let turns = 0;

    await expect(
      loop(deps, () => {
        turns += 1;
        return turns <= 2;
      }),
    ).resolves.toBeUndefined();

    expect(poll).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(3000);
    expect(logs.join('\n')).toContain('цикл продолжается');
  });
});

describe('боевые зависимости', () => {
  /** Собирает realDeps с подменёнными частями и ловит то, с чем позвали provision. */
  function spyRealDeps(job: HostJob = JOB) {
    const logs: string[] = [];
    let captured: ProvisionDeps | undefined;
    const deps = realDeps(CONFIG, {
      log: (m) => logs.push(m),
      buildDeps: (overrides) => overrides as ProvisionDeps,
      provision: async (_job, d) => {
        captured = d;
        return { port: 8003 };
      },
    });
    return { deps, logs, run: () => deps.provision(job), got: () => captured! };
  }

  it('продукты уезжают за работой в тот же Linkeon, что опрашивает агент', async () => {
    // Умолчание в provision.ts — https://my.linkeon.io. Без проброса агент на
    // тестовом стенде поднимал бы продукты, ходящие за задачами на ПРОД:
    // контейнер живой, health зелёный, ходы не доезжают.
    //
    // Проверяется на ТОЙ сборке, которая уходит в прод, а не на самом объекте
    // настроек: выброшенный из realDeps provisionOverrides не краснел ничем.
    const h = spyRealDeps();

    await h.run();

    expect(h.got().linkeonUrl).toBe(CONFIG.linkeonUrl);
  });

  it('фаза печатается в журнал и печатается с маской', async () => {
    // provision.ts зовёт phase() в том числе с e.message от execFile — той же
    // командной строкой, которую для сервера чистит redact. Журнал хоста
    // читается шире, чем карточка продукта.
    const oauth = 'sk-ant-oat01-живойтокен';
    const secret = 'секрет-клиента-целиком';
    const h = spyRealDeps({ ...JOB, secrets: { BOT_TOKEN: secret } });

    await h.run();
    h.got().onPhase!(
      `провижининг отменён: Command failed: docker run -e CLAUDE_CODE_OAUTH_TOKEN=${oauth} `
        + `-v /tmp:/product image, секрет ${secret}`,
    );

    const journal = h.logs.join('\n');
    expect(journal).not.toContain(oauth);
    expect(journal).not.toContain(secret);
    // Но сама фаза в журнал попадает: маска не должна превращаться в тишину.
    expect(journal).toContain('провижининг отменён');
    expect(journal).toContain('/tmp:/product');
  });

  it('main запускает цикл на боевых зависимостях', () => {
    // Иначе точка входа стартует, печатает строку про старт и молча выходит:
    // systemd видит успешное завершение, юнит остановлен, продукты не
    // заводятся.
    const started: HostDeps[] = [];
    const built: HostConfig[] = [];

    return main(
      { LINKEON_URL: 'https://test.linkeon.io/', HOST_TOKEN: 'x'.repeat(64) },
      (config) => {
        built.push(config);
        return makeDeps().deps;
      },
      async (deps) => {
        started.push(deps);
      },
    ).then(() => {
      expect(built).toHaveLength(1);
      expect(built[0].linkeonUrl).toBe('https://test.linkeon.io');
      expect(started).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Вид задания.
//
// До этой задачи `tick` звал развёртывание безусловно. На задании «усыпить»
// агент шёл заводить продукт заново, упирался в отсутствие токена раннера (а
// был бы токен — в занятый каталог) и докладывал про это, а владелец читал
// причину, не имеющую отношения ни к сну, ни к аренде.
// ---------------------------------------------------------------------------

const SLEEP_JOB: HostJob = { ...JOB, jobKind: 'sleep', port: 8003, runnerToken: '', secrets: {} };
const WAKE_JOB: HostJob = { ...SLEEP_JOB, jobKind: 'wake' };

describe('разбор вида задания', () => {
  it('«усыпить» не разворачивает продукт заново', async () => {
    const { deps, poll, provision, sleepProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });

    await tick(deps);

    expect(provision).not.toHaveBeenCalled();
    expect(sleepProduct).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('j-1', { ok: true });
  });

  it('«разбудить» поднимает продукт, а не заводит', async () => {
    const { deps, poll, provision, wakeProduct, sleepProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: WAKE_JOB });

    await tick(deps);

    expect(provision).not.toHaveBeenCalled();
    expect(sleepProduct).not.toHaveBeenCalled();
    expect(wakeProduct).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('j-1', { ok: true });
  });

  it('сон и пробуждение не путаются местами', async () => {
    // Перепутанные, они дают ровно обратное действие: продукт, за который
    // заплатили, гаснет, а неоплаченный поднимается и продолжает есть аренду.
    const { deps, poll, sleepProduct, wakeProduct } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });

    await tick(deps);

    expect(wakeProduct).not.toHaveBeenCalled();
    expect(sleepProduct).toHaveBeenCalledTimes(1);
  });

  it('хостовому шагу уезжают слаг, форма и порт — и больше ничего', async () => {
    // Порт знает только сервер: после `docker stop` на хосте его взять
    // неоткуда, а пробуждение обязано вернуть домен на ТОТ ЖЕ порт.
    // Токена раннера и секретов у этих видов не бывает вовсе (claimJob их не
    // присылает), и тащить их на хостовой шаг незачем.
    const { deps, poll, wakeProduct } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: { ...WAKE_JOB, port: 8123 } });

    await tick(deps);

    const got = wakeProduct.mock.calls[0][0];
    expect(got).toEqual({ slug: 'shop', kind: 'site', port: 8123 });
    expect(Object.keys(got).sort()).toEqual(['kind', 'port', 'slug']);
  });

  it('задание без вида — это заведение, а не отказ', async () => {
    // Сервер до куска 3 поля не слал вовсе, и заданий, кроме заведения, тогда
    // не было. Отказ здесь означал бы агента, выкаченного раньше бэкенда и не
    // заводящего ни одного продукта ни у одного клиента.
    const { deps, poll, provision, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: JOB });
    expect(JOB.jobKind).toBeUndefined();

    await tick(deps);

    expect(provision).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('j-1', { ok: true, port: 8003 });
  });

  it('неизвестный вид — отказ, а не тихое развёртывание', async () => {
    // Сервер катается deploy.sh, агент ставится на машину продуктов руками:
    // новый вид доедет сюда раньше, чем агент научится его исполнять. Отчёт об
    // отказе честнее, чем каркас поверх работающего продукта.
    const { deps, poll, provision, sleepProduct, wakeProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: { ...JOB, jobKind: 'нечто' } });

    await tick(deps);

    expect(provision).not.toHaveBeenCalled();
    expect(sleepProduct).not.toHaveBeenCalled();
    expect(wakeProduct).not.toHaveBeenCalled();
    const report = lastReport(complete);
    expect(report.ok).toBe(false);
  });

  it('причина отказа называет вид и говорит, что на хосте не тронуто ничего', async () => {
    // «Неизвестная ошибка» здесь заставила бы человека ехать на машину
    // продуктов и сверять состояние руками — при том что состояние заведомо
    // не менялось.
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: { ...JOB, jobKind: 'restart' } });

    await tick(deps);

    const report = lastReport(complete);
    const text = report.ok === false ? report.error : '';
    expect(text).toContain('restart');
    expect(text).toMatch(/не тронуто/);
    for (const kind of KNOWN_KINDS) expect(text).toContain(kind);
  });

  it('отказ сна докладывается, а не проглатывается', async () => {
    // Проглоченный, он оставил бы задание в 'running' до сборщика зависших, а
    // продукт — помеченным спящим при работающем контейнере: аренду не платит,
    // гасить его больше нечем.
    const { deps, poll, sleepProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });
    sleepProduct.mockRejectedValue(new Error('No such container: shop'));

    await expect(tick(deps)).resolves.toBeUndefined();

    const report = lastReport(complete);
    expect(report.ok === false && report.error).toContain('No such container');
  });

  it('маскировка причины общая для всех видов, а не только для заведения', async () => {
    // Хостовые шаги сна зовут те же программы через execFile, а он кладёт в
    // message всю командную строку целиком. Отчёт уезжает в карточку продукта.
    const oauth = 'sk-ant-oat01-живойтокен';
    const { deps, poll, wakeProduct, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: WAKE_JOB });
    wakeProduct.mockRejectedValue(
      new Error(`Command failed: docker start shop -e CLAUDE_CODE_OAUTH_TOKEN=${oauth}`),
    );

    await tick(deps);

    const report = lastReport(complete);
    const text = report.ok === false ? report.error : '';
    expect(text).not.toContain(oauth);
    expect(text).toContain('docker start shop');
  });

  it('досылка отчёта общая для всех видов, а не только для заведения', async () => {
    // Потерянный отчёт об удавшемся СНЕ страшнее потерянного отчёта о
    // заведении: контейнер погашен, домен на заглушке, а сервер об этом не
    // знает и через десять минут объявит сон сорвавшимся.
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });
    complete.mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await tick(deps);

    expect(complete).toHaveBeenCalledTimes(2);
    for (const [, report] of complete.mock.calls) expect(report).toEqual({ ok: true });
  });

  it('отчёт о сне не содержит ключа port', async () => {
    // Порт сна не меняет, а `{ ok: true, port: undefined }` читается в логе и
    // в теле как «порт потерян».
    const { deps, poll, complete } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });

    await tick(deps);

    expect(Object.keys(lastReport(complete))).toEqual(['ok']);
  });

  it('журнал называет вид работы, а не только слаг', async () => {
    // Без вида строка журнала на сне и на заведении выглядит одинаково, и
    // разобрать по машине продуктов, что агент делал с продуктом, нечем.
    const { deps, poll, logs } = makeDeps();
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });

    await tick(deps);

    expect(logs.join('\n')).toContain('sleep');
  });

  it('зависший сон отказывает своей формулировкой, а не «провижинингом»', async () => {
    // Общая формулировка на сне читается как заведение, которого никто не
    // заказывал, и врёт про состояние хоста: подчистки у сна нет вовсе,
    // зато контейнер мог остаться живым при уже поставленной заглушке.
    const { deps, poll, sleepProduct, complete } = makeDeps({ provisionTimeoutMs: 50 });
    poll.mockResolvedValue({ ok: true, job: SLEEP_JOB });
    sleepProduct.mockImplementation(() => new Promise<void>(() => {}));

    await tick(deps);

    const report = lastReport(complete);
    const text = report.ok === false ? report.error : '';
    expect(text).toContain('усыпление');
    expect(text).toContain('НЕИЗВЕСТНО');
    expect(text).not.toContain('провижининг');
  });
});

describe('боевые зависимости знают все три вида', () => {
  /** Живой продукт на симуляторе хоста — тем же provision, что и на машине. */
  async function seeded() {
    const host = new FakeHost();
    const { port } = await provisionReal(
      { slug: 'shop', kind: 'site', name: 'Магазин', runnerToken: 'ткн', secrets: {} },
      fakeDeps(host),
    );
    const deps = realDeps(CONFIG, {
      log: () => {},
      buildDeps: (over) => fakeDeps(host, over),
    });
    return { host, port, deps };
  }

  /**
   * Задание `wake` целиком: настоящий хостовой шаг на симуляторе, настоящий
   * разбор вида задания и настоящий отчёт. Заглушка здесь только у сети.
   *
   * На моках это не проверяется в принципе: `wakeProduct` в makeDeps отдаёт то,
   * что в нём написано, и «порт доехал до отчёта» доказывало бы форму заглушки,
   * а не то, что восстановленный порт вообще куда-то едет.
   */
  async function wakeTick(over: Partial<HostJob>) {
    const { host, port, deps: real } = await seeded();
    // Продукт СПИТ — ровно то состояние, в котором приходит задание пробуждения.
    await real.sleepProduct({ slug: 'shop', kind: 'site', port });
    const complete = jest.fn(async (_jobId: string, _report: JobReport): Promise<boolean> => true);
    const deps: HostDeps = {
      ...real,
      api: {
        poll: async (): Promise<PollOutcome> => ({ ok: true, job: { ...WAKE_JOB, ...over } }),
        complete,
      },
      sleep: async () => undefined,
      log: () => {},
    };

    await tick(deps);
    return { host, port, complete };
  }

  it('сон и пробуждение собраны настоящими шагами, а не заглушкой', async () => {
    // Подмена частей здесь ровно для того, чтобы о боевой сборке можно было
    // утверждать что-то кроме «это функция»: выброшенный из realDeps
    // provisionOverrides не краснел ничем, хотя его пропажа означает продукты
    // стенда, уехавшие за работой на прод.
    const { host, port, deps } = await seeded();

    await deps.sleepProduct({ slug: 'shop', kind: 'site', port });

    expect(host.isRunning('shop')).toBe(false);
    expect(host.containers.has('shop')).toBe(true);
    expect(host.vhostMode('shop')).toBe('asleep');

    await deps.wakeProduct({ slug: 'shop', kind: 'site', port });

    expect(host.isRunning('shop')).toBe(true);
    expect(host.vhostMode('shop')).toBe('live');
  });

  it('пробуждение без порта в задании спрашивает контейнер настоящими шагами', async () => {
    // Раньше здесь стоял отказ «нет порта» — как сторож мутации «не класть порт
    // в выжимку». Отказом это быть перестало: порт, потерянный реестром, берётся
    // у контейнера (живой дефект прода 23.09.2026). Сторожем мутации стал отчёт:
    // пробуждение с портом в задании обязано отчитаться БЕЗ порта, а без
    // порта — с портом; оба случая ниже.
    const { host, port, deps } = await seeded();

    await deps.wakeProduct({ slug: 'shop', kind: 'site' });

    expect(host.ran('docker').map((c) => c[1])).toContain('inspect');
    expect(host.liveVhosts.get('shop')).toBe(port);
  });

  it('пробуждение без порта в задании чинит реестр: порт уезжает в отчёт', async () => {
    // ЖИВОЙ ДЕФЕКТ ПРОДА (23.09.2026). У продуктов, заведённых до появления
    // колонки, в реестре NULL — и погашенный такой продукт не поднимался
    // никогда: задание падало «нет порта» каждую минуту. Сервер лечит строку
    // отчётом (`UPDATE products SET port = COALESCE($2, port)`), поэтому
    // восстановленный порт обязан доехать ДО сервера, а не остаться на хосте.
    const { complete } = await wakeTick({ port: null });

    expect(complete).toHaveBeenCalledWith('j-1', { ok: true, port: 8001 });
  });

  it('пробуждение с портом в задании отчитывается БЕЗ порта', async () => {
    // Зеркало предыдущего. Порт в отчёте — это новость для сервера; там, где
    // новостей нет, `{ ok: true, port: … }` читается в журнале и в теле как
    // «порт откуда-то взялся», а мутация «возвращать порт всегда» иначе
    // невидима: серверу-то COALESCE безразличен.
    const { complete } = await wakeTick({ port: 8001 });

    expect(Object.keys(lastReport(complete))).toEqual(['ok']);
  });

  it('сон и пробуждение получают те же настройки хоста, что и заведение', async () => {
    // Сегодня ни один хостовой шаг сна в эти настройки не заглядывает:
    // `vhostBin` и сроки берутся из DEFAULTS, а `linkeonUrl` нужен только
    // заведению. Потерянная здесь сборка настроек не покраснела бы НИЧЕМ — до
    // того дня, когда шагу сна впервые понадобится стенд вместо прода, и
    // тогда спящий продукт стенда чинил бы домен на боевом хосте.
    const captured: ProvisionDeps[] = [];
    const deps = realDeps(CONFIG, {
      log: () => {},
      buildDeps: (over) => over as ProvisionDeps,
      sleepProduct: async (_job, d) => {
        captured.push(d);
      },
      wakeProduct: async (_job, d) => {
        captured.push(d);
      },
    });

    await deps.sleepProduct({ slug: 'shop', kind: 'site', port: 8003 });
    await deps.wakeProduct({ slug: 'shop', kind: 'site', port: 8003 });

    expect(captured.map((d) => d.linkeonUrl)).toEqual([CONFIG.linkeonUrl, CONFIG.linkeonUrl]);
  });

  it('боевая сборка не забывает ни один вид', () => {
    // Пропущенный `wakeProduct` дал бы TypeError в рантайме — то есть продукт,
    // который не удаётся разбудить, при полностью зелёном прогоне.
    const deps = realDeps(CONFIG, { log: () => {} });

    expect(typeof deps.provision).toBe('function');
    expect(typeof deps.sleepProduct).toBe('function');
    expect(typeof deps.wakeProduct).toBe('function');
  });
});

describe('сроки развёртывания', () => {
  it('зависший провижининг заканчивается отказом, а не вечным ожиданием', async () => {
    // Своего срока у provision не было вовсе: заклинивший docker run вешал
    // единственного агента машины навсегда — сервер хоронит задание через 10
    // минут, владелец жмёт «повторить», новое задание не забирает никто.
    const { deps, poll, provision, complete } = makeDeps({ provisionTimeoutMs: 50 });
    poll.mockResolvedValue({ ok: true, job: JOB });
    provision.mockImplementation(() => new Promise<{ port?: number }>(() => {}));

    await expect(tick(deps)).resolves.toBeUndefined();

    const report = lastReport(complete);
    expect(report.ok).toBe(false);
    // Отменить по этому сроку нечего, и отчёт обязан сказать это прямо: иначе
    // «сорвалось» читается как «на хосте чисто», а слаг и порт заняты.
    expect(report.ok === false && report.error).toContain('НЕИЗВЕСТНО');
  });

  it('отказ, пришедший после истечения срока, не роняет агента', async () => {
    // Промис провижининга остаётся в полёте: его позднее падение без
    // обработчика убило бы процесс (Node >= 15) — то есть срок, поставленный
    // ради живучести, сам бы её и рушил.
    const { deps, poll, provision } = makeDeps({ provisionTimeoutMs: 20 });
    poll.mockResolvedValue({ ok: true, job: JOB });
    let boom: (e: Error) => void = () => {};
    provision.mockImplementation(
      () => new Promise<{ port?: number }>((_, reject) => {
        boom = reject;
      }),
    );

    const unhandled: unknown[] = [];
    const listener = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', listener);
    try {
      await tick(deps);
      boom(new Error('docker наконец отвалился'));
      await new Promise((r) => setTimeout(r, 50));

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('конфиг без срока получает умолчание, а не мгновенный срок', async () => {
    // `deps.config.provisionTimeoutMs!` вместо `?? DEFAULT` выглядит невинно и
    // означает setTimeout(undefined) — то есть ноль: КАЖДОЕ развёртывание
    // отказывает по сроку, не начавшись.
    const { deps, poll, provision, complete } = makeDeps();
    expect(deps.config.provisionTimeoutMs).toBeUndefined();
    poll.mockResolvedValue({ ok: true, job: JOB });
    provision.mockImplementation(
      () => new Promise<{ port?: number }>((resolve) => setTimeout(() => resolve({ port: 8003 }), 30)),
    );

    await tick(deps);

    expect(lastReport(complete)).toEqual({ ok: true, port: 8003 });
  });

  it('уложившийся провижининг не оставляет за собой таймер', async () => {
    // Восьмиминутный таймер на каждый оборот — процесс, не завершающийся по
    // SIGTERM, и прогон jest, который не выходит. Считаются живые таймеры, а
    // не вызовы clearTimeout: вызов мог быть и не тот.
    jest.useFakeTimers();
    try {
      const { deps, poll } = makeDeps();
      poll.mockResolvedValue({ ok: true, job: JOB });

      await tick(deps);

      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('заклинивший шаг снимается по сроку самим hostDeps.run', async () => {
    // Первая линия срока: снятый шаг — обычный отказ шага, его ловит catch в
    // provision, и хост подчищается как при любом другом отказе.
    const deps = hostDeps({ runTimeoutMs: 200 });

    await expect(deps.run(['sleep', '10'])).rejects.toThrow(/сроку/);
  }, 5000);
});
