import { SecretsService } from './secrets.service';

const KEY = 'a'.repeat(64); // 32 байта в hex

describe('SecretsService', () => {
  it('расшифровка возвращает исходное', () => {
    const svc = new SecretsService({ get: () => KEY } as any);

    const box = svc.encrypt({ BOT_TOKEN: '123:abc' });

    expect(svc.decrypt(box)).toEqual({ BOT_TOKEN: '123:abc' });
  });

  it('два шифрования одного и того же дают разный шифротекст', () => {
    // Одинаковый шифротекст означал бы фиксированный iv: по базе стало бы
    // видно, у каких продуктов совпадают секреты.
    const svc = new SecretsService({ get: () => KEY } as any);

    const a = svc.encrypt({ BOT_TOKEN: 'x' });
    const b = svc.encrypt({ BOT_TOKEN: 'x' });

    expect(a.equals(b)).toBe(false);
  });

  it('подмена шифротекста ловится, а не расшифровывается в мусор', () => {
    // Без проверки тега GCM порча данных дала бы тихий мусор вместо ошибки,
    // и в контейнер уехал бы испорченный токен.
    const svc = new SecretsService({ get: () => KEY } as any);
    const box = svc.encrypt({ BOT_TOKEN: 'x' });
    box[box.length - 1] ^= 0xff;

    expect(() => svc.decrypt(box)).toThrow();
  });

  it('порча ЛЮБОГО байта коробки ловится — иначе тег не проверяется вовсе', () => {
    // Проверка выше портит ПОСЛЕДНИЙ байт — это закрывающая скобка JSON,
    // поэтому она краснеет и от JSON.parse, без всякой аутентификации.
    // Измерено мутациями: и aes-256-ctr с нулевым тегом, и проглоченный
    // d.final() выживали, оставляя её зелёной. Байты тега на расшифрованный
    // текст не влияют никак, кроме проверки GCM: промолчать там нечем. Перебор
    // всех позиций вместо одной — чтобы проверка не зависела от того, где
    // проходит граница iv и тега.
    const svc = new SecretsService({ get: () => KEY } as any);

    const len = svc.encrypt({ BOT_TOKEN: 'x' }).length;
    for (let i = 0; i < len; i++) {
      const box = svc.encrypt({ BOT_TOKEN: 'x' });
      box[i] ^= 0xff;
      expect(() => svc.decrypt(box)).toThrow();
    }
  });

  it('без ключа в окружении шифрование отказывает громко', () => {
    // Молчаливый переход на «хранить как есть» означал бы секреты открытым
    // текстом в базе, и заметить это было бы нечем.
    const svc = new SecretsService({ get: () => undefined } as any);

    expect(() => svc.encrypt({ A: '1' })).toThrow(/PRODUCT_SECRETS_KEY/);
  });
});
