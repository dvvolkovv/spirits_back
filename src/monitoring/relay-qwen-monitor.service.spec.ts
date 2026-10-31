jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => undefined) }));
import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { RelayQwenMonitorService, readRelayFallback, relayFallbackAlertText, relayFallbackVerdict } from './relay-qwen-monitor.service';

const get = (axios as any).get as jest.Mock;
const send = sendTelegramPayload as unknown as jest.Mock;
const NOW = 10_000_000;
/** Релей до выката Kimi: только поле qwen. */
const q = (o: any) => ({ status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, ...o } });
/** Новый релей: поле fallback по всем запасным (и прежнее qwen рядом). */
const fb = (o: any = {}, qwen: any = {}, kimi: any = {}) => ({
  status: 'ok',
  fallback: {
    windowMs: 900000, breakerOpenUntil: 0, lastOpenedAt: 0, lastClaudeOkAt: 0, ...o,
    providers: {
      qwen: { enabled: true, ok: 0, failed: 0, downUntil: 0, ...qwen },
      kimi: { enabled: true, ok: 0, failed: 0, downUntil: 0, ...kimi },
    },
  },
  qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0, lastOpenedAt: 0, lastClaudeOkAt: 0 },
});
const text = (h: any) => relayFallbackAlertText(readRelayFallback(h)!);

describe('readRelayFallback', () => {
  it('новое поле fallback — оба запасных', () => {
    const r = readRelayFallback(fb({ lastOpenedAt: 5 }, { ok: 2 }, { failed: 1 }))!;
    expect(r.providers.qwen).toMatchObject({ enabled: true, ok: 2, failed: 0 });
    expect(r.providers.kimi).toMatchObject({ enabled: true, ok: 0, failed: 1 });
    expect(r.lastOpenedAt).toBe(5);
  });
  it('старый релей — только qwen', () => {
    const r = readRelayFallback(q({ ok: 3 }))!;
    expect(r.providers).toEqual({ qwen: { enabled: true, ok: 3, failed: 0 } });
    expect(r.lastClaudeOkAt).toBeUndefined();
  });
  it('fallback важнее прежнего qwen', () => {
    const h = { ...fb({}, {}, { ok: 4 }), qwen: { enabled: true, ok: 99, failed: 0, windowMs: 900000, breakerOpenUntil: 0 } };
    expect(readRelayFallback(h)!.providers.kimi!.ok).toBe(4);
    expect(readRelayFallback(h)!.providers.qwen!.ok).toBe(0);
  });
  it('нет ни того, ни другого — null', () => {
    expect(readRelayFallback({ status: 'ok' })).toBeNull();
    expect(readRelayFallback(null)).toBeNull();
  });
});

describe('relayFallbackVerdict', () => {
  it('старый релей без запасного пути или нет ответа — unknown', () => {
    expect(relayFallbackVerdict({ status: 'ok' }, NOW)).toBe('unknown');
    expect(relayFallbackVerdict(null, NOW)).toBe('unknown');
  });
  it('окно открыто — active', () => expect(relayFallbackVerdict(q({ breakerOpenUntil: NOW + 1 }), NOW)).toBe('active'));
  it('были аварийные ходы за окно — active', () => expect(relayFallbackVerdict(q({ ok: 2 }), NOW)).toBe('active'));
  it('только ошибки запасных — active', () => expect(relayFallbackVerdict(q({ ok: 0, failed: 2 }), NOW)).toBe('active'));
  it('тихо — idle', () => expect(relayFallbackVerdict(q({}), NOW)).toBe('idle'));
  it('окно истекло само, Claude после сбоя ни разу не ответил — active (без ложного отбоя)', () => {
    expect(relayFallbackVerdict(q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 }), NOW)).toBe('active');
  });
  it('Claude ответил после последнего открытия окна — idle', () => {
    expect(relayFallbackVerdict(q({ breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: NOW - 500_000 }), NOW)).toBe('idle');
  });
  it('рестарт релея (все нули, поле lastClaudeOkAt есть) — unknown, не idle', () => {
    expect(relayFallbackVerdict(q({ lastOpenedAt: 0, lastClaudeOkAt: 0 }), NOW)).toBe('unknown');
  });
  it('старый релей без поля lastClaudeOkAt вовсе, нули — idle, как раньше', () => {
    const health = { status: 'ok', qwen: { enabled: true, ok: 0, failed: 0, windowMs: 900000, breakerOpenUntil: 0 } };
    expect(relayFallbackVerdict(health, NOW)).toBe('idle');
  });
  it('новый релей: отвечал только Kimi — active', () => expect(relayFallbackVerdict(fb({}, {}, { ok: 1 }), NOW)).toBe('active'));
  it('новый релей: рестарт (всё по нулям) — unknown', () => expect(relayFallbackVerdict(fb(), NOW)).toBe('unknown'));
  it('новый релей: Claude ответил после сбоя — idle', () => {
    expect(relayFallbackVerdict(fb({ lastOpenedAt: NOW - 600_000, lastClaudeOkAt: NOW - 500_000 }), NOW)).toBe('idle');
  });
});

describe('relayFallbackAlertText', () => {
  it('счётчики по провайдерам и минуты окна; без обратных кавычек в HTML', () => {
    const t = text(fb({ breakerOpenUntil: NOW + 1 }, { failed: 2 }, { ok: 4 }));
    expect(t).toContain('ассистенты отвечают через запасные');
    expect(t).toContain('Qwen: ответов 0, ошибок 2 · Kimi: ответов 4, ошибок 0 за 15 мин');
    expect(t).toContain('<code>claude</code>');
    expect(t).not.toContain('`');
  });
  it('без ключа Kimi — «не настроен»', () => {
    expect(text(fb({}, { ok: 1 }, { enabled: false }))).toContain('Kimi: не настроен');
  });
  it('ответов ноль, ошибки есть — запасные тоже не отвечают', () => {
    const t = text(fb({}, { failed: 1 }, { failed: 2 }));
    expect(t).toContain('Claude недоступен, запасные тоже не отвечают');
    expect(t).not.toContain('отвечают через запасные');
  });
  it('старый релей — строка Qwen', () => {
    const t = text(q({ ok: 5, failed: 1 }));
    expect(t).toContain('Qwen: ответов 5, ошибок 1');
    expect(t).toContain('за 15 мин');
  });
  it('активность только по «Claude не отвечал с момента сбоя» — отдельный текст без счётчиков', () => {
    const t = text(q({ ok: 0, failed: 0, breakerOpenUntil: 0, lastOpenedAt: NOW - 600_000, lastClaudeOkAt: 0 }));
    expect(t).toContain('Claude не отвечал с момента сбоя');
    expect(t).toContain('запасные за 15 мин не понадобились');
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
  it('новый релей: active через Kimi — в алерте его счётчики', async () => {
    get.mockResolvedValue({ data: fb({}, {}, { ok: 3 }) });
    expect(await new RelayQwenMonitorService(pg as any).check(NOW)).toBe('active');
    expect(send.mock.calls[0][0].text).toContain('Kimi: ответов 3, ошибок 0');
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
    expect(send.mock.calls[0][0].text).toContain('Запасные за последние 15 мин не понадобились');
    expect(alerted).toBe(false);
  });
  it('рестарт релея при висящем алерте — unknown, без ложного отбоя', async () => {
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
  it('сбой чтения monitor_alert_state — считать не алертили, не падать', async () => {
    get.mockResolvedValue({ data: q({ ok: 3 }) });
    const brokenPg = { query: jest.fn(async () => { throw new Error('connection lost'); }) };
    await expect(new RelayQwenMonitorService(brokenPg as any).check(NOW)).resolves.toBe('active');
    expect(send).toHaveBeenCalledTimes(1);
  });
});
