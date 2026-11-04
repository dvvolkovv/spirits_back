import axios from 'axios';
import { AlertBotTelegram } from './alert-bot.telegram';
jest.mock('axios');

describe('Telegram бота алертов', () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = 'TEST-TOKEN-НЕ-НАСТОЯЩИЙ';
    process.env.ALERT_BOT_WEBHOOK_URL = 'https://example.test/webhook/alert-bot/telegram';
    process.env.ALERT_BOT_WEBHOOK_SECRET = 'secret';
    jest.resetAllMocks();
  });
  it('ответ — простой текст, реплай, без превью', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: { ok: true, result: { message_id: 10 } } });
    const tg = new AlertBotTelegram();
    await tg.sendMessage('1', 'a < b', 7);
    const payload = (axios.post as jest.Mock).mock.calls[0][1];
    expect(payload).toMatchObject({ chat_id: '1', text: 'a < b', reply_to_message_id: 7, allow_sending_without_reply: true, link_preview_options: { is_disabled: true } });
    expect(payload.parse_mode).toBeUndefined();
  });
  it('ошибка axios не раскрывает токен', async () => {
    (axios.post as jest.Mock).mockRejectedValue({ config: { url: 'https://api.telegram.org/botTEST-TOKEN-НЕ-НАСТОЯЩИЙ/getMe' }, message: 'failed' });
    const err = await new AlertBotTelegram().getMe().catch((e) => e);
    expect(JSON.stringify(err)).not.toContain('TEST-TOKEN-НЕ-НАСТОЯЩИЙ');
  });
  it('пустой или свой адрес регистрируется, меню выставляется', async () => {
    (axios.post as jest.Mock).mockResolvedValue({ data: { ok: true, result: true } });
    const tg = new AlertBotTelegram();
    jest.spyOn(tg, 'getWebhookInfo').mockResolvedValue({ url: '' });
    await tg.registerWebhook();
    const methods = (axios.post as jest.Mock).mock.calls.map((c) => c[0].split('/').pop());
    expect(methods).toContain('setWebhook');
    expect(methods).toContain('setMyCommands');
  });
  it('чужой адрес не перезаписывается', async () => {
    const tg = new AlertBotTelegram();
    jest.spyOn(tg, 'getWebhookInfo').mockResolvedValue({ url: 'https://other.test/hook' });
    (axios.post as jest.Mock).mockResolvedValue({ data: { ok: true, result: true } });
    await tg.registerWebhook();
    const methods = (axios.post as jest.Mock).mock.calls.map((c) => c[0].split('/').pop());
    expect(methods).not.toContain('setWebhook');
  });
});
