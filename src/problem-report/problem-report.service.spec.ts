jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
}));

import { Logger } from '@nestjs/common';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';
import { ProblemReportService } from './problem-report.service';

const sent = sendTelegramAlert as jest.Mock;
const configured = telegramConfigured as jest.Mock;
/** setImmediate срабатывает после всех микрозадач — отправка без ожидания успевает. */
const flush = () => new Promise((r) => setImmediate(r));
const KIRA_ERROR = 'Veo generate failed: This model models/veo-3.1-fast-generate-preview is no longer available.';
const MIN = 60_000;
const ENV = [
  'PROBLEM_REPORT_COOLDOWN_MIN', 'PROBLEM_REPORT_TOOL_HOURLY',
  'PROBLEM_REPORT_USER_HOURLY', 'PROBLEM_REPORT_USER_DAILY', 'PROBLEM_REPORT_GLOBAL_DAILY',
];

const pgWith = (rows: any[] = [{ display_name: 'Кира', name: 'Кира' }]) => ({ query: jest.fn(async () => ({ rows })) });

let now = 0;
let clock: jest.SpyInstance;
beforeEach(() => {
  sent.mockReset();
  sent.mockImplementation(async () => {});
  configured.mockReset();
  configured.mockReturnValue(true);
  for (const k of ENV) delete process.env[k];
  now = Date.UTC(2026, 9, 24, 11, 12);
  clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => clock.mockRestore());

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
    expect(text).toContain('🛠 <b>Кира: не получилось создать видео</b>');
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
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const t0 = now;
    const svc = new ProblemReportService(pgWith() as any);
    for (const tool of ['generate_image', 'generate_video', 'generate_speech', 'read_calendar']) {
      expect(svc.reportToolFailure(failure({ tool, error: 'boom' }))).toEqual({ supportNotified: true });
    }
    await flush();
    const texts = sent.mock.calls.map((c) => String(c[0]));
    expect(texts).toHaveLength(3); // два сбоя и одно уведомление
    expect(texts.filter((t) => t.includes('Слишком много разных сбоев'))).toHaveLength(1);
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('сверх потолка'))).toHaveLength(2);
    now = t0 + 61 * MIN;
    svc.reportToolFailure(failure({ tool: 'generate_speech', error: 'boom' }));
    await flush();
    expect(sent).toHaveBeenCalledTimes(4);
    expect(String(sent.mock.calls[3][0])).not.toContain('С прошлого сообщения');
    warn.mockRestore();
  });

  it('Telegram не настроен: supportNotified=false, в группу ничего, текст — в лог', async () => {
    configured.mockReturnValue(false);
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const svc = new ProblemReportService(pgWith() as any);
    expect(svc.reportToolFailure(failure())).toEqual({ supportNotified: false });
    await flush();
    expect(sent).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('не получилось создать видео');
    log.mockRestore();
  });

  it('хода нет — «Ассистент», в базу не ходим', async () => {
    const pg = pgWith();
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: null }));
    await flush();
    expect(sent.mock.calls[0][0]).toContain('🛠 <b>Ассистент: не получилось создать видео</b>');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('кастомный ассистент — имя из custom_agents', async () => {
    const pg = pgWith([{ name: 'Мой юрист' }]);
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure({ assistantId: 'custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc' }));
    await flush();
    expect(pg.query.mock.calls[0][0]).toContain('custom_agents');
    expect(pg.query.mock.calls[0][1]).toEqual(['3f2b9c1e-1111-4a2b-9c3d-123456789abc']);
    expect(sent.mock.calls[0][0]).toContain('Мой юрист: не получилось');
  });

  it('база упала — «Ассистент», сообщение всё равно уходит', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const svc = new ProblemReportService(pg as any);
    svc.reportToolFailure(failure());
    await flush();
    expect(sent.mock.calls[0][0]).toContain('Ассистент: не получилось');
  });

  it('отправка упала — вызов не бросает', async () => {
    sent.mockRejectedValueOnce(new Error('telegram down'));
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const svc = new ProblemReportService(pgWith() as any);
    expect(() => svc.reportToolFailure(failure())).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
