import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { relaySessionKey } from './relay-session';

jest.mock('axios');

/**
 * Два РАЗНЫХ учёта и зачем они разведены (ревью Б2 Step 6):
 *
 *  - activeTurns (`${userId}_${assistantId}` → метка) — для кабинета,
 *    GET /chat/active-turn. Занят весь ход, включая копирование файлов и
 *    персист ПОСЛЕ ответа (до ~60 с). Находка 2ff1a026: прерванный ход
 *    безусловно стирал отметку НОВОГО хода той же пары — чинится меткой
 *    (openTurn/closeTurn), это блок «метки идущих ходов» ниже.
 *
 *  - relayRunning (relaySid → метка) — живой ПРОЦЕСС на релее, который
 *    реально можно пре-эмптить. Занят только пока сам процесс жив: от
 *    callUpstreamOnce (и self-heal повтора) до конца потока, НЕ до конца
 *    копирования файлов. INTERRUPTED_TURN_NOTE проверяется ИМЕННО по этой
 *    карте — старая проверка по activeTurns (+ !fresh) ловила три ложных
 *    случая: (а) релей уже прислал done, бэк ещё копирует файлы — процесса
 *    нет, а строка была; (б) идёт «чистый лист», приходит обычное
 *    сообщение той же пары — разные сессии релея, прерывания нет, а строка
 *    была (!fresh защищал только входящую сторону); (в) разные языковые
 *    ключи сессии. Это блок «строка о прерывании в реплике релея» ниже.
 */

const DELTA = 'data: ' + JSON.stringify({ type: 'delta', text: 'ответ' }) + '\n';
const DONE = 'data: ' + JSON.stringify({ type: 'done', costUsd: 0.1 }) + '\n';
/** done с файлом — чтобы включалась копия в хранилище (flushFileLinks) после потока. */
const DONE_WITH_FILE = 'data: ' + JSON.stringify({
  type: 'done', costUsd: 0.1, outputFiles: [{ name: 'x.pdf', url: '/files/u1_7_ru/x.pdf' }],
}) + '\n';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  // hint || 'ru': по умолчанию 'ru', как раньше, но тест про разные языковые
  // ключи сессии может попросить конкретный язык через requestLang.
  const language = { resolveUserLanguage: jest.fn(async (_uid: string, hint?: string) => hint || 'ru') };
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
 * Как startTurn, но с доступом к fresh/probe/requestLang — позиции
 * 12/13/14/18 в сигнатуре streamUniversalAgent (userId, message,
 * assistantId, agentId, history, profileText, res, agentName,
 * agentDescription, agentSystemPrompt, req, fresh, freshSessionId,
 * requestLang, clientTz, balanceBlock, agentCategory, probe, ui,
 * storeBuild). Та же пара '7'/'7', что и у startTurn.
 */
function startTurnOpts(
  svc: ChatService,
  userId: string,
  message: string,
  opts: { fresh?: boolean; freshSessionId?: string; probe?: boolean; requestLang?: string } = {},
) {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const res: any = { status: jest.fn(), setHeader: jest.fn(), write: jest.fn(() => true), end: jest.fn() };
  const done = (svc as any).streamUniversalAgent(
    userId, message, '7', '7', [], '', res, 'Роман', '', '', undefined,
    opts.fresh ?? false, opts.freshSessionId, opts.requestLang, undefined, undefined, undefined,
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
  // resetAllMocks, а не clearAllMocks: иначе неизрасходованный
  // mockResolvedValueOnce (например, из хода, срезанного dupKey-дедупом)
  // утекает в следующий тест и подсовывает ему чужой upstream — находка
  // ревью Б2 Step 5 (fix 7c6f3e20).
  afterEach(() => jest.resetAllMocks());

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
  afterEach(() => jest.resetAllMocks());

  it('ход по паре уже идёт — в реплике есть строка о прерванном ходе', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();

    const second = startTurn(svc, 'u1', 'ты работаешь?');
    second.upstream.push(DELTA);
    await settle();

    // Проверяем не только отсутствие ложного негатива, но и что это ДЕЙСТВИТЕЛЬНО
    // реплика второго хода: оба вызова реально дошли до axios.post (не дедуп),
    // и в ней есть собственный текст second.
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('ты работаешь?');
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

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(lastRelayMessage()).toContain('привет');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });

  it('другая сессия релея (другой ассистент) строку не включает', async () => {
    const svc = makeService();
    // Имитирует идущий процесс релея ДРУГОГО ассистента той же пары —
    // beginRelayRun, а не beginUploadTurn: тут проверяется изоляция по
    // relaySid (ключ интересующей нас карты relayRunning), а не activeTurns.
    const otherSid = relaySessionKey('u1', '12', 'ru');
    const mark = svc.beginRelayRun(otherSid);
    try {
      const t = startTurn(svc, 'u1');
      t.upstream.push(DELTA);
      await settle();

      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(lastRelayMessage()).toContain('привет');
      expect(lastRelayMessage()).not.toContain('тот ход прерван');

      t.upstream.push(DONE);
      t.upstream.push(null);
      await t.done;
    } finally {
      svc.endRelayRun(otherSid, mark);
    }
  });

  it('во время копирования файлов после done — строки нет: процесс релея уже не живёт', async () => {
    // Находка (а) ревью Б2 Step 6: релей прислал done и закрыл поток, но
    // копия файла в хранилище (chat-files) может идти ещё секунды-десятки
    // секунд — всё это время никакого процесса на релее уже нет, и чужое
    // сообщение той же сессии не должно получать «тот ход прерван».
    const svc = makeService();
    let resolveCopy!: (lines: string[]) => void;
    jest.spyOn(svc, 'storeRelayLinks').mockImplementation(
      () => new Promise<string[]>((resolve) => { resolveCopy = resolve; }),
    );

    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    first.upstream.push(DONE_WITH_FILE);
    first.upstream.push(null);
    await settle();
    // Поток first уже закончился (его relaySid снят из relayRunning), но
    // first.done ещё не резолвился — копия файла висит на storeRelayLinks.

    const second = startTurn(svc, 'u1', 'ещё раз');
    second.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('ещё раз');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    resolveCopy(['https://pub/x.pdf']);
    await first.done;
    second.upstream.push(DONE);
    second.upstream.push(null);
    await second.done;
  });

  it('идёт ход в «чистом листе» — обычное сообщение той же пары строки не получает', async () => {
    // Находка (б) ревью Б2 Step 6: «чистый лист» и обычный ход одной пары —
    // РАЗНЫЕ relaySid (freshSessionId входит в ключ), чужой процесс они не
    // пре-эмптят, и старая проверка (!fresh, но по activeTurns) это путала.
    const svc = makeService();
    const first = startTurnOpts(svc, 'u1', 'привет', {
      fresh: true,
      freshSessionId: 'u1_7_fresh_1730000000000',
    });
    first.upstream.push(DELTA);
    await settle();

    const second = startTurn(svc, 'u1', 'обычное сообщение');
    second.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('обычное сообщение');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(DONE);
    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('идёт обычный ход — сообщение «чистого листа» той же пары строки не получает', async () => {
    const svc = makeService();
    const first = startTurn(svc, 'u1');
    first.upstream.push(DELTA);
    await settle();
    expect(svc.getActiveTurn('u1', '7').active).toBe(true);

    // Сообщение другое, не 'привет': совпадающий с first текст попал бы под
    // dupKey-дедуп (userId+assistantId+message) и короткий путь «отвечаю на
    // дубликат» молча вернул бы заготовленный текст без единого вызова
    // axios.post — проверка стала бы пустой (находка ревью Б2 Step 5).
    const second = startTurnOpts(svc, 'u1', 'начни заново', {
      fresh: true,
      freshSessionId: 'u1_7_fresh_1730000000000',
    });
    second.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('начни заново');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('разные языковые ключи сессии у одной пары — строки нет', async () => {
    // Находка (в) ревью Б2 Step 6: смена языка — другая relaySid
    // (relaySessionKey включает userLanguage), другая сессия на релее.
    const svc = makeService();
    const first = startTurnOpts(svc, 'u1', 'hello', { requestLang: 'en' });
    first.upstream.push(DELTA);
    await settle();

    const second = startTurnOpts(svc, 'u1', 'привет снова', { requestLang: 'ru' });
    second.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('привет снова');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(DONE);
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

    // Сообщение другое, не 'привет' (см. комментарий в тесте про «чистый
    // лист» выше) — иначе dupKey-дедуп вернул бы заготовленный текст без
    // вызова axios.post.
    const second = startTurnOpts(svc, 'u1', 'пинг', { probe: true });
    second.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(lastRelayMessage()).toContain('пинг');
    expect(lastRelayMessage()).not.toContain('тот ход прерван');

    first.upstream.push(null);
    second.upstream.push(DONE);
    second.upstream.push(null);
    await Promise.all([first.done, second.done]);
  });

  it('upload-ход (тот же relaySid) тоже делает строку у текстового хода', async () => {
    // beginRelayRun имитирует идущую загрузку файла той же сессии
    // (ChatController.uploadAndChat зовёт его с handoff.sessionId — тем же
    // relaySid, что посчитает и текстовый ход).
    const svc = makeService();
    const sid = relaySessionKey('u1', '7', 'ru');
    const mark = svc.beginRelayRun(sid);

    const t = startTurn(svc, 'u1', 'что там с файлом?');
    t.upstream.push(DELTA);
    await settle();

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(lastRelayMessage()).toContain('что там с файлом?');
    expect(lastRelayMessage()).toContain('тот ход прерван');

    svc.endRelayRun(sid, mark);
    t.upstream.push(DONE);
    t.upstream.push(null);
    await t.done;
  });
});
