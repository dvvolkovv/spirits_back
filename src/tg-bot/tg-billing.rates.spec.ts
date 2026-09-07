import { TgBillingService } from './tg-billing.service';
import { CASH_TOKENS_PER_USD, SEAT_TOKENS_PER_USD } from '../common/billing-rates';

/**
 * Ход бота с озвучкой тарифицируется ДВУМЯ курсами.
 *
 * Claude — подписка, там курс нормирует дефицитную ёмкость. Озвучка
 * оплачивается OpenAI живыми деньгами и возмещается по своему курсу. До
 * 07.09.2026 доллары складывались и делились по курсу подписки, из-за чего
 * доллар, отданный OpenAI, возвращался к нам примерно девятью рублями из
 * восьмидесяти.
 */
describe('TgBillingService — курсы', () => {
  const svc = new TgBillingService({} as any, {} as any);

  it('ход без озвучки считается по курсу подписки, как и раньше', () => {
    expect(svc.tokensForTurn(0.5, 0)).toBe(Math.ceil(0.5 * SEAT_TOKENS_PER_USD));
    expect(svc.tokensForTurn(0.5, 0)).toBe(svc.tokensFromUsd(0.5));
  });

  it('озвучка считается по курсу возмещения живых денег', () => {
    expect(svc.tokensForTurn(0, 0.02)).toBe(Math.ceil(0.02 * CASH_TOKENS_PER_USD));
  });

  it('доллар OpenAI стоит дороже доллара Claude — курсы не перепутаны', () => {
    expect(svc.tokensForTurn(0, 1)).toBeGreaterThan(svc.tokensForTurn(1, 0));
  });

  /**
   * Главное: сумма долларов по одному курсу — это прежняя ошибка. Ход, где
   * озвучка сопоставима с Claude по деньгам, теперь стоит заметно дороже.
   */
  it('складывать доллары и делить одним курсом больше нельзя', () => {
    const claudeUsd = 0.01;
    const ttsUsd = 0.015; // ответ на 1000 знаков через tts-1
    expect(svc.tokensForTurn(claudeUsd, ttsUsd)).toBeGreaterThan(
      svc.tokensFromUsd(claudeUsd + ttsUsd),
    );
  });
});
