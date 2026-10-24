jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({ sendTelegramPayload: jest.fn(async () => {}) }));

import axios from 'axios';
import { sendTelegramPayload } from '../common/telegram-alert';
import { TelegramNotifierService } from './telegram-notifier.service';

const post = axios.post as jest.Mock;
const fanout = sendTelegramPayload as jest.Mock;
const ESCALATION = {
  ticketId: 'e86dc43d-c45c-4583-9f97-1d11db821a1b',
  userId: 'u1',
  urgency: 'high',
  reason: 'не может пополнить токены',
  summary: 'проверка',
};

describe('эскалация ИИ-поддержки', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    post.mockReset();
    fanout.mockReset();
    process.env.TELEGRAM_BOT_TOKEN = 'token';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('без TELEGRAM_SUPPORT_CHAT_ID — фанаутом по TELEGRAM_CHAT_ID, с кнопкой тикета', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyEscalation(ESCALATION);
    expect(post).not.toHaveBeenCalled();
    expect(fanout).toHaveBeenCalledTimes(1);
    const payload = fanout.mock.calls[0][0];
    expect(payload.parse_mode).toBe('HTML');
    expect(payload.text).toContain('Escalation');
    expect(payload.text).toContain('#e86dc43d');
    expect(payload.reply_markup.inline_keyboard[0][0].url).toContain('ticket=e86dc43d-c45c-4583-9f97-1d11db821a1b');
  });

  it('с TELEGRAM_SUPPORT_CHAT_ID — прежний путь в свой чат, без фанаута', async () => {
    process.env.TELEGRAM_SUPPORT_CHAT_ID = '-100500';
    post.mockResolvedValue({ data: { result: { message_id: 1 } } });
    await new TelegramNotifierService().notifyEscalation(ESCALATION);
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('/sendMessage'),
      expect.objectContaining({ chat_id: '-100500' }),
      expect.anything(),
    );
    expect(fanout).not.toHaveBeenCalled();
  });

  // ~4 ложных сообщения в день о плановом обновлении OAuth — здоровье так не шлём.
  it('здоровье сервисов без TELEGRAM_SUPPORT_CHAT_ID по-прежнему не шлётся', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyHealthAlert({ service: 'anthropic', prevStatus: 'healthy', newStatus: 'degraded' });
    expect(fanout).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
