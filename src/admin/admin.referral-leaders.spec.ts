import { AdminService } from './admin.service';

/**
 * Заведение реферального лидера из админки.
 *
 * Кабинет лидера находит свою строку по `user_phone = user_id`
 * (ReferralService.getOrCreateLeader), а user_id телефонного пользователя —
 * голые цифры: 79001234567. Админская форма писала телефон как ввели —
 * «+79001234567». Совпадения не было, и кабинет молча заводил лидеру вторую,
 * пустую ссылку: человек раздавал свою, рефералы и комиссии копились на ней,
 * а в кабинете он видел ноль и не мог ничего вывести (27.10.2026).
 */

function fakePg() {
  const calls: { sql: string; params: any[] }[] = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      return { rows: [{}] };
    },
  };
}

async function savedUserPhone(userPhone: unknown): Promise<unknown> {
  const pg = fakePg();
  await new AdminService(pg as any).createReferralLeader({ name: 'Лидер', slug: 'leader-test', user_phone: userPhone });
  const insert = pg.calls.find((c) => c.sql.includes('INSERT INTO referral_leaders'))!;
  return insert.params[2];
}

describe('AdminService.createReferralLeader — телефон лидера', () => {
  it('пишет телефон с плюсом как user_id — голыми цифрами', async () => {
    expect(await savedUserPhone('+79001234567')).toBe('79001234567');
  });

  it('снимает пробелы, скобки и дефисы', async () => {
    expect(await savedUserPhone(' +7 (900) 123-45-67 ')).toBe('79001234567');
  });

  it('российскую восьмёрку переводит в семёрку', async () => {
    expect(await savedUserPhone('8 900 123 45 67')).toBe('79001234567');
  });

  it('user_id почтового или OAuth-пользователя (UUID) не трогает', async () => {
    expect(await savedUserPhone('0b7c2f3e-1a2b-4c5d-8e9f-0a1b2c3d4e5f')).toBe('0b7c2f3e-1a2b-4c5d-8e9f-0a1b2c3d4e5f');
    // UUID, в котором случайно нет букв, — всё равно UUID, а не телефон.
    expect(await savedUserPhone('12345678-1234-4234-8234-123456789012')).toBe('12345678-1234-4234-8234-123456789012');
  });

  it('пустой телефон остаётся пустым', async () => {
    expect(await savedUserPhone('')).toBeNull();
    expect(await savedUserPhone(undefined)).toBeNull();
  });
});
