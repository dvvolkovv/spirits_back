jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));

import { AlertBotCommands } from './alert-bot.commands';

const TICKET = '11111111-1111-4111-8111-111111111111';
const identity = { tgUserId: '111', adminUserId: 'u-admin' };

describe('команды бота алертов', () => {
  const status = { summary: jest.fn() };
  const support = {
    findTicketByPrefix: jest.fn(),
    setStatusFromTelegram: jest.fn(),
  };
  const commands = new AlertBotCommands(status as any, support as any);

  beforeEach(() => {
    jest.clearAllMocks();
    status.summary.mockResolvedValue('Алерты: горящих нет');
    support.setStatusFromTelegram.mockResolvedValue(undefined);
  });

  it('/start возвращает справку', async () => {
    expect(await commands.start()).toContain('/ask');
    expect(await commands.start()).toContain('/status');
    expect(await commands.start()).toContain('/close');
    expect(await commands.start()).toContain('черновик');
  });

  it('/status не вызывает модель', async () => {
    expect(await commands.status()).toBe('Алерты: горящих нет');
    expect(status.summary).toHaveBeenCalledTimes(1);
  });

  it('/close #11111111 закрывает найденный тикет от аккаунта админа', async () => {
    support.findTicketByPrefix.mockResolvedValue({ id: TICKET });

    expect(await commands.close('#11111111', identity)).toContain('✅');
    expect(support.findTicketByPrefix).toHaveBeenCalledWith('11111111');
    expect(support.setStatusFromTelegram).toHaveBeenCalledWith(TICKET, '111', 'resolved', 'u-admin');
  });

  it('неизвестный тикет не закрывается', async () => {
    support.findTicketByPrefix.mockResolvedValue(null);

    expect(await commands.close('#11111111', identity)).toContain('Не нашёл');
    expect(support.setStatusFromTelegram).not.toHaveBeenCalled();
  });

  it.each(['1111111', '111111111', 'не-тикет'])('не ищет тикет по неполному или не hex ref %s', async (ref) => {
    expect(await commands.close(ref, identity)).toContain('Не нашёл');
    expect(support.findTicketByPrefix).not.toHaveBeenCalled();
    expect(support.setStatusFromTelegram).not.toHaveBeenCalled();
  });
});
