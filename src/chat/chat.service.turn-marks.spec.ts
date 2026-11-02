import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Учёт идущих ходов (activeTurns) — по нему кабинет решает «слать сразу или
 * копить» (GET /webhook/chat/active-turn). Находка 2ff1a026: сообщение посреди
 * длинного хода пре-эмптит его на релее, а finally прерванного хода стирал
 * отметку нового — следующее «?» снова пре-эмптило уже новый ход.
 */

const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any,
    null as any, null as any, language as any, undefined /* balanceCtx */,
    undefined, undefined, undefined,
  );
}

function startTurn(svc: ChatService, userId: string, message = 'привет') {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    userId, message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
  );
  return { upstream, done };
}

/**
 * Как startTurn, но с доступом к fresh/probe — позиции 12/13/18 в сигнатуре
 * streamUniversalAgent (userId, message, assistantId, agentId, history,
 * profileText, res, agentName, agentDescription, agentSystemPrompt, req,
 * fresh, freshSessionId, requestLang, clientTz, balanceBlock, agentCategory,
 * probe, ui, storeBuild). Та же пара '7'/'7', что и у startTurn — ключ
 * activeTurns совпадает.
 */
function startTurnOpts(
  svc: ChatService,
  userId: string,
  message: string,
  opts: { fresh?: boolean; freshSessionId?: string; probe?: boolean } = {},
) {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    userId, message, '7', '7', [], '', res, 'Роман', '', '', undefined,
    opts.fresh ?? false, opts.freshSessionId, undefined, undefined, undefined, undefined,
    opts.probe ?? false,
  );
  return { upstream, done };
}

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

/** Текст реплики, ушедшей в релей последним вызовом axios.post. */
function lastRelayMessage(): string {
  const calls = (axios.post as jest.Mock).mock.calls;
  const fd = calls[calls.length - 1][1];
  // form-data: поле message лежит в _streams строкой после заголовка поля.
  const parts: any[] = (fd as any)._streams || [];
  const idx = parts.findIndex((p) => typeof p === 'string' && /name="message"/.test(p));
  return String(parts[idx + 1] ?? '');
}

describe('метки идущих ходов', () => {
  afterEach(() => jest.clearAllMocks());

  it('прерванный ход не снимает отметку нового', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const second = startTurn(svc, 'u1', 'ещё раз');
    second.upstream.push(DELTA);
    await settle();

    // Релей убил первый процесс — его поток закрылся, ход дошёл до finally.
    first.upstream.push(null);
    await first.done;

    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    second.upstream.push(DONE);
    second.upstream.push(null);
    await second.done;
    expect(svc.getActiveTurn('u1', '7').active).toBe(false);
  });

  it('ход с вложениями виден в учёте и снимает только свою отметку', () => {
    const svc = makeService();
    const mark = svc.beginUploadTurn('u1', '7');
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const newer = svc.beginUploadTurn('u1', '7');
    expect(newer).not.toBe(mark);
    svc.endUploadTurn('u1', '7', mark);
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    svc.endUploadTurn('u1', '7', newer);
    expect(svc.getActiveTurn('u1', '7').active).toBe(false);
  });

  it('метки одной пары различаются, даже если ходы начались в одну миллисекунду', () => {
    const svc = makeService();
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const a = svc.beginUploadTurn('u1', '7');
      const b = svc.beginUploadTurn('u1', '7');
      expect(b).not.toBe(a);
    } finally {
      (Date.now as jest.Mock).mockRestore();
    }
  });
});

describe('строка о прерывании в реплике релея', () => {
  afterEach(() => jest.clearAllMocks());

  it('ход по паре уже идёт — в реплике есть строка о прерванном ходе', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();

    const second = startTurn(svc, 'u1', 'ты работаешь?');
    second.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('хода нет — строки нет', async () => {
    const svc = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });

  it('ход другого ассистента строку не включает', async () => {
    const svc = makeService();
    svc.beginUploadTurn('u1', '12');
    const t = startTurn(svc, 'u1');
    t.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });

  it('чистый лист (fresh) не получает строку, даже если по паре уже идёт обычный ход', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const second = startTurnOpts(svc, 'u1', 'привет', {
      fresh: true,
      freshSessionId: 'u1_7_fresh_1730000000000',
    });
    second.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('пинг мониторинга (probe) не получает строку, даже если по паре уже идёт ход', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    const second = startTurnOpts(svc, 'u1', 'привет', { probe: true });
    second.upstream.push(DELTA);
    await settle();

    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });
});
