import * as fs from 'fs';
import * as path from 'path';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';

/**
 * Миграция катится при КАЖДОМ старте API. Голый CREATE INDEX IF NOT EXISTS на
 * PG 16 берёт ShareLock на таблицу даже при готовом индексе (см. tokens/002),
 * поэтому файл — один DO под advisory-локом, индексы — через to_regclass.
 */
describe('миграция пробы', () => {
  for (const file of GUEST_TRIAL_MIGRATIONS) {
    describe(file, () => {
      const sql = fs.readFileSync(path.join(__dirname, 'migrations', file), 'utf8');
      const code = sql.replace(/--.*$/gm, '');

      it('файл — один DO под advisory-локом и lock_timeout', () => {
        expect(code.trim().startsWith('DO $guest_trial$')).toBe(true);
        expect(code.trim().endsWith('$guest_trial$;')).toBe(true);
        expect(code).toContain('pg_advisory_xact_lock');
        expect(code).toContain("set_config('lock_timeout'");
      });

      it('индексы создаются только если их нет', () => {
        expect(code).not.toMatch(/CREATE INDEX IF NOT EXISTS/i);
        expect((code.match(/CREATE\s+(UNIQUE\s+)?INDEX/gi) ?? []).length).toBe((code.match(/to_regclass\(/g) ?? []).length);
      });
    });
  }
});
