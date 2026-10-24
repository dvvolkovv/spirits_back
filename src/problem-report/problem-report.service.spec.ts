jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
}));

import { Logger } from '@nestjs/common';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import {
  BAD_INPUT_SAY, failedSay, notConfiguredSay, ProblemReportService, rateLimitedSay, REPORTED_SAY, TOO_LONG_SAY,
} from './problem-report.service';

const sent = sendTelegramAlert as jest.Mock;
const configured = telegramConfigured as jest.Mock;
/** setImmediate срабатывает после всех микрозадач — отправка без ожидания успевает. */
const flush = () => new Promise((r) => setImmediate(r));
const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';
const MIN = 60_000;
const ENV = [
  'PROBLEM_REPORT_COOLDOWN_MIN', 'PROBLEM_REPORT_TOOL_HOURLY',
  'PROBLEM_REPORT_USER_HOURLY', 'PROBLEM_REPORT_USER_DAILY', 'PROBLEM_REPORT_GLOBAL_HOURLY', 'PROBLEM_REPORT_GLOBAL_DAILY',
];

const pgWith = (rows: any[] = [{ display_name: 'Кира', name: 'Кира' }]) => ({ query: jest.fn(async () => ({ rows })) });

let now = 0;
let clock: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
let logSpy: jest.SpyInstance;
beforeEach(() => {
  sent.mockReset();
  sent.mockImplementation(async () => {});
  configured.mockReset();
  configured.mockReturnValue(true);
  for (const k of ENV) delete process.env[k];
  now = Date.UTC(2026, 9, 24, 11, 12);
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
  warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  clock.mockRestore();
  warnSpy.mockRestore();
  logSpy.mockRestore();
});

const failure = (over: Partial<{ userId: string; assistantId: string | null; tool: string; error: string }> = {}) => ({
  userId: 'u1', assistantId: '22', tool: 'generate_video', error: KIRA_ERROR, ...over,
});

describe('reportToolFailure — путь А', () => {
  it('сбой Киры: сообщение в группу, ассистенту — supportNotified', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: true });
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    const [text, extra] = sent.mock.calls[0];
    expect(text).toContain('🛠 <code>Кира</code>: не получилось создать видео');
    expect(text).toContain('no longer available');
    expect(text).toContain('<code>u1</code>');
    expect(extra).toEqual({ disable_web_page_preview: true });
  });

  it('виноват не сервис — тишина и без supportNotified', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure({ error: 'insufficient_tokens' }))).toEqual({ supportNotified: false });
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('повтор в паузе — без сообщения, но команда в курсе', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ userId: 'u1' }));
    now += MIN;
    expect(svc.reportToolFailure(failure({ userId: 'u2' }))).toEqual({ supportNotified: true });
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('после паузы — новое сообщение со счётчиком повторов', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ userId: 'u1' }));
    now = t0 + MIN;
    svc.reportToolFailure(failure({ userId: 'u2' }));
    now = t0 + 5 * MIN;
    svc.reportToolFailure(failure({ userId: 'u2' }));
    now = t0 + 61 * MIN;
    svc.reportToolFailure(failure({ userId: 'u3' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][0]).toContain('С прошлого сообщения: ещё 2 раза у 1 пользователя');
  });

  it('пауза — из PROBLEM_REPORT_COOLDOWN_MIN', async () => {
    process.env.PROBLEM_REPORT_COOLDOWN_MIN = '5';
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now += 6 * MIN;
    svc.reportToolFailure(failure());
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('разные инструменты не склеиваются', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ tool: 'generate_video', error: 'boom' }));
    svc.reportToolFailure(failure({ tool: 'generate_image', error: 'boom' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
  });

  it('подписи старше суток забываются: после них нет «С прошлого сообщения»', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now = t0 + 30 * MIN;
    svc.reportToolFailure(failure());
    now = t0 + 25 * 60 * MIN;
    svc.reportToolFailure(failure());
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(sent.mock.calls[1][0]).not.toContain('С прошлого сообщения');
  });

  it('общий потолок: сверх PROBLEM_REPORT_TOOL_HOURLY — одно уведомление и только лог; через час снова', async () => {
    process.env.PROBLEM_REPORT_TOOL_HOURLY = '2';
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ tool: 'generate_image', error: 'boom' }));
    svc.reportToolFailure(failure({ tool: 'generate_video', error: 'boom' }));
    now = t0 + 30 * MIN;
    for (const tool of ['generate_speech', 'read_calendar']) {
      expect(svc.reportToolFailure(failure({ tool, error: 'boom' }))).toEqual({ supportNotified: true });
    }
    await flush();
    const texts = sent.mock.calls.map((c) => String(c[0]));
    expect(texts).toHaveLength(3); // два сбоя и одно уведомление
    expect(texts.filter((t) => t.includes('Слишком много разных сбоев'))).toHaveLength(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('сверх потолка'))).toHaveLength(2);
    // Окно потолка уже свободно (сообщения t0 старше часа), а пауза по generate_speech,
    // если бы подпись запомнили в t0+30, ещё шла бы (31 мин < 60) — и сбой молча склеился бы.
    now = t0 + 61 * MIN;
    svc.reportToolFailure(failure({ tool: 'generate_speech', error: 'boom' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(4);
    expect(String(sent.mock.calls[3][0])).toContain('не получилось озвучить текст');
    expect(String(sent.mock.calls[3][0])).not.toContain('С прошлого сообщения');
  });

  it('Telegram не настроен: supportNotified=false, в группу ничего, текст — в лог', async () => {
    configured.mockReturnValue(false);
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: false });
    await flush();
    expect(sent).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('не получилось создать видео');
  });

  it('хода нет — «Ассистент», в базу не ходим', async () => {
    const pg = pgWith();
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: null }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('🛠 <code>Ассистент</code>: не получилось создать видео');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('кастомный ассистент — имя из custom_agents', async () => {
    const pg = pgWith([{ name: 'Мой юрист' }]);
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: 'custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc' }));
    await flush();
    expect(pg.query.mock.calls[0][0]).toContain('custom_agents');
    expect(pg.query.mock.calls[0][1]).toEqual(['3f2b9c1e-1111-4a2b-9c3d-123456789abc']);
    expect(sent.mock.calls[0][0]).toContain('<code>Мой юрист</code>: не получилось');
  });

  it('база упала — «Ассистент», сообщение всё равно уходит', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure());
    await flush();
    expect(sent.mock.calls[0][0]).toContain('<code>Ассистент</code>: не получилось');
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('имя ассистента 22 не прочитано');
  });

  it('отправка упала — вызов не бросает', async () => {
    sent.mockRejectedValueOnce(new Error('telegram down'));
    const svc = new ProblemReportService(pgWith() as any);
    expect(() => svc.reportToolFailure(failure())).not.toThrow();
    await flush();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('огромные tool и userId не оседают в памяти: ключ короткий, пользователей не больше 1000', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ userId: 'u'.repeat(1_000_000) }));
    for (let i = 0; i < 1500; i++) svc.reportToolFailure(failure({ userId: `u${i}` }));
    const incidents: Map<string, any> = (svc as any).incidents;
    expect(incidents.size).toBe(1);
    const [key, inc] = [...incidents.entries()][0];
    expect(key.length).toBeLessThanOrEqual(40);
    expect(inc.users.size).toBe(1000);
    await flush();
    expect(String(sent.mock.calls[0][0])).toContain('<code>' + 'u'.repeat(63) + '…</code>');
  });

  it('незнакомые имена инструментов склеиваются в один сбой', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    for (let i = 0; i < 30; i++) svc.reportToolFailure(failure({ tool: `x${i}`, error: `unknown tool: x${i}` }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    expect((svc as any).incidents.size).toBe(1);
  });

  it('повтор известной подписи в паузе склеивается и при полном потолке — без уведомления', async () => {
    process.env.PROBLEM_REPORT_TOOL_HOURLY = '1';
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now += MIN;
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: true });
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('сверх потолка'))).toHaveLength(0);
  });

  it('забывание — по последнему повтору, а не по последнему сообщению', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure());
    now = t0 + 59 * MIN;
    svc.reportToolFailure(failure());
    now = t0 + 24 * 60 * MIN + 30 * MIN;
    svc.reportToolFailure(failure());
    await flush();
    expect(sent).toHaveBeenCalledTimes(2);
    expect(String(sent.mock.calls[1][0])).toContain('ещё 1 раз у 1 пользователя');
  });

  it('часы шагнули назад — потолок не держится лишний час', async () => {
    process.env.PROBLEM_REPORT_TOOL_HOURLY = '1';
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ tool: 'generate_image', error: 'boom' }));
    now = t0 - 10 * MIN;
    svc.reportToolFailure(failure({ tool: 'generate_video', error: 'boom' }));
    await flush();
    expect(sent.mock.calls.map((c) => String(c[0])).some((t) => t.includes('не получилось создать видео'))).toBe(true);
  });

  it('Postgres завис — вызов возвращается сразу, сообщение уходит с «Ассистент» после таймаута', async () => {
    const pg = { query: jest.fn(() => new Promise(() => {})) };
    const svc = new ProblemReportService(pg as any);
    svc.nameTimeoutMs = 20;
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: true });
    await flush();
    expect(sent).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(String(sent.mock.calls[0][0])).toContain('🛠 <code>Ассистент</code>: не получилось создать видео');
  });

  it('огромное имя инструмента — два разных незнакомых имени склеиваются в один сбой', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ tool: 'x'.repeat(1_000_000), error: 'unknown tool: xxx' }));
    svc.reportToolFailure(failure({ tool: 'y'.repeat(1_000_000), error: 'unknown tool: yyy' }));
    expect((svc as any).incidents.size).toBe(1);
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    expect(String(sent.mock.calls[0][0])).toContain('не получилось выполнить <code>' + 'x'.repeat(63) + '…</code>');
  });

  it('огромная ошибка с пробелами по краям — в сообщении короткая', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    svc.reportToolFailure(failure({ error: ' '.repeat(3_000_000) + 'boom' + ' '.repeat(3_000_000) }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
    const m = String(sent.mock.calls[0][0]).match(/Ошибка: <code>([\s\S]*?)<\/code>/);
    expect(m).not.toBeNull();
    expect(Array.from(m![1]).length).toBeLessThanOrEqual(300);
  });
});

const report = (over: Record<string, unknown> = {}) => ({
  userId: 'u1', channel: 'web' as const, assistantId: '22', assistantArg: 'Кира',
  kind: 'my_failure', summary: 'LibreOffice падает при конвертации', ...over,
});

describe('reportFromAssistant — путь Б', () => {
  it('сообщение уходит, ассистенту — что сказать', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: true, reported: true, say: REPORTED_SAY });
    await flush();
    expect(sent.mock.calls[0][0]).toBe(
      '🙋 <code>Кира</code>: у меня не работает\n«<code>LibreOffice падает при конвертации</code>»\nПользователь: <code>u1</code> · веб',
    );
  });

  it('жалоба пользователя из Telegram, хода нет — имя из аргумента, в базу не ходим', async () => {
    const pg = pgWith();
    const svc = new ProblemReportService(pg as any);
    await svc.reportFromAssistant(report({ channel: 'telegram', assistantId: null, assistantArg: 'Райя', kind: 'user_report', summary: 'не проходит оплата' }));
    await flush();
    expect(sent.mock.calls[0][0]).toBe(
      '🙋 <code>Райя</code> передаёт жалобу пользователя\n«<code>не проходит оплата</code>»\nПользователь: <code>u1</code> · Telegram',
    );
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('имя из хода главнее аргумента', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ assistantArg: 'Самозванец' }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('<code>Кира</code>: у меня не работает');
  });

  it('аргумент имени обрезается до 40, пустой — «Ассистент»', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: 'Б'.repeat(60) }));
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: '   ', userId: 'u2' }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain(`🙋 <code>${'Б'.repeat(39)}…</code>: у меня не работает`);
    expect(sent.mock.calls[1][0]).toContain('🙋 <code>Ассистент</code>: у меня не работает');
  });

  it('имя из хода — не дольше таймаута, потом имя из аргумента', async () => {
    const pg = { query: jest.fn(() => new Promise(() => {})) };
    const svc = new ProblemReportService(pg as any);
    svc.nameTimeoutMs = 20;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 80));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('🙋 <code>Кира</code>: у меня не работает');
  });

  it('bad_input: пустой summary или неизвестный kind — в группу ничего', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report({ summary: '  ' }))).toEqual({ ok: false, error: 'bad_input', say: BAD_INPUT_SAY });
    expect(await svc.reportFromAssistant(report({ kind: 'panic' }))).toEqual({ ok: false, error: 'bad_input', say: BAD_INPUT_SAY });
    await flush();
    expect(sent).not.toHaveBeenCalled();
  });

  it('пересказ длиннее 2000 символов — bad_input сразу, квота не тратится', async () => {
    process.env.PROBLEM_REPORT_USER_HOURLY = '1';
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report({ summary: 'x'.repeat(2001) }))).toEqual({ ok: false, error: 'bad_input', say: TOO_LONG_SAY });
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await flush();
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('Telegram не настроен: not_configured, текст — в лог, лимиты работают как на проде', async () => {
    configured.mockReturnValue(false);
    process.env.PROBLEM_REPORT_USER_HOURLY = '1';
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'not_configured', say: notConfiguredSay('web') });
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'rate_limited', say: rateLimitedSay('web') });
    await flush();
    expect(sent).not.toHaveBeenCalled();
    expect(logSpy.mock.calls.map((c) => String(c[0])).join('\n')).toContain('у меня не работает');
  });

  it('3 в час на пользователя: четвёртое — rate_limited; другой пользователь не задет; через час снова можно', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    for (let i = 0; i < 3; i++) expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'rate_limited', say: rateLimitedSay('web') });
    expect((await svc.reportFromAssistant(report({ userId: 'u2' }))).ok).toBe(true);
    now = t0 + 61 * MIN;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await flush();
    expect(sent).toHaveBeenCalledTimes(5);
  });

  it('сутки на пользователя — из PROBLEM_REPORT_USER_DAILY', async () => {
    process.env.PROBLEM_REPORT_USER_HOURLY = '100';
    process.env.PROBLEM_REPORT_USER_DAILY = '2';
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    expect((await svc.reportFromAssistant(report())).ok).toBe(false);
    now = t0 + 25 * 60 * MIN;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await flush();
  });

  it('общий лимит в сутки — из PROBLEM_REPORT_GLOBAL_DAILY', async () => {
    process.env.PROBLEM_REPORT_GLOBAL_DAILY = '2';
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report({ userId: 'u1' }))).ok).toBe(true);
    expect((await svc.reportFromAssistant(report({ userId: 'u2' }))).ok).toBe(true);
    expect(await svc.reportFromAssistant(report({ userId: 'u3' }))).toEqual({ ok: false, error: 'rate_limited', say: rateLimitedSay('web') });
    await flush();
  });

  it('общий лимит: отказ пишется в лог, в группу — одно уведомление; ключ и квота не тратятся', async () => {
    process.env.PROBLEM_REPORT_GLOBAL_DAILY = '2';
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ userId: 'u1' }));
    await svc.reportFromAssistant(report({ userId: 'u2' }));
    expect(await svc.reportFromAssistant(report({ userId: 'u3' }))).toEqual({ ok: false, error: 'rate_limited', say: rateLimitedSay('web') });
    await svc.reportFromAssistant(report({ userId: 'u4' }));
    await flush();
    const texts = sent.mock.calls.map((c) => String(c[0]));
    expect(texts.filter((t) => t.includes('Слишком много сообщений от ассистентов'))).toHaveLength(1);
    expect(warnSpy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('сверх лимита (global_day)'))).toHaveLength(2);
    expect((svc as any).userReports.has('u3')).toBe(false);
  });

  it('всплеск: не больше PROBLEM_REPORT_GLOBAL_HOURLY в час на всех', async () => {
    process.env.PROBLEM_REPORT_GLOBAL_HOURLY = '2';
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ userId: 'u1' }));
    await svc.reportFromAssistant(report({ userId: 'u2' }));
    expect((await svc.reportFromAssistant(report({ userId: 'u3' }))).error).toBe('rate_limited');
    await flush();
    expect(sent.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('Общий лимит за час исчерпан'))).toHaveLength(1);
    expect((await svc.reportFromAssistant(report({ userId: 'u4' }))).error).toBe('rate_limited');
    await flush();
    expect(sent.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('Общий лимит за час исчерпан'))).toHaveLength(1);
    now += 61 * MIN;
    expect((await svc.reportFromAssistant(report({ userId: 'u3' }))).ok).toBe(true);
    await flush();
  });

  it('Telegram-канал: при отказе — почта поддержки, а не вкладка', async () => {
    process.env.PROBLEM_REPORT_USER_HOURLY = '1';
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ channel: 'telegram', assistantId: null }));
    const r = await svc.reportFromAssistant(report({ channel: 'telegram', assistantId: null }));
    expect(r).toEqual({ ok: false, error: 'rate_limited', say: rateLimitedSay('telegram') });
    expect(r.say).toContain('support@linkeon.io');
    await flush();
  });

  it('внутренняя ошибка — failed, без обещания «передал»', async () => {
    configured.mockImplementation(() => { throw new Error('boom'); });
    const svc = new ProblemReportService(pgWith() as any);
    expect(await svc.reportFromAssistant(report())).toEqual({ ok: false, error: 'failed', say: failedSay('web') });
    await flush();
  });

  it('часы шагнули назад — квота не держится лишнее время', async () => {
    process.env.PROBLEM_REPORT_USER_HOURLY = '1';
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    now = t0 - 10 * MIN;
    expect((await svc.reportFromAssistant(report())).ok).toBe(true);
    await flush();
  });

  it('уборка: пользователь без свежих сообщений забывается', async () => {
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ userId: 'u1' }));
    now = t0 + 25 * 60 * MIN;
    await svc.reportFromAssistant(report({ userId: 'u2' }));
    expect((svc as any).userReports.has('u1')).toBe(false);
    await flush();
  });

  it('пересказ не строкой — bad_input; ровно 2000 символов — принимается', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    expect((await svc.reportFromAssistant(report({ summary: 42 }))).error).toBe('bad_input');
    expect((await svc.reportFromAssistant(report({ summary: 'x'.repeat(2000) }))).ok).toBe(true);
    await flush();
  });

  it('огромное или не строковое имя от модели — короткая копия или «Ассистент»', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: 'Я'.repeat(1_000_000) }));
    await svc.reportFromAssistant(report({ assistantId: null, assistantArg: { evil: true }, userId: 'u2' }));
    await flush();
    expect(String(sent.mock.calls[0][0])).toContain(`🙋 <code>${'Я'.repeat(39)}…</code>: у меня не работает`);
    expect(String(sent.mock.calls[1][0])).toContain('🙋 <code>Ассистент</code>: у меня не работает');
  });

  it('пустой вызов (null) — failed, а не исключение', async () => {
    const svc = new ProblemReportService(pgWith() as any);
    await expect(svc.reportFromAssistant(null as any)).resolves.toEqual({ ok: false, error: 'failed', say: failedSay('web') });
  });
});
