import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Ход, который не выдал финального ответа.
 *
 * Разбор переписки 79088644408 (11.08.2026): три РАЗНЫЕ поломки выглядели
 * одинаково — текст обрывался на полуслове, без единого слова объяснения, и за
 * этот обрывок списывались токены. За неделю пользовательница 19 раз отправила
 * «?» в молчащий чат, а одним из таких «?» убила собственный ход, потому что
 * релей пре-эмптит предыдущий процесс сессии.
 *
 * Два бага в этом файле:
 *   1. пояснение релея бэкенд ВЫБРАСЫВАЛ — `result` игнорировался, если хоть
 *      одна delta уже ушла, то есть ровно в том случае, ради которого писался;
 *   2. оборванный ход тарифицировался как обычный (17 717 токенов за 209
 *      символов) и уезжал в телеметрию как {ok:true}.
 */

const delta = (text: string) => 'data: ' + JSON.stringify({ type: 'delta', text }) + '\n';
const notice = (text: string) => 'data: ' + JSON.stringify({ type: 'notice', text }) + '\n';
const done = (extra: Record<string, unknown> = {}) =>
  'data: ' + JSON.stringify({ type: 'done', costUsd: 0.5, ...extra }) + '\n';

/** Собирает сервис и отдаёт наружу всё, что он записал в БД. */
function makeService() {
  const calls: { sql: string; params: any[] }[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const tracked: { name: string; props: any }[] = [];
  const events = { track: jest.fn((name: string, p: any) => tracked.push({ name, props: p.props })) };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, null as any,
    null as any, null as any, language as any, undefined /* balanceCtx */,
    undefined, events as any, undefined,
  );
  return { svc, calls, tracked };
}

function startTurn(svc: ChatService, userId: string) {
  const upstream = new Readable({ read() {} });
  (axios.post as jest.Mock).mockResolvedValueOnce({ data: upstream });
  const written: string[] = [];
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { written.push(s); return true; }),
    end: jest.fn(),
  };
  const finished = (svc as any).streamUniversalAgent(
    userId, 'проверь жалобу', '10', '10', [], '', res, 'Алексей', '', '', undefined, false, undefined,
  );
  return { upstream, finished, written };
}

/** Даёт setImmediate-персисту добежать до конца. */
async function settle() {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

/**
 * Ответ ассистента, записанный в историю, и списанная за него сумма.
 *
 * Позиции берём с конца: у вставки ответа content и tokens_used — два последних
 * параметра, и это верно для обеих веток персиста (saveAssistantMessageRow,
 * когда сообщение пользователя уже лежит в базе, и saveChatHistory, когда пара
 * пишется целиком).
 */
function savedAnswer(calls: { sql: string; params: any[] }[]) {
  const rows = calls.filter((c) => /INSERT INTO custom_chat_history/.test(c.sql));
  const last = rows[rows.length - 1];
  if (!last) return undefined;
  return {
    content: String(last.params[last.params.length - 2]),
    tokens: Number(last.params[last.params.length - 1]),
  };
}
function billingRow(calls: { sql: string; params: any[] }[]) {
  return calls.find((c) => /token_consumption_tasks/.test(c.sql));
}

describe('ход без финального ответа', () => {
  afterEach(() => jest.clearAllMocks());

  it('пояснение платформы доходит до пользователя, даже когда текст уже шёл', async () => {
    // Главный баг: раньше `result` с этим текстом молча выбрасывался, потому что
    // chunks уже не пустой — и обрыв выглядел как тишина.
    const { svc, calls } = makeService();
    const t = startTurn(svc, 'u1');

    t.upstream.push(delta('Все точки вставки определены. Вношу группу А.'));
    t.upstream.push(notice('\n\n_(ответ прерван: вы отправили новое сообщение)_'));
    t.upstream.push(done({ failed: true, failReason: 'preempted' }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    const answer = savedAnswer(calls);
    expect(answer).toBeDefined();
    expect(answer!.content).toContain('Вношу группу А.');
    expect(answer!.content).toContain('ответ прерван');
  });

  it('за оборванный ход токены не списываются', async () => {
    const { svc, calls } = makeService();
    const t = startTurn(svc, 'u1');

    t.upstream.push(delta('частичный текст'));
    t.upstream.push(notice('_(связь с моделью прервалась)_'));
    t.upstream.push(done({ failed: true, failReason: 'transient_after_partial' }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    // Ни строки учёта, ни ненулевой цены в истории.
    expect(billingRow(calls)).toBeUndefined();
    expect(savedAnswer(calls)!.tokens).toBe(0);
  });

  it('нормальный ход по-прежнему тарифицируется — проверка ломается в обе стороны', async () => {
    // Без этого теста «не списывать» могло бы означать «не списывать никогда».
    const { svc, calls } = makeService();
    const t = startTurn(svc, 'u1');

    t.upstream.push(delta('полный, доведённый до конца ответ'));
    t.upstream.push(done({ failed: false }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    expect(billingRow(calls)).toBeDefined();
    expect(savedAnswer(calls)!.tokens).toBeGreaterThan(0);
  });

  it('оборванный ход не проходит в телеметрии как удачный', async () => {
    const { svc, tracked } = makeService();
    const t = startTurn(svc, 'u1');

    t.upstream.push(delta('огрызок'));
    t.upstream.push(done({ failed: true, failReason: 'max_turns' }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    const quality = tracked.find((e) => e.name === 'chat_quality');
    expect(quality).toBeDefined();
    expect(quality!.props.ok).toBe(false);
    expect(quality!.props.failed).toBe(true);
    expect(quality!.props.fail_reason).toBe('max_turns');
  });

  it('отказ CLI не показывается дословно и не тарифицируется', async () => {
    // Реальные строки из истории: 03.08 ×4 и 07.08 ×1, обе выданы как реплики
    // ассистента. Пользовательница переспросила «что это?».
    const { svc, calls } = makeService();
    const t = startTurn(svc, 'u1');

    t.upstream.push(delta("You've hit your session limit · resets 11:50am (UTC)"));
    t.upstream.push(done({ failed: false }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    const { content } = savedAnswer(calls)!;
    expect(content).not.toContain('session limit');
    expect(content).toContain('Токены за этот ход не списаны');
    expect(billingRow(calls)).toBeUndefined();
  });

  it('ответ, лишь ЦИТИРУЮЩИЙ ошибку, не считается отказом', async () => {
    // Порог по длине существует ровно ради этого случая.
    const { svc, calls } = makeService();
    const t = startTurn(svc, 'u1');

    const explanation =
      'Вы увидели надпись «You\'ve hit your session limit» — это служебное сообщение платформы, ' +
      'а не отказ по вашему делу. Оно означает, что модель временно упёрлась в ограничение по ' +
      'нагрузке. Ничего из вашей апелляционной жалобы при этом не потеряно: черновик сохранён, ' +
      'приложения на месте, расчёт пересобирать не нужно. Подождите несколько минут и повторите ' +
      'вопрос — я продолжу ровно с того места, где мы остановились, и доведу аудит до конца.';
    t.upstream.push(delta(explanation));
    t.upstream.push(done({ failed: false }));
    t.upstream.push(null);
    await t.finished;
    await settle();

    expect(savedAnswer(calls)!.content).toContain('апелляционной жалобы');
    expect(billingRow(calls)).toBeDefined();
  });
});

describe('реестр живых ходов', () => {
  afterEach(() => jest.clearAllMocks());

  it('пока ход идёт — виден по своей паре, у чужой пары его нет', async () => {
    // На этом держится индикатор «ассистент работает» после перезагрузки.
    const { svc } = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(delta('думаю'));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    expect(svc.getActiveTurn('u1', '10').active).toBe(true);
    expect(svc.getActiveTurn('u1', '12').active).toBe(false);
    expect(svc.getActiveTurn('u2', '10').active).toBe(false);
    expect(svc.getActiveTurn('u1', '10').startedMsAgo).toBeGreaterThanOrEqual(0);

    t.upstream.push(done());
    t.upstream.push(null);
    await t.finished;

    expect(svc.getActiveTurn('u1', '10').active).toBe(false);
  });

  it('оборванный upstream не оставляет вечно «идущий» ход', async () => {
    // Иначе индикатор висел бы у пользователя до перезапуска процесса.
    const { svc } = makeService();
    const t = startTurn(svc, 'u1');
    t.upstream.push(delta('думаю'));
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(svc.getActiveTurn('u1', '10').active).toBe(true);

    t.upstream.destroy(new Error('сеть оборвалась'));
    await t.finished;

    expect(svc.getActiveTurn('u1', '10').active).toBe(false);
  });
});
