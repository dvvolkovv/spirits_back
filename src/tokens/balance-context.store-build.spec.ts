import { BalanceContextService } from './balance-context.service';

/// Ссылка на пополнение в промпте ассистента.
///
/// Отказ Apple 17.08.2026 по правилу 3.1.1: у проверяющего кончились токены, и
/// ассистент честно выдал ему адрес оплаты на сайте. Правило считает
/// нарушением любую точку доступа к оплате мимо биллинга магазина — включая
/// ссылку внутри ответа модели, которую не видно ни в вёрстке, ни в тестах
/// экранов.
///
/// Обновлено 19.08.2026 после ЧЕТВЁРТОГО отказа. Сначала убрали витрину,
/// потом ссылку, потом купон — Apple повторяла одно и то же: приложение даёт
/// доступ к оплаченному вне его. Претензия оказалась к самому балансу.
///
/// Решение владельца: в магазинной сборке баланса нет ни на экране, ни в
/// разговоре. Прежний тест закреплял обратное — «баланс называть можно» — и
/// теперь снят: ассистент, назвавший цифру, разглашает то же самое другим
/// способом.

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

  it('в магазинной сборке блока баланса нет вовсе', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {
      storeBuild: true,
    });
    expect(block).toBe('');
  });

  it('в магазинной сборке цифра баланса не попадает в промпт', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {
      storeBuild: true,
    });
    expect(block).not.toContain('5000');
  });

  it('в обычной сборке баланс называется как прежде', async () => {
    const block = await service().buildContextForPrompt('u1', 5000, {});
    expect(block).toContain('5000 токенов');
  });
});
