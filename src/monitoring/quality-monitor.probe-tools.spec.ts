jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));
jest.mock('../common/telegram-alert', () => ({
  sendTelegramPayload: jest.fn(async () => {}),
  sendTelegramAlert: jest.fn(async () => {}),
}));

import { QualityMonitorService } from './quality-monitor.service';

/**
 * Проба качества — служебный ход тестового аккаунта: инструменты Linkeon ей
 * не нужны, поля токена хода она не получает (спека
 * 2026-10-26-mcp-turn-token-design.md, «Кто не получает»).
 */
describe('проба качества — без инструментов Linkeon', () => {
  const OLD = {
    user: process.env.QUALITY_PROBE_USER,
    agent: process.env.QUALITY_PROBE_ASSISTANT,
    off: process.env.QUALITY_PROBE_DISABLED,
    relayMonitor: process.env.RELAY_QWEN_MONITOR,
  };
  beforeAll(() => {
    delete process.env.QUALITY_PROBE_USER;
    delete process.env.QUALITY_PROBE_ASSISTANT;
    delete process.env.QUALITY_PROBE_DISABLED;
    delete process.env.RELAY_QWEN_MONITOR;
  });
  afterAll(() => {
    for (const [k, v] of [
      ['QUALITY_PROBE_USER', OLD.user],
      ['QUALITY_PROBE_ASSISTANT', OLD.agent],
      ['QUALITY_PROBE_DISABLED', OLD.off],
      ['RELAY_QWEN_MONITOR', OLD.relayMonitor],
    ] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  // Ревью 26.10.2026: linkeonTools по умолчанию false — отдельный флаг пробе
  // не нужен, достаточно не передавать опции вовсе.
  it('ответ ассистента зовётся без опций (linkeonTools по умолчанию — false) в своей qprobe-сессии', async () => {
    const chat = { generateAgentReply: jest.fn(async (..._a: any[]) => 'Желаю вам хорошего дня!') };
    const synthetic = { record: jest.fn(async () => {}) };
    const svc = new QualityMonitorService({ query: jest.fn(async () => ({ rows: [] })) } as any, chat as any, synthetic as any);
    await svc.qualityProbe();
    expect(chat.generateAgentReply).toHaveBeenCalledWith(
      '70000000000', '12', expect.any(String), expect.stringMatching(/^qprobe_12_/),
    );
  });

  it('RELAY_QWEN_MONITOR=off — не отправляет qprobe в общий боевой релей', async () => {
    process.env.RELAY_QWEN_MONITOR = 'oFf';
    const chat = { generateAgentReply: jest.fn(async (..._a: any[]) => 'Желаю вам хорошего дня!') };
    const synthetic = { record: jest.fn(async () => {}) };
    const svc = new QualityMonitorService({ query: jest.fn(async () => ({ rows: [] })) } as any, chat as any, synthetic as any);

    await svc.qualityProbe();

    expect(chat.generateAgentReply).not.toHaveBeenCalled();
    expect(synthetic.record).not.toHaveBeenCalled();
  });
});
