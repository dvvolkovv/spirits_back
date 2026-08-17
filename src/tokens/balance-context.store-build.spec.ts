import { BalanceContextService } from './balance-context.service';

/// Ссылка на пополнение в промпте ассистента.
///
/// Отказ Apple 17.08.2026 по правилу 3.1.1: у проверяющего кончились токены, и
/// ассистент честно выдал ему адрес оплаты на сайте. Правило считает
/// нарушением любую точку доступа к оплате мимо биллинга магазина — включая
/// ссылку внутри ответа модели, которую не видно ни в вёрстке, ни в тестах
/// экранов.
///
/// Баланс называть можно: это факт о счёте, а не предложение купить.

function service(): BalanceContextService {
  // Прогноз и отметку о предупреждении подменяем: здесь важен только текст.
  const svc = new BalanceContextService({ query: async () => ({ rows: [] }) } as any);
  (svc as any).forecastMessages = async () => 12;
  (svc as any).grantWarning = async () => true;
  return svc;
}

describe('ссылка на пополнение и канал сборки', () => {
  it('в обычной сборке ссылка есть', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {});
    expect(block).toContain('my.linkeon.io/chat?view=tokens');
  });

  it('в сборке для магазина ссылки НЕТ ни в одном месте', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {
      storeBuild: true,
    });
    expect(block).not.toContain('my.linkeon.io');
    expect(block).not.toContain('Пополнить баланс');
  });

  it('в сборке для магазина модели прямо запрещено объяснять, где купить', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {
      storeBuild: true,
    });
    expect(block).toMatch(/НЕ давай ссылок на пополнение/);
  });

  it('баланс называется в обеих сборках — это факт, а не продажа', async () => {
    for (const storeBuild of [false, true]) {
      const block = await service().buildContextForPrompt('u1', 5000, { storeBuild });
      expect(block).toContain('5000 токенов');
    }
  });
});
