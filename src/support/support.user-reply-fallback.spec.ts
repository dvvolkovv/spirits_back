jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { sendTelegramAlert } from '../common/telegram-alert';
import { SupportService } from './support.service';

// Одиночная половинка суррогатной пары — то, что оставляет slice посреди эмодзи.
const hasLoneSurrogate = (s: string) =>
  Array.from(s).some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
const EMOJI = String.fromCodePoint(0x1f600);

/** pg той же формы, что ожидает notifyOwnerOfUserReply: имя — строка, остальное — пусто. Запоминает все вызовы. */
function makePg(name = '<Ки&ра>') {
  const calls: Array<[string, any[] | undefined]> = [];
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      calls.push([sql, params]);
      if (/FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ name }] };
      return { rows: [] };
    }),
  };
  return { pg, calls };
}

describe('ответ пользователя в тикете без своего чата поддержки', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; (sendTelegramAlert as jest.Mock).mockClear(); });

  // `<` или `&` в имени или тексте заставили бы Telegram отвергнуть сообщение — и оно тихо пропало бы.
  it('имя и текст пользователя экранированы', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    const { pg } = makePg();
    const telegram = { notifyUserReply: jest.fn(async () => {}) };
    const svc = new SupportService(pg as any, telegram as any);
    await (svc as any).notifyOwnerOfUserReply('t-1', 'u1', 'a < b & c', 'escalated');
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(text).toContain('Клиент: &lt;Ки&amp;ра&gt;');
    expect(text).toContain('«a &lt; b &amp; c»');
    // Ссылка из ответа пользователя — без превью: Telegram не должен ходить по чужому адресу.
    expect((sendTelegramAlert as jest.Mock).mock.calls[0][1]).toEqual({ disable_web_page_preview: true });
  });

  it('длинный ответ режется по кодовым точкам — без половинки эмодзи', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    const { pg } = makePg();
    const telegram = { notifyUserReply: jest.fn(async () => {}) };
    const svc = new SupportService(pg as any, telegram as any);
    await (svc as any).notifyOwnerOfUserReply('t-1', 'u1', 'a'.repeat(299) + EMOJI + 'хвост', 'escalated');
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toContain('…»');
  });

  // Половинка суррогата в jsonb — Postgres отвергнет INSERT (ошибку глотает .catch вызывающего), и 30-секундная защита от повторов не сработает.
  it('превью в support_events — без половинки эмодзи', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    const { pg, calls } = makePg();
    const telegram = { notifyUserReply: jest.fn(async () => {}) };
    const svc = new SupportService(pg as any, telegram as any);
    await (svc as any).notifyOwnerOfUserReply('t-1', 'u1', 'a'.repeat(199) + EMOJI + 'хвост', 'escalated');
    const insertCall = calls.find(([sql]) => /INSERT INTO support_events/.test(sql));
    const insertParams = insertCall?.[1] ?? [];
    expect(hasLoneSurrogate(JSON.parse(insertParams[1]).preview)).toBe(false);
  });
});
