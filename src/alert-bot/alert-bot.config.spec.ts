import { alertBotEnabled, alertBotModel, alertBotOpsPort, alertBotRatePerHour, alertBotTimeoutMs, validAlertBotSecret } from './alert-bot.config';

const ENV_KEYS = [
  'ALERT_BOT_WEBHOOK_URL',
  'ALERT_BOT_WEBHOOK_SECRET',
  'ALERT_BOT_RATE_PER_HOUR',
  'ALERT_BOT_TIMEOUT_MS',
  'ALERT_BOT_OPS_PORT',
  'ALERT_BOT_MODEL',
  'CHAT_MODEL',
] as const;
const SAVED_ENV = ENV_KEYS.map((key) => [key, process.env[key]] as const);

describe('настройки бота алертов', () => {
  afterEach(() => {
    for (const [key, value] of SAVED_ENV) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
  });
  it('вход выключен без любой из двух переменных', () => {
    delete process.env.ALERT_BOT_WEBHOOK_URL;
    delete process.env.ALERT_BOT_WEBHOOK_SECRET;
    expect(alertBotEnabled()).toBe(false);
    process.env.ALERT_BOT_WEBHOOK_URL = 'https://example.test/webhook/alert-bot/telegram';
    expect(alertBotEnabled()).toBe(false);
    process.env.ALERT_BOT_WEBHOOK_SECRET = 'secret';
    expect(alertBotEnabled()).toBe(true);
  });
  it('секрет сравнивается полностью', () => {
    process.env.ALERT_BOT_WEBHOOK_SECRET = 'secret';
    expect(validAlertBotSecret('secret')).toBe(true);
    expect(validAlertBotSecret('secre')).toBe(false);
    expect(validAlertBotSecret('secret0')).toBe(false);
    expect(validAlertBotSecret(undefined)).toBe(false);
  });
  it('числовые настройки ограничены', () => {
    process.env.ALERT_BOT_RATE_PER_HOUR = '-2';
    process.env.ALERT_BOT_TIMEOUT_MS = '1';
    process.env.ALERT_BOT_OPS_PORT = '70000';
    expect(alertBotRatePerHour()).toBe(30);
    expect(alertBotTimeoutMs()).toBe(180000);
    expect(alertBotOpsPort()).toBe(3091);
    delete process.env.ALERT_BOT_MODEL;
    process.env.CHAT_MODEL = 'claude-test';
    expect(alertBotModel()).toBe('claude-test');
  });
});
