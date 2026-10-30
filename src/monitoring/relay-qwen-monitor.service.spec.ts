jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => undefined) }));
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { RelayQwenMonitorService, relayFallbackAlertText, relayFallbackVerdict } from './relay-qwen-monitor.service';

const get = (axios as any).get as jest.Mock;
const send = sendTelegramPayload as unknown as jest.Mock;
const NOW = 10_000_000;
const q = (o: any) => ({ status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, ...o } });

describe('relayFallbackVerdict', () => {
  it('старый релей или нет ответа — unknown', () => {
    expect(relayFallbackVerdict({ status: 'ok' }, NOW)).toBe('unknown');
    expect(relayFallbackVerdict(null, NOW)).toBe('unknown');
  });
  it('окно открыто — active', () => expect(relayFallbackVerdict(q({ breakerOpenUntil: NOW + 1 }), NOW)).toBe('active'));
  it('были аварийные ходы за окно — active', () => expect(relayFallbackVerdict(q({ ok: 2 }), NOW)).toBe('active'));
  it('только ошибки Qwen (ok 0, failed 2) — active', () => expect(relayFallbackVerdict(q({ ok: 0, failed: 2 }), NOW)).toBe('active'));
  it('тихо — idle', () => expect(relayFallbackVerdict(q({}), NOW)).toBe('idle'));

  // Окно предохранителя на релее закрывается сам через breakerMs (5 мин), и
  // это не зависит от того, ответил ли Claude хоть раз. Монитор на бэкенде
  // не должен сравнивать breakerOpenUntil со своими часами (релей сам его
  // обнулит) — должен сравнивать Claude ответил/не ответил.
  it('окно истекло само, ходов на Qwen нет, но Claude после сбоя ни разу не ответил — active (без ложного отбоя)', () => {
    const health = q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 });
    expect(relayFallbackVerdict(health, NOW)).toBe('active');
  });
  it('Claude ответил после последнего открытия окна — idle', () => {
    const health = q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: NOW - 500_000 });
    expect(relayFallbackVerdict(health, NOW)).toBe('idle');
  });
  // Брейкер в памяти релея пустой и сразу после рестарта процесса — тот же
  // набор нулей, что у «окно никогда не открывалось, всё тихо». Отличить их
  // нельзя, значит нельзя и притворяться, что знаем: unknown, а не ложное
  // idle (которое после висящего алерта ушло бы отбоем «Claude снова
  // отвечает», хотя релей просто ещё не успел ничего узнать).
  it('рестарт релея (все поля нулевые, но lastClaudeOkAt присутствует) — unknown, не idle', () => {
    expect(relayFallbackVerdict(q({ lastOpenedAt: 0, lastClaudeOkAt: 0 }), NOW)).toBe('unknown');
  });
  it('старый релей без поля lastClaudeOkAt вовсе, нули — idle, как раньше', () => {
    const health = { status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0 } };
    expect(relayFallbackVerdict(health, NOW)).toBe('idle');
  });
});

describe('relayFallbackAlertText', () => {
  it('со счётчиками и минутами окна, без буквальных обратных кавычек в HTML (Telegram их не раскрывает)', () => {
    const t = relayFallbackAlertText(q({ ok: 5, failed: 1 }).qwen);
    expect(t).toContain('ответов 5, ошибок 1');
    expect(t).toContain('за 15 мин');
    expect(t).toContain('<code>claude</code>');
    expect(t).not.toContain('`');
  });

  // ok === 0 && failed > 0: Qwen сам не отвечает — «отвечают через Qwen» было
  // бы неверно, людям нужно знать, что молчат оба пути.
  it('ok: 0, failed > 0 — текст про отказ обоих путей', () => {
    const t = relayFallbackAlertText(q({ ok: 0, failed: 2 }).qwen);
    expect(t).toContain('Claude недоступен, запасной Qwen тоже не отвечает');
    expect(t).not.toContain('отвечают через запасной Qwen');
    expect(t).toContain('<code>claude</code>');
  });

  // Активность определена только третьим условием verdict'а (Claude не
  // отвечал с момента сбоя) — ok и failed нулевые, окно само закрылось:
  // ни одного хода не ушло ни на Claude, ни на Qwen, «ответов 0, ошибок 0»
  // было бы бессмысленным шумом.
  it('активность только по «Claude не отвечал с момента сбоя» (ok=0, failed=0, окно закрыто) — отдельный текст', () => {
    const t = relayFallbackAlertText(q({ ok: 0, failed: 0, breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 }).qwen);
    expect(t).toContain('Claude не отвечал с момента сбоя');
    expect(t).toContain('запасной Qwen за 15 мин не понадобился');
    expect(t).toContain('<code>claude</code>');
    expect(t).not.toContain('ответов');
  });
});

describe('RelayQwenMonitorService.check', () => {
  const OLD = { tok: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
  let alerted: boolean;
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (sql.startsWith('SELECT alerted')) return { rows: alerted ? [{ alerted: true }] : [] };
      alerted = params?.[1] === true;
      return { rows: [] };
    }),
  };
  beforeEach(() => {
    alerted = false; get.mockReset(); send.mockClear(); pg.query.mockClear();
    process.env.TELEGRAM_BOT_TOKEN = 't'; process.env.TELEGRAM_CHAT_ID = 'c';
  });
  afterAll(() => { process.env.TELEGRAM_BOT_TOKEN = OLD.tok; process.env.TELEGRAM_CHAT_ID = OLD.chat; });

  it('active впервые — алерт и отметка', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('active');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].text).toContain('Релей: Claude недоступен');
    expect(alerted).toBe(true);
  });
  it('active повторно — без повтора алерта', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    await new RelayQwenMonitorService(pg as any).check(NOW);
    expect(send).not.toHaveBeenCalled();
  });
  it('idle после алерта — отбой', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({}) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('idle');
    expect(send.mock.calls[0][0].text).toContain('Claude снова отвечает');
    expect(alerted).toBe(false);
  });
  it('рестарт релея (все нули, поле lastClaudeOkAt есть) при висящем алерте — unknown, без ложного отбоя', async () => {
    alerted = true;
    get.mockResolvedValue({ data: q({ lastOpenedAt: 0, lastClaudeOkAt: 0 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
    expect(alerted).toBe(true);
  });
  it('/health недоступен — ничего не шлёт', async () => {
    get.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
    expect(send).not.toHaveBeenCalled();
  });

  // test.linkeon.io: AGENT_URL там указывает на боевой релей — без выключателя
  // test дублировал бы алерты прода.
  it('RELAY_QWEN_MONITOR=off — unknown без чтения /health и БД', async () => {
    process.env.RELAY_QWEN_MONITOR = 'off';
    try {
      expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('unknown');
      expect(get).not.toHaveBeenCalled();
      expect(pg.query).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    } finally {
      delete process.env.RELAY_QWEN_MONITOR;
    }
  });

  it('сбой чтения monitor_alert_state (pg.query бросает) — считать не алертили, не падать', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    const brokenPg = { query: jest.fn(async () => { throw new Error('connection lost'); }) };
    await expect(new RelayQwenMonitorService(brokenPg as any).check(NOW)).resolves.toBe('active');
    // Не алертили (сбой чтения) → active трактуется как первый раз → шлёт.
    expect(send).toHaveBeenCalledTimes(1);
  });
});
