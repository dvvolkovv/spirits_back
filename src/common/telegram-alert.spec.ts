import { Logger } from '@nestjs/common';
import axios from 'axios';
import { sendTelegramPayload, setAlertSentSink } from './telegram-alert';
jest.mock('axios');

describe('журнал отправленных алертов', () => {
  const originalBotToken = process.env.TELEGRAM_BOT_TOKEN;
  const originalChatId = process.env.TELEGRAM_CHAT_ID;

  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'TEST-TOKEN';
    process.env.TELEGRAM_CHAT_ID = '1,2';
    jest.resetAllMocks();
    setAlertSentSink(null);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    setAlertSentSink(null);
    if (originalBotToken === undefined) {
      delete process.env.TELEGRAM_BOT_TOKEN;
    } else {
      process.env.TELEGRAM_BOT_TOKEN = originalBotToken;
    }
    if (originalChatId === undefined) {
      delete process.env.TELEGRAM_CHAT_ID;
    } else {
      process.env.TELEGRAM_CHAT_ID = originalChatId;
    }
  });

  it('приёмник получает чат, message_id и исходный текст', async () => {
    const sink = jest.fn(async () => {});
    setAlertSentSink(sink);
    (axios.post as jest.Mock).mockImplementation(async (_u, p) => ({
      data: { ok: true, result: { message_id: p.chat_id === '1' ? 10 : 20 } },
    }));
    await sendTelegramPayload({ chat_id: 'ignored', text: '🔥 тест' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).toHaveBeenCalledWith('1', 10, '🔥 тест');
    expect(sink).toHaveBeenCalledWith('2', 20, '🔥 тест');
  });

  it('приёмник не вызывается при отказе и его сбой не ломает отправку', async () => {
    const sink = jest.fn(async () => {
      throw new Error('db down');
    });
    setAlertSentSink(sink);
    (axios.post as jest.Mock)
      .mockRejectedValueOnce({ response: { data: { description: 'blocked' } } })
      .mockResolvedValueOnce({ data: { ok: true, result: { message_id: 20 } } });
    await expect(sendTelegramPayload({ text: 'тест' })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['ok:false', { ok: false, result: { message_id: 20 } }],
    ['message_id=null', { ok: true, result: { message_id: null } }],
    ['пустой message_id', { ok: true, result: { message_id: '' } }],
    ['нулевой message_id', { ok: true, result: { message_id: 0 } }],
  ])('не вызывает приёмник для %s', async (_case, data) => {
    process.env.TELEGRAM_CHAT_ID = '1';
    const sink = jest.fn(async () => {});
    setAlertSentSink(sink);
    (axios.post as jest.Mock).mockResolvedValue({ data });

    await sendTelegramPayload({ text: 'тест' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(sink).not.toHaveBeenCalled();
  });

  it('синхронный сбой приёмника логирует без not delivered и секретного текста', async () => {
    process.env.TELEGRAM_CHAT_ID = '1';
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const sink = jest.fn(() => {
      throw new Error('SYNC-SINK-SECRET');
    });
    setAlertSentSink(sink);
    (axios.post as jest.Mock).mockResolvedValue({
      data: { ok: true, result: { message_id: 20 } },
    });

    await expect(sendTelegramPayload({ text: 'тест' })).resolves.toBeUndefined();
    await new Promise((resolve) => setImmediate(resolve));

    const warnings = warn.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(sink).toHaveBeenCalledTimes(1);
    expect(warnings).toContain('alert journal failed');
    expect(warnings).not.toContain('not delivered');
    expect(warnings).not.toContain('SYNC-SINK-SECRET');
  });
});
