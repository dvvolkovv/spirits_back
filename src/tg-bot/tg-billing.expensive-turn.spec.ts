import { TgBillingService } from './tg-billing.service';
import * as alert from '../common/telegram-alert';

/**
 * Алерт на аномально дорогой ход TG-бота.
 *
 * В вебе такой порог есть с тех пор, как ход юриста за $47 прошёл незамеченным
 * (chat.service, EXPENSIVE_TURN_ALERT_USD). В телеге его не было: ход за 65 029
 * токенов — сгенерированный договор аренды — списался молча, и узнали мы о нём
 * только потому, что полезли в БД руками.
 *
 * После перевода бота на модель веба (Opus вместо Sonnet) тяжёлые агентные ходы
 * дорожают кратно, так что молчание здесь стоит слишком дорого.
 *
 * Порог с 02.09.2026 — в списанных токенах (30 000), общий с вебом. Долларовый
 * будил на ходах, которые для агентного бота норма: договор или подборка
 * тендеров легко стоят $4–7, и алерт на них перестали читать.
 */

describe('TgBillingService.alertIfExpensiveTurn', () => {
  const cfg: any = { id: 'cfg-1', display_name: 'Роман', owner_user_id: '79235216999' };
  let sent: string[];

  beforeEach(() => {
    sent = [];
    jest.spyOn(alert, 'sendTelegramAlert').mockImplementation(async (text: string) => {
      sent.push(text);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  const svc = () => new TgBillingService({} as any, {} as any);

  it('молчит на обычном ходе', async () => {
    await svc().alertIfExpensiveTurn(cfg, 0.12, 432, 50_000);

    expect(sent).toHaveLength(0);
  });

  it('дорогой в долларах, но лёгкий по списанию — молчит', async () => {
    // Ровно тот случай, из-за которого порог перевели в токены: $7.5 старый
    // долларовый порог перешагивал, а для агентного хода это обычная цена.
    await svc().alertIfExpensiveTurn(cfg, 7.5, 27_000, 12_345);

    expect(sent).toHaveLength(0);
  });

  it('алертит, когда ход перевалил порог в 30 тыс. токенов', async () => {
    await svc().alertIfExpensiveTurn(cfg, 8.4, 30_000, 12_345);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('8.40');
    expect(sent[0]).toContain('Роман');
  });

  it('в алерте видно, чей это баланс и сколько осталось', async () => {
    await svc().alertIfExpensiveTurn(cfg, 9, 32_400, 1_000);

    expect(sent[0]).toContain('79235216999');
    expect(sent[0]).toContain('1 000'.replace(' ', ' '));
  });

  it('падение телеграма не ломает ход — списание уже произошло', async () => {
    jest.spyOn(alert, 'sendTelegramAlert').mockRejectedValue(new Error('telegram down'));

    await expect(svc().alertIfExpensiveTurn(cfg, 9, 32_400, 1_000)).resolves.toBeUndefined();
  });
});
