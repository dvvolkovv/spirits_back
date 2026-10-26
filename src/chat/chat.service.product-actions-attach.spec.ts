import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { verifyProductToolToken } from '../products/product-tool.token';
import { ClientUi } from './client-ui';

jest.mock('axios');

/**
 * Карточка продукта на пути релея (streamUniversalAgent): блок приписывает
 * ТОЛЬКО сервер, после takeForTurn(), а не модель — она видит старые блоки в
 * истории разговора и знает actionId из результата своего же инструмента
 * (manage_product на релее), и может скопировать чужой/просроченный блок.
 *
 * Гоняется НАСТОЯЩИЙ streamUniversalAgent с замоканными axios/pg/res — как в
 * chat.service.speech-marker.spec.ts и chat.service.chat-files.spec.ts (та же
 * вторая половина — обрыв апстрима в catch, sseStreamThenError).
 */

const USER = 'u1';
const ACTION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
// "Модель" в этих тестах сама пишет блок с ДРУГИМ id — проверяем, что именно
// он исчезает, а появляется только серверный (на ACTION_ID).
const FAKE_ID = 'ffffffff-1111-4ccc-8ddd-eeeeeeeeeeee';
const SERVER_BLOCK = '```product-action\n{"id":"' + ACTION_ID + '"}\n```';
const CARDS_UI: ClientUi = { activity: false, ask: false, cards: true };

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Та же лента событий, но вместо чистого конца — обрыв соединения (как chat-files.spec.ts). */
function sseStreamThenError(events: any[], err: Error = new Error('upstream dropped')): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    process.nextTick(() => s.emit('error', err));
  });
  return s;
}

/** Поля multipart-запроса к релею — тот же приём, что в chat.service.interactivity.spec.ts. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

interface HarnessOpts {
  deltas: string[];
  takenActions?: Array<{ id: string }>;
  /** 'error' — лента рвётся обрывом вместо чистого конца (ветка catch). */
  afterEvents?: 'end' | 'error';
}

function makeHarness(opts: HarnessOpts) {
  const written: any[] = [];
  const pgCalls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any, undefined,
  );
  const takeForTurn = jest.fn(async () => opts.takenActions ?? []);
  // Подмена позиционного @Optional-поля напрямую: тащить через конструктор
  // все параметры, что идут перед productActions, незачем — так же делает
  // chat.service.masha-products.spec.ts для того же поля.
  (svc as any).productActions = { takeForTurn };

  const events = [...opts.deltas.map((text) => ({ type: 'delta', text })), { type: 'done' }];
  const post = axios.post as jest.Mock;
  post.mockImplementation(async () => ({
    data: opts.afterEvents === 'error' ? sseStreamThenError(events) : sseStream(events),
  }));

  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { written.push(JSON.parse(line)); return true; }),
    end: jest.fn(),
  };

  const run = async (ui: ClientUi) => {
    await (svc as any).streamUniversalAgent(
      USER, 'создай сайт цветов', '7', '7', [], '', res, 'Роман', '', '',
      undefined, false, undefined, undefined, undefined, undefined, undefined, false,
      ui,
    );
    // persistResponse уходит в setImmediate — даём ему отработать.
    for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
  };

  return { written, pgCalls, run, post, takeForTurn };
}

const items = (written: any[]) => written.filter((w) => w.type === 'item').map((w) => w.content as string);
const endOf = (written: any[]) => written.find((w) => w.type === 'end');
const persistedAiText = (pgCalls: { sql: string; params: any[] }[]) =>
  pgCalls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql))?.params[2] as string | undefined;

describe('streamUniversalAgent — карточка продукта: приписывает сервер, не модель', () => {
  // persistResponse ставит 14-секундный таймер очистки dedup-карты. В тесте он
  // держит event loop открытым, поэтому на время файла помечаем таймеры unref
  // — как в chat.service.speech-marker.spec.ts.
  const realSetTimeout = global.setTimeout;
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => {
    (global as any).setTimeout = realSetTimeout;
    process.env.JWT_SECRET = OLD_SECRET;
  });
  beforeEach(() => jest.clearAllMocks());

  it('метка хода у takeForTurn — ровно та, что ушла в токен products у релея; канал web', async () => {
    const h = makeHarness({ deltas: ['Готово.'], takenActions: [{ id: ACTION_ID }] });
    await h.run(CARDS_UI);

    const fields = fieldsOf(h.post.mock.calls[0][1]);
    const claims = verifyProductToolToken(fields.products_token);
    expect(claims.channel).toBe('web');
    expect(h.takeForTurn).toHaveBeenCalledWith(USER, claims.turn, expect.any(Date), 'web');
  });

  it('клиент с карточками: блок в потоке, в end.content и в истории; сам ничего не допечатал — тела нет', async () => {
    const h = makeHarness({ deltas: ['Готово, создал сайт.'], takenActions: [{ id: ACTION_ID }] });
    await h.run(CARDS_UI);

    expect(items(h.written).some((c) => c.includes(SERVER_BLOCK))).toBe(true);
    expect(endOf(h.written)!.content).toContain(SERVER_BLOCK);
    expect(persistedAiText(h.pgCalls)).toContain(SERVER_BLOCK);
  });

  it('модель сама дописала блок (разрезанный по чанкам потока) — вырезается, остаётся только серверный', async () => {
    // Фейковый блок разрезан по чанкам ровно посередине значения id — так
    // устроен настоящий поток релея, и построчная чистка (как с
    // [VIDEO_JOB:...]) такой разрез не увидит.
    const h = makeHarness({
      deltas: [
        'Готово, создал сайт.\n\n```product-action\n{"id":"',
        FAKE_ID,
        '"}\n```',
      ],
      takenActions: [{ id: ACTION_ID }],
    });
    await h.run(CARDS_UI);

    const end = endOf(h.written)!;
    expect(end.content).toContain(SERVER_BLOCK);
    expect(end.content).not.toContain(FAKE_ID);
    // Ровно один блок — серверный, а не два (фейковый недовырезанный + серверный).
    expect((end.content.match(/```product-action/g) ?? []).length).toBe(1);
    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(SERVER_BLOCK);
    expect(saved).not.toContain(FAKE_ID);
  });

  it('клиент без карточек: ссылка на кабинет вместо блока', async () => {
    const h = makeHarness({ deltas: ['Готово.'], takenActions: [{ id: ACTION_ID }] });
    await h.run({ activity: false, ask: false, cards: false });

    const end = endOf(h.written)!;
    expect(end.content).not.toContain('```product-action');
    expect(end.content).toContain(`https://my.linkeon.io/studio?tab=products&action=${ACTION_ID}`);
  });

  it('действий за ход нет — хвост не добавляется', async () => {
    const h = makeHarness({ deltas: ['Просто ответ.'], takenActions: [] });
    await h.run(CARDS_UI);

    const end = endOf(h.written)!;
    expect(end.content).toBe('Просто ответ.');
  });
});

/**
 * Catch-ветка: апстрим рвётся ПОСЛЕ того, как модель успела дёрнуть инструмент
 * продуктов, но до чистого конца потока. До задачи 11 карточка в этом случае
 * терялась — следующий ход завёл бы новый nonce и никогда её не нашёл.
 */
describe('streamUniversalAgent — карточка продукта переживает обрыв апстрима (catch)', () => {
  const realSetTimeout = global.setTimeout;
  const OLD_SECRET = process.env.JWT_SECRET;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => {
    (global as any).setTimeout = realSetTimeout;
    process.env.JWT_SECRET = OLD_SECRET;
  });
  beforeEach(() => jest.clearAllMocks());

  it('тот же nonce, тот же канал web — и в catch, что и в обычной ветке', async () => {
    const h = makeHarness({ deltas: ['Завожу бота.'], takenActions: [{ id: ACTION_ID }], afterEvents: 'error' });
    await h.run(CARDS_UI);

    const fields = fieldsOf(h.post.mock.calls[0][1]);
    const claims = verifyProductToolToken(fields.products_token);
    expect(h.takeForTurn).toHaveBeenCalledWith(USER, claims.turn, expect.any(Date), 'web');
  });

  it('карточка уходит клиенту и в историю даже при обрыве апстрима', async () => {
    const h = makeHarness({ deltas: ['Завожу бота.'], takenActions: [{ id: ACTION_ID }], afterEvents: 'error' });
    await h.run(CARDS_UI);

    expect(items(h.written).some((c) => c.includes(SERVER_BLOCK))).toBe(true);
    expect(persistedAiText(h.pgCalls)).toContain(SERVER_BLOCK);
  });

  it('модельный блок, разрезанный по чанкам, вырезается и в catch-ветке', async () => {
    const h = makeHarness({
      deltas: [
        'Завожу бота.\n\n```product-action\n{"id":"',
        FAKE_ID,
        '"}\n```',
      ],
      takenActions: [{ id: ACTION_ID }],
      afterEvents: 'error',
    });
    await h.run(CARDS_UI);

    const saved = persistedAiText(h.pgCalls);
    expect(saved).toContain(SERVER_BLOCK);
    expect(saved).not.toContain(FAKE_ID);
    expect((String(saved).match(/```product-action/g) ?? []).length).toBe(1);
  });

  it('ход без инструмента продуктов — обрыв ведёт себя как раньше, ошибка без карточки', async () => {
    const h = makeHarness({ deltas: ['частичный текст'], takenActions: [], afterEvents: 'error' });
    await h.run(CARDS_UI);

    const end = endOf(h.written)!;
    expect(end.content).toBe('Ошибка запуска агента. Попробуйте ещё раз.');
    expect(end.content).not.toContain('```product-action');
  });
});
