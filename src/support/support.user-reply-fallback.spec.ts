jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
  sendTelegramPayload: jest.fn(async () => {}),
}));

import { sendTelegramAlert } from '../common/telegram-alert';
import { SupportService } from './support.service';

describe('ответ пользователя в тикете без своего чата поддержки', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; (sendTelegramAlert as jest.Mock).mockClear(); });

  // `<` или `&` в имени или тексте заставили бы Telegram отвергнуть сообщение — и оно тихо пропало бы.
  it('имя и текст пользователя экранированы', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (/FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ name: '<Ки&ра>' }] };
        return { rows: [] };
      }),
    };
    const telegram = { notifyUserReply: jest.fn(async () => {}) };
    const svc = new SupportService(pg as any, telegram as any);
    await (svc as any).notifyOwnerOfUserReply('t-1', 'u1', 'a < b & c', 'escalated');
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(text).toContain('Клиент: &lt;Ки&amp;ра&gt;');
    expect(text).toContain('«a &lt; b &amp; c»');
  });
});
