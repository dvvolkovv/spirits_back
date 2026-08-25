import * as fs from 'fs';
import * as path from 'path';
import { IdentityService, IDENTITY_MIGRATIONS } from './identity.service';

describe('IdentityService — провайдер telegram', () => {
  const svc = new IdentityService() as any;

  it('normalize отдаёт tg_user_id строкой', () => {
    expect(svc.normalize('telegram', { sub: '42' })).toBe('42');
  });

  it('extractEmail не выдумывает почту', () => {
    expect(svc.extractEmail('telegram', { sub: '42' })).toEqual({
      email: null,
      verified: false,
    });
  });

  it('normalize по-прежнему знает остальные провайдеры', () => {
    expect(svc.normalize('phone', { phone: '+7 (903) 016-91-87' })).toBe('79030169187');
    expect(svc.normalize('google', { sub: 'g-1' })).toBe('g-1');
  });
});

describe('список переутверждаемых файлов схемы', () => {
  const ALL_PROVIDERS = ['phone', 'email', 'google', 'yandex', 'talerid', 'apple', 'telegram'];

  it('не катает 002 — он снял бы apple', () => {
    expect(IDENTITY_MIGRATIONS).not.toContain('002_talerid_provider.sql');
  });

  // Ловит класс ошибки, а не конкретный файл: любой катаемый файл, который
  // трогает констрейнт провайдеров, обязан перечислить всех до единого.
  // Именно из-за дописывания «ещё одного» 002 и потерял apple.
  it.each(IDENTITY_MIGRATIONS)('%s перечисляет всех провайдеров, если трогает констрейнт', (file) => {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8');
    if (!sql.includes('user_identities_provider_check')) return;
    for (const p of ALL_PROVIDERS) {
      expect(sql).toContain(`'${p}'`);
    }
  });
});
