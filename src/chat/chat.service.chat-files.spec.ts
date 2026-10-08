// src/chat/chat.service.chat-files.spec.ts
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Файлы, которые ассистент создал на релее, должны уходить пользователю
 * ссылкой на наш MinIO — и в потоке, и в истории ОДНОЙ И ТОЙ ЖЕ строкой:
 * фронт сверяет ленту с историей посимвольно (historyMerge.ts).
 *
 * Гоняется НАСТОЯЩИЙ streamUniversalAgent с замоканными axios/pg/res, как в
 * chat.service.speech-marker.spec.ts.
 */

const RELAY_FILE = 'https://r.linkeon.io/files/u1_7_ru/report.pdf';
const STORED = 'https://pub/linkeon-chat-files/11111111-2222-4333-8444-555555555555/report.pdf';
const OUTPUT = [{ name: 'report.pdf', url: '/files/u1_7_ru/report.pdf', size: 10 }];
const VIDEO_JOB_ID = '22222222-3333-4444-5555-666666666666';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Та же лента событий, но вместо чистого конца — обрыв соединения: 'error' вместо 'end'. */
function sseStreamThenError(events: any[], err: Error = new Error('upstream dropped')): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    // Второй nextTick — чтобы 'data' по уже запушенным строкам успели дойти
    // до обработчика раньше, чем 'error': именно так и рвётся настоящий
    // сокет — после того как часть события (done с outputFiles) уже разобрана.
    process.nextTick(() => s.emit('error', err));
  });
  return s;
}

/** Фейковый req с .on('close', …) — чтобы тест мог сыграть дисконнект клиента. */
function fakeReq() {
  let closeCb: (() => void) | undefined;
  return {
    on: (event: string, cb: () => void) => { if (event === 'close') closeCb = cb; },
    fireClose: () => closeCb?.(),
  };
}

interface HarnessOpts {
  deltas?: string[];
  outputFiles?: any[];
  store?: any;
  /** Полный список событий — перекрывает deltas/outputFiles, если задан. */
  events?: any[];
  /** 'error' — лента рвётся обрывом вместо чистого конца. */
  afterEvents?: 'end' | 'error';
  /** Для self-heal: второй прогон апстрима — своя лента событий. */
  secondRunEvents?: any[];
  req?: ReturnType<typeof fakeReq>;
  videoJobs?: { id: string }[];
  /** Ответ GET /session/:sid/files — файлы сессии для резолва пустых скобок. */
  sessionFiles?: { name: string; url: string }[];
}

function makeHarness(opts: HarnessOpts) {
  const written: any[] = [];
  const pgCalls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      if (/SELECT id FROM video_jobs/.test(sql)) return { rows: opts.videoJobs ?? [] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    opts.store,
  );
  const events = opts.events ?? [
    ...(opts.deltas ?? []).map((text) => ({ type: 'delta', text })),
    { type: 'done', outputFiles: opts.outputFiles ?? [] },
  ];
  const post = axios.post as jest.Mock;
  // /session/:sid/files — дёргается только когда в тексте есть пустые скобки
  // `[Скачать x]()`. Без мока axios.get (auto-mock jest.mock('axios')) вызов
  // бросил бы синхронно на `.then`, и resolveEmptyFileLinks тихо гасился бы
  // верхним try/catch — тест Fix 5 тогда проходил бы не по той причине.
  (axios.get as jest.Mock).mockResolvedValue({ data: opts.sessionFiles ?? [] });
  const firstData = () => (opts.afterEvents === 'error' ? sseStreamThenError(events) : sseStream(events));
  if (opts.secondRunEvents) {
    post
      .mockImplementationOnce(async () => ({ data: firstData() }))
      .mockImplementationOnce(async () => ({ data: sseStream(opts.secondRunEvents!) }));
  } else {
    post.mockImplementation(async () => ({ data: firstData() }));
  }
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { written.push(JSON.parse(line)); return true; }),
    end: jest.fn(),
  };
  const run = async () => {
    const p = (svc as any).streamUniversalAgent(
      'u1', 'сделай отчёт', '7', '7', [], '', res, 'Роман', '', '', opts.req, false, undefined,
    );
    if (opts.req) {
      // req.on('close', …) регистрируется ПОСЛЕ сохранения user-сообщения —
      // первого await внутри streamUniversalAgent. Пары микротасков хватает,
      // чтобы дойти до регистрации раньше, чем SSE-лента дойдёт до done.
      await Promise.resolve();
      await Promise.resolve();
      (opts.req as ReturnType<typeof fakeReq>).fireClose();
    }
    await p;
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };
  return { written, pgCalls, run, post };
}

const items = (written: any[]) => written.filter((w) => w.type === 'item').map((w) => w.content as string);
const endContent = (written: any[]) => written.find((w) => w.type === 'end')?.content as string | undefined;
const persistedAiText = (pgCalls: { sql: string; params: any[] }[]) =>
  pgCalls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql))?.params[2] as string | undefined;
const storeOk = () => ({ persist: jest.fn(async (urls: string[]) => new Map(urls.map((u) => [u, STORED]))) });

describe('streamUniversalAgent — файлы хода в нашем хранилище', () => {
  // persistResponse ставит 14-секундный таймер очистки dedup-карты; unref, чтобы jest вышел.
  const realSetTimeout = global.setTimeout;
  beforeAll(() => {
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => { (global as any).setTimeout = realSetTimeout; });
  beforeEach(() => { jest.clearAllMocks(); delete process.env.AGENT_URL; });

  it('ссылка уходит клиенту и в историю одной строкой — уже с нашим адресом', async () => {
    const store = storeOk();
    const h = makeHarness({ deltas: ['Готово, отчёт приложил.'], outputFiles: OUTPUT, store });
    await h.run();

    // Второй аргумент — остаток бюджета хода на копирование (fix 4): один
    // дедлайн на все вызовы storeRelayLinks за ход, а не свой полный
    // PERSIST_TURN_BUDGET_MS на каждый.
    expect(store.persist).toHaveBeenCalledWith([RELAY_FILE], { budgetMs: expect.any(Number) });
    const link = items(h.written).find((c) => c.includes('Скачать report.pdf'));
    expect(link).toBe(`\n\n[Скачать report.pdf](${STORED})`);
    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(link);
    expect(saved).not.toContain('r.linkeon.io');
  });

  it('ссылка идёт после текста ответа', async () => {
    const h = makeHarness({ deltas: ['Часть 1. ', 'Часть 2.'], outputFiles: OUTPUT, store: storeOk() });
    await h.run();

    const all = items(h.written);
    expect(all.findIndex((c) => c.includes('Скачать'))).toBeGreaterThan(all.indexOf('Часть 2.'));
  });

  it('файл не скопировался — ссылка остаётся на релей, как раньше', async () => {
    const store = { persist: jest.fn(async () => new Map<string, string>()) };
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${RELAY_FILE})`);
  });

  it('без хранилища — ссылка на релей, как раньше', async () => {
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store: undefined });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${RELAY_FILE})`);
  });

  it('ход из одних файлов не считается пустым и релей не гоняется второй раз', async () => {
    const h = makeHarness({ deltas: [], outputFiles: OUTPUT, store: storeOk() });
    await h.run();

    expect(h.post).toHaveBeenCalledTimes(1);
    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${STORED})`);
  });

  it('адрес релея, набранный моделью, дописывается ссылкой уже на наше хранилище', async () => {
    const h = makeHarness({ deltas: [`Файл тут: \`${RELAY_FILE}\``], store: storeOk() });
    await h.run();

    expect(items(h.written)).toContain(`\n\n[Скачать report.pdf](${STORED})`);
  });

  // Fix 7 (решение владельца): дубль ссылки в ответе лучше файла, который
  // умрёт вместе с /tmp релея — поэтому копируем и дописываем СВОЮ ссылку
  // даже если модель уже напечатала ссылку на релей сама.
  it('модель сама вставила ссылку на релей, и есть outputFiles — наша ссылка всё равно дописывается', async () => {
    const h = makeHarness({
      deltas: [`[отчёт](${RELAY_FILE})`],
      outputFiles: OUTPUT,
      store: storeOk(),
    });
    await h.run();

    const all = items(h.written);
    expect(all).toContain(`\n\n[Скачать report.pdf](${STORED})`);
    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(`[Скачать report.pdf](${STORED})`);
  });

  // Fix 1: апстрим упал ПОСЛЕ done (outputFiles уже разобраны), но до конца
  // потока. Файл всё равно должен попасть и в поток, и в историю.
  it('апстрим рвётся ПОСЛЕ done с outputFiles — ссылка всё равно уходит в поток и в историю', async () => {
    const store = storeOk();
    const h = makeHarness({
      events: [
        { type: 'delta', text: 'Готовлю отчёт.' },
        { type: 'done', outputFiles: OUTPUT },
      ],
      afterEvents: 'error',
      store,
    });
    await h.run();

    const link = `\n\n[Скачать report.pdf](${STORED})`;
    expect(items(h.written)).toContain(link);
    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(link);
  });

  // Fix 5: модель оставила пустые скобки для файла, который уже пришёл через
  // done.outputFiles — не копировать и не дописывать второй раз.
  it('пустые скобки на уже присланный файл — не задваивают копию и строку', async () => {
    const store = storeOk();
    const h = makeHarness({
      deltas: ['Готово: [Скачать report.pdf]()'],
      outputFiles: OUTPUT,
      store,
      // Сессия релея знает report.pdf — без этого resolveEmptyFileLinks не
      // нашёл бы адрес для пустых скобок вовсе, и тест ничего бы не проверял.
      sessionFiles: [{ name: 'report.pdf', url: '/files/u1_7_ru/report.pdf' }],
    });
    await h.run();

    expect(store.persist).toHaveBeenCalledTimes(1);
    // Делим по готовой ссылке `(${STORED})`, а не по подстроке «Скачать
    // report.pdf»: та же подстрока есть и в исходном тексте модели с
    // пустыми скобками, который сам по себе ссылкой не является.
    const resolvedLinks = items(h.written).filter((c) => c.includes(`(${STORED})`));
    expect(resolvedLinks).toHaveLength(1);
  });

  // Пункт 8 из обзора: обрыв клиента ДО done не должен стоить истории ссылки.
  it('клиент дисконнектился до done — история всё равно получает ссылку на файл', async () => {
    const req = fakeReq();
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store: storeOk(), req });
    await h.run();

    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(`[Скачать report.pdf](${STORED})`);
  });

  // Пункт 8: ссылка на файл должна идти ДО маркера [VIDEO_JOB:...] в финальном тексте.
  it('ссылка на файл — перед маркером VIDEO_JOB', async () => {
    const h = makeHarness({
      deltas: ['Готово.'],
      outputFiles: OUTPUT,
      store: storeOk(),
      videoJobs: [{ id: VIDEO_JOB_ID }],
    });
    await h.run();

    const full = items(h.written).join('');
    const linkAt = full.indexOf('Скачать report.pdf');
    const markerAt = full.indexOf(`[VIDEO_JOB:${VIDEO_JOB_ID}]`);
    expect(linkAt).toBeGreaterThan(-1);
    expect(markerAt).toBeGreaterThan(linkAt);
  });

  // Пункт 8: self-heal — первый прогон пуст (без текста и без файлов),
  // только второй приносит outputFiles. Итог — ровно одна строка ссылки, не две.
  it('self-heal: файл появляется только во втором прогоне — ровно одна строка ссылки', async () => {
    const store = storeOk();
    const h = makeHarness({
      events: [{ type: 'done', outputFiles: [] }],
      secondRunEvents: [
        { type: 'delta', text: 'Вот результат.' },
        { type: 'done', outputFiles: OUTPUT },
      ],
      store,
    });
    await h.run();

    expect(h.post).toHaveBeenCalledTimes(2);
    const links = items(h.written).filter((c) => c.includes('Скачать report.pdf'));
    expect(links).toHaveLength(1);
    expect(links[0]).toBe(`\n\n[Скачать report.pdf](${STORED})`);
  }, 10_000);

  // Пункт 8: end.content — то же самое, что персистится, должно содержать ссылку.
  it('end.content содержит сохранённую ссылку на файл', async () => {
    const h = makeHarness({ deltas: ['Готово.'], outputFiles: OUTPUT, store: storeOk() });
    await h.run();

    expect(endContent(h.written)).toContain(`[Скачать report.pdf](${STORED})`);
  });
});
