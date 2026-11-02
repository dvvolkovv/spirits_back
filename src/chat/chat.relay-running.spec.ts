import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

/**
 * relayRunning (relaySid → метка, см. комментарий у объявления в chat.service.ts)
 * на всех исходах, которыми реально занимается запрос к релею — довесок к
 * chat.service.turn-marks.spec.ts, а не дубль.
 *
 * Там beginRelayRun/endRelayRun дёргаются НАПРЯМУЮ — проверяются сами
 * примитивы (метка открыта/снята, изоляция по relaySid). Здесь — та же карта,
 * но через настоящую проводку: ход с вложениями идёт через
 * ChatController.uploadAndChat (а не прямой вызов beginRelayRun за него), а
 * «идёт ход» у текстового хода — через настоящий self-heal повтор (а не
 * имитацию занятой сессии). Проводка могла быть сломана и при исправных
 * примитивах — например, забыт вызов beginRelayRun в одном из двух мест,
 * которые его зовут.
 */

const NOTE = 'тот ход прерван';
const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';
/** done с файлом — включает копию в хранилище (flushFileLinks) после потока. */
const DONE_WITH_FILE = 'data: ' + JSON.stringify({
  type: 'done', costUsd: 0.1, outputFiles: [{ name: 'x.pdf', url: '/files/u1_7_ru/x.pdf' }],
}) + '\n';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      // ai_profiles_consolidated — шлагбаум баланса в ChatController.uploadAndChat:
      // этот путь, в отличие от streamUniversalAgent ниже, вызывается не в
      // обход streamChat, и собственный шлагбаум у него не пропустить ходом
      // приветствия.
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
}

/** Как makeService, но отдаёт и pg — чтобы проверить, что реально ушло в историю (T4). */
function makeServiceWithPgCalls() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
  return { svc, calls };
}

const queue: (Readable | Error)[] = [];
const post = jest.fn(async (..._args: any[]) => {
  const next = queue.shift();
  if (!next) throw new Error('апстрим для этого вызова не подготовлен тестом');
  if (next instanceof Error) throw next;
  return { data: next };
});

beforeEach(() => {
  queue.length = 0;
  post.mockClear();
  (axios as any).default = { post };
  (axios as any).post = post;
});
afterEach(() => jest.useRealTimers());

/** Значение поля multipart-формы, которой ушёл вызов axios.post под номером call. */
function field(call: any[], name: string): string {
  const parts: any[] = (call[1] as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && new RegExp(`name="${name}"`).test(p));
  return String(parts[idx + 1] ?? '');
}
const msg = (i: number) => field(post.mock.calls[i], 'message');
const sid = (i: number) => field(post.mock.calls[i], 'sessionId');

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

function textTurn(svc: ChatService, message: string) {
  const up = new Readable({ read() {} });
  queue.push(up);
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    'u1', message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  return { up, done };
}

function uploadTurn(svc: ChatService, upstream: Readable | Error) {
  queue.push(upstream);
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined);
  const req = {
    headers: { authorization: 'Bearer t' },
    files: [{ originalname: 'a.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message: 'смотри файл', assistantId: '7' },
  } as any;
  const res: any = {
    status: jest.fn().mockReturnThis(), setHeader: jest.fn(), write: jest.fn(() => true),
    end: jest.fn(), json: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis(),
  };
  return ctrl.uploadAndChat(req, res);
}

describe('relayRunning на настоящей проводке (upload-контроллер, self-heal повтор)', () => {
  it('U1: идёт поток загрузки — текстовый ход той же сессии получает строку (тот же sessionId)', async () => {
    const svc = makeService();
    const up = new Readable({ read() {} });
    const u = uploadTurn(svc, up);
    await settle();
    up.push(DELTA);
    await settle();

    const t = textTurn(svc, 'ты тут?');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(sid(1)).toBe(sid(0));
    expect(msg(1)).toContain('ты тут?');
    expect(msg(1)).toContain(NOTE);

    up.push(DONE); up.push(null);
    t.up.push(DONE); t.up.push(null);
    await Promise.all([u, t.done]);
  });

  it('U2: поток загрузки кончился, идёт копия файлов — строки нет', async () => {
    const svc = makeService();
    let resolveCopy!: (l: string[]) => void;
    jest.spyOn(svc, 'storeRelayLinks').mockImplementation(
      () => new Promise<string[]>((r) => { resolveCopy = r; }),
    );
    const up = new Readable({ read() {} });
    const u = uploadTurn(svc, up);
    await settle();
    up.push(DELTA); up.push(DONE_WITH_FILE); up.push(null);
    await settle();
    expect(typeof resolveCopy).toBe('function');

    const t = textTurn(svc, 'а теперь?');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(msg(1)).toContain('а теперь?');
    expect(msg(1)).not.toContain(NOTE);

    resolveCopy(['https://pub/x.pdf']);
    t.up.push(DONE); t.up.push(null);
    await Promise.all([u, t.done]);
  });

  it('U3: релей отклонил запрос загрузки (post reject) — метка снята', async () => {
    const svc = makeService();
    await uploadTurn(svc, new Error('ECONNRESET'));
    await settle();
    const t = textTurn(svc, 'повтори');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(msg(1)).not.toContain(NOTE);
    t.up.push(DONE); t.up.push(null);
    await t.done;
  });

  it('T1: первый запрос текстового хода отклонён релеем — метка снята, следующий без строки', async () => {
    const svc = makeService();
    queue.push(new Error('ECONNRESET'));
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    await (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await settle();
    const t = textTurn(svc, 'ещё раз');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(msg(1)).toContain('ещё раз');
    expect(msg(1)).not.toContain(NOTE);
    t.up.push(DONE); t.up.push(null);
    await t.done;
  });

  it('T2: пустой первый поток — self-heal повторяет; сам повтор без строки, новый ход во время повтора — со строкой', async () => {
    // Фейковый таймер вместо реального ожидания паузы self-heal (800 мс):
    // setImmediate/nextTick остаются настоящими, чтобы settle() ниже и дальше
    // домётывал цепочки промисов между вызовом axios.post и обработчиками
    // потока (тот же приём, что в chat.service.masha-products.spec.ts). Нужно
    // включить ДО старта хода: пауза создаётся глубоко внутри
    // streamUniversalAgent, и настоящий setTimeout, поставленный раньше
    // переключения на фейковый таймер, фейковым временем не возьмётся.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

    const svc = makeService();
    const empty = new Readable({ read() {} });
    const retry = new Readable({ read() {} });
    queue.push(empty, retry);
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    const first = (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await settle();
    empty.push(null); // пустой поток закрылся без единого delta — self-heal ждёт 800мс и повторяет
    await settle();

    jest.advanceTimersByTime(800);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);
    expect(msg(1)).toBe(msg(0));
    expect(msg(1)).not.toContain(NOTE);

    const t = textTurn(svc, 'ты тут?');
    t.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(3);
    expect(msg(2)).toContain(NOTE);

    retry.push(DELTA); retry.push(DONE); retry.push(null);
    t.up.push(DONE); t.up.push(null);
    await Promise.all([first, t.done]);
  });

  it('T3: во время паузы self-heal сессию перехватил настоящий новый ход — повтор не запускается', async () => {
    // Иначе повтор A, уйдя в ту же relaySid, конкурировал бы на релее с
    // процессом B и мог бы убить именно его (находка: self-heal должен
    // уступать живому ходу, а не бодаться с ним за сессию).
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

    const svc = makeService();
    const empty = new Readable({ read() {} });
    queue.push(empty);
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    const first = (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await settle();
    empty.push(null); // пустой поток — A готовится повторить через 800мс
    await settle();

    // Пока A ждёт паузу, по той же сессии реально стартует B — его
    // beginRelayRun (внутри своего streamUniversalAgent) переписывает
    // relayRunning поверх метки A.
    const second = textTurn(svc, 'новый ход');
    second.up.push(DELTA);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);

    // A просыпается от паузы — сессия уже не его, повтора быть не должно.
    jest.advanceTimersByTime(800);
    await settle();
    expect(post).toHaveBeenCalledTimes(2);

    second.up.push(DONE); second.up.push(null);
    await Promise.all([first, second.done]);
  });

  it('T4: повтор self-heal пропущен из-за перехвата — заглушка «Ответ не пришёл» в историю не уходит', async () => {
    // Иначе в истории у A осталась бы ложная подсказка «попробуйте отправить
    // ещё раз», хотя пробовать уже не нужно — на это же сообщение (B) уже
    // отвечает другой, более новый ход той же сессии.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });

    const { svc, calls } = makeServiceWithPgCalls();
    const empty = new Readable({ read() {} });
    queue.push(empty);
    const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
    const first = (svc as any).streamUniversalAgent(
      'u1', 'привет', '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    await settle();
    empty.push(null); // пустой поток — A готовится повторить через 800мс
    await settle();

    // B перехватывает сессию во время паузы — ровно как в T3.
    const second = textTurn(svc, 'новый ход');
    second.up.push(DELTA);
    await settle();

    jest.advanceTimersByTime(800);
    await settle();

    second.up.push(DONE); second.up.push(null);
    await Promise.all([first, second.done]);
    // persistResponse(true) для A уходит через setImmediate уже после того,
    // как сам стрим A завершился — даём ему время дойти до записи в pg.
    await settle();

    const stubSaved = calls.some((c) =>
      c.params.some((p: any) => typeof p === 'string' && p.includes('Ответ не пришёл')));
    expect(stubSaved).toBe(false);
  });
});
