jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
}));

import { Logger } from '@nestjs/common';
import axios from 'axios';
import { sendTelegramPayload, telegramConfigured } from '../common/telegram-alert';
import { TelegramNotifierService } from './telegram-notifier.service';

const post = axios.post as jest.Mock;
const fanout = sendTelegramPayload as jest.Mock;
const configured = telegramConfigured as jest.Mock;

// Одиночная половинка суррогатной пары — то, что оставляет slice посреди эмодзи.
const hasLoneSurrogate = (s: string) =>
  Array.from(s).some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800 && ch.charCodeAt(0) <= 0xdfff);
const EMOJI = String.fromCodePoint(0x1f600);

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
    // reset снимает реализацию из фабрики (async () => {}) — здесь нужен
    // только сброс истории вызовов между тестами.
    fanout.mockClear();
    // reset (не clear) — иначе очередь mockReturnValueOnce из предыдущего
    // теста переживёт его и подменит значение в следующем.
    configured.mockReset().mockReturnValue(true);
    process.env.TELEGRAM_BOT_TOKEN = 'token';
  });
  afterEach(() => { process.env = { ...saved }; });

  it('без TELEGRAM_SUPPORT_CHAT_ID — фанаутом по TELEGRAM_CHAT_ID, с кнопкой тикета', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    try {
      await new TelegramNotifierService().notifyEscalation(ESCALATION);
      expect(post).not.toHaveBeenCalled();
      expect(fanout).toHaveBeenCalledTimes(1);
      const payload = fanout.mock.calls[0][0];
      expect(payload.parse_mode).toBe('HTML');
      expect(payload.text).toContain('Escalation');
      expect(payload.text).toContain('#e86dc43d');
      expect(payload.reply_markup.inline_keyboard[0][0].url).toContain('ticket=e86dc43d-c45c-4583-9f97-1d11db821a1b');
      expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('handed to TELEGRAM_CHAT_ID fan-out');
    } finally {
      log.mockRestore();
    }
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

  it('Telegram не настроен вовсе — не шлём, но пишем в лог с номером тикета', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    configured.mockReturnValueOnce(false);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await new TelegramNotifierService().notifyEscalation(ESCALATION);
      expect(fanout).not.toHaveBeenCalled();
      expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('#e86dc43d');
    } finally {
      warn.mockRestore();
    }
  });

  it('эмодзи на границе обрезки не рвётся пополам', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyEscalation({ ...ESCALATION, summary: 'a'.repeat(799) + EMOJI + 'хвост' });
    expect(hasLoneSurrogate(fanout.mock.calls[0][0].text)).toBe(false);
  });

  // Ответ пользователя в тикете дублирует в группу сам SupportService — фанаут здесь дал бы два сообщения.
  it('ответ пользователя в тикете фанаутом не шлётся', async () => {
    delete process.env.TELEGRAM_SUPPORT_CHAT_ID;
    await new TelegramNotifierService().notifyUserReply({ ticketId: ESCALATION.ticketId, userName: 'Кира', userText: 'привет', ticketStatus: 'escalated' });
    expect(fanout).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });
});
