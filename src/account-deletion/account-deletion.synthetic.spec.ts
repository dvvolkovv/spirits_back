import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { hostname } from 'os';
import * as path from 'path';
import { deletionErrorKind } from './account-deletion.safe';
import type { DeletionErrorKind } from './account-deletion.types';
import { scriptErrorText } from '../common/one-off-script';
import {
  assertSyntheticPreflight,
  checkSyntheticGates,
  faultErrorFor,
  SYNTHETIC_APPLY_FLAG,
  SYNTHETIC_CONFIRM_FLAG,
  SYNTHETIC_DELETION_PREFIX,
  SYNTHETIC_GATE_ENV,
  SYNTHETIC_GATE_ENV_VALUE,
  SYNTHETIC_GATE_HOSTNAME,
  SyntheticFailures,
  SyntheticGateError,
  SyntheticPreflightError,
} from './account-deletion.synthetic';

/**
 * Task 22 — unit-контракты синтетической проверки lifecycle.
 *
 * Гейты CLI проверяются ЗДЕСЬ чистой функцией и spawn-ом ОТКАЗНЫХ веток.
 * ВНИМАНИЕ: полная тройка гейтов (--apply --confirm-account-deletion-cleanup
 * + ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io + hostname ugliest-salmon)
 * НИКОГДА не передаётся spawn-у: на CI-ноде hostname и есть ugliest-salmon,
 * и живой запуск synthetic — это Gate B, отдельное ОК владельца. Успешный
 * путь покрывает account-deletion.synthetic.pg.spec.ts напрямую через
 * composition root, без CLI.
 */

const fullGateEnv = (): Record<string, string> => ({
  [SYNTHETIC_GATE_ENV]: SYNTHETIC_GATE_ENV_VALUE,
});

describe('checkSyntheticGates — тройной гейт до любой записи', () => {
  const full = {
    argv: [SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG],
    env: fullGateEnv(),
    hostname: SYNTHETIC_GATE_HOSTNAME,
  };

  it('полная тройка гейтов — единственная пропускающая комбинация', () => {
    expect(() => checkSyntheticGates(full)).not.toThrow();
  });

  it('неполные флаги → SyntheticGateError', () => {
    const cases: string[][] = [
      [],
      [SYNTHETIC_APPLY_FLAG],
      [SYNTHETIC_CONFIRM_FLAG],
      [SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG, '--bogus'],
    ];
    for (const argv of cases) {
      expect(() => checkSyntheticGates({ ...full, argv })).toThrow(SyntheticGateError);
    }
  });

  it('нет env-гейта или значение чужое → SyntheticGateError', () => {
    expect(() => checkSyntheticGates({ ...full, env: {} })).toThrow(SyntheticGateError);
    expect(() => checkSyntheticGates({
      ...full,
      env: { [SYNTHETIC_GATE_ENV]: 'my.linkeon.io' },
    })).toThrow(SyntheticGateError);
  });

  it('чужой hostname → SyntheticGateError', () => {
    expect(() => checkSyntheticGates({ ...full, hostname: 'some-other-host' }))
      .toThrow(SyntheticGateError);
  });

  it('константы гейтов и префикс — без дрейфа', () => {
    expect(SYNTHETIC_GATE_ENV).toBe('ACCOUNT_DELETION_SYNTHETIC_ENV');
    expect(SYNTHETIC_GATE_ENV_VALUE).toBe('test.linkeon.io');
    expect(SYNTHETIC_GATE_HOSTNAME).toBe('ugliest-salmon');
    expect(SYNTHETIC_DELETION_PREFIX).toBe('synthetic-deletion-');
  });
});

describe('assertSyntheticPreflight — CLI preflight до seed (T22-Q5)', () => {
  it('dry-run не видел due-поколений (accounts===0) — пропускает', () => {
    expect(() => assertSyntheticPreflight({ accounts: 0 })).not.toThrow();
  });

  it('accounts>0 — SyntheticPreflightError со счётчиком, без PII', () => {
    let thrown: unknown;
    try {
      assertSyntheticPreflight({ accounts: 3 });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SyntheticPreflightError);
    // Форма scriptErrorText: в stderr уходит счётчик чужих due-поколений,
    // а не данные аккаунтов (ни userId, ни телефонов, ни deletionId).
    const text = scriptErrorText(thrown);
    expect(text).toContain('synthetic_preflight_accounts_not_zero');
    expect(text).toContain('3');
    expect(text).not.toMatch(/7999\d{7}/);
    expect(text).not.toContain('u-synthetic');
  });
});

describe('faultErrorFor — инжектируемая ошибка отображается в ожидаемый kind', () => {
  const kinds = [
    'timeout',
    'external_5xx',
    'external_4xx',
    'not_found',
    'permission',
    'rate_limited',
    'db',
    'external_unknown',
  ] as const;

  it.each(kinds)('%s → deletionErrorKind roundtrip', (kind) => {
    const error = faultErrorFor(kind);
    expect(error).toBeInstanceOf(Error);
    expect(deletionErrorKind(error)).toBe(kind);
  });

  it('roundtrip результат — валидный DeletionErrorKind для журналов', () => {
    const seen = new Set<DeletionErrorKind>();
    for (const kind of kinds) {
      seen.add(deletionErrorKind(faultErrorFor(kind)));
    }
    expect(seen.size).toBe(kinds.length);
  });
});

describe('SyntheticFailures — strict tri-state на внешних границах', () => {
  it('inject chainable, clear снимает отказ, счётчики копятся', () => {
    const failures = new SyntheticFailures();
    expect(failures.inject('minio', 'timeout')).toBe(failures);
    expect(failures.inject('host', 'external_unknown')).toBe(failures);

    expect(failures.isActive('minio')).toBe(true);
    expect(failures.isActive('host')).toBe(true);
    expect(failures.isActive('elevenlabs')).toBe(false);
    expect(failures.totalCalls()).toBe(0);

    failures.note('minio');
    failures.note('minio');
    failures.note('host');
    expect(failures.calls('minio')).toBe(2);
    expect(failures.calls('host')).toBe(1);
    expect(failures.totalCalls()).toBe(3);

    failures.clear();
    expect(failures.isActive('minio')).toBe(false);
    expect(failures.isActive('host')).toBe(false);
    // Счётчики вызовов переживают clear — это аудит границ, а не отказов.
    expect(failures.totalCalls()).toBe(3);
  });

  it('guard на активной границе бросает ошибку инжектированного kind', () => {
    const failures = new SyntheticFailures();
    expect(() => failures.guard('minio')).not.toThrow();

    failures.inject('elevenlabs', 'external_5xx');
    expect(() => failures.guard('elevenlabs')).toThrow();
    try {
      failures.guard('elevenlabs');
    } catch (error) {
      expect(deletionErrorKind(error)).toBe('external_5xx');
    }
  });

  it('failValue — tri-state для границ с возвращаемым исходом (host/attendee)', () => {
    const failures = new SyntheticFailures();
    expect(failures.failValue('host', false)).toBeUndefined();
    failures.inject('host', 'external_unknown');
    expect(failures.failValue('host', false)).toBe(false);
  });
});

describe('scripts/account-deletion-synthetic.ts — spawn только ОТКАЗНЫХ веток', () => {
  const repo = path.resolve(__dirname, '..', '..');

  function spawnCli(args: string[], env: Record<string, string>) {
    // Прецедент — dry-run.spec.ts: ts-node spawn без Nest, минимальный env
    // (нет DATABASE_URL и нет гейт-env) → гейты обязаны отказать ДО любого
    // подключения/записи. Полная тройка гейтов сюда не передаётся никогда.
    return spawnSync(process.execPath, [
      require.resolve('ts-node/dist/bin'),
      '-P', path.join(repo, 'tsconfig.json'),
      path.join(repo, 'scripts', 'account-deletion-synthetic.ts'),
      ...args,
    ], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 90_000,
      env: { PATH: process.env.PATH ?? '', TS_NODE_TRANSPILE_ONLY: '1', ...env },
    });
  }

  it('без флагов → exit 2, stdout пуст, в stderr — synthetic_gates_not_met', () => {
    const res = spawnCli([], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('synthetic_gates_not_met');
  }, 120_000);

  it('только --apply → exit 2, stdout пуст', () => {
    const res = spawnCli([SYNTHETIC_APPLY_FLAG], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  }, 120_000);

  it('--apply + confirm без env-гейта → exit 2, stdout пуст', () => {
    const res = spawnCli([SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  }, 120_000);

  it('флаги + env на чужом hostname → exit 2, stdout пуст', () => {
    // На CI-ноде hostname и есть ugliest-salmon — кейс автоматически
    // пропускается: гейт hostname там закрыл бы ветку, а пройти дальше
    // (подключение к БД) тесту запрещено.
    if (hostname() === SYNTHETIC_GATE_HOSTNAME) return;
    const res = spawnCli(
      [SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG],
      fullGateEnv(),
    );
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
  }, 120_000);
});

describe('source-guard: CLI и composition root без внешних исполнителей', () => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const read = (rel: string) => readFileSync(path.join(repoRoot, rel), 'utf8');

  it('CLI проверяет гейты и печатает только SYNTHETIC_TEST_OK + counts', () => {
    const source = read(path.join('scripts', 'account-deletion-synthetic.ts'));
    expect(source).toContain('checkSyntheticGates');
    expect(source).toContain('SYNTHETIC_TEST_OK');
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bssh\b/i);
    expect(source).not.toMatch(/\bdocker\b/i);
  });

  it('composition root не порождает процессы и не ходит наружу сам', () => {
    const source = read(path.join('src', 'account-deletion', 'account-deletion.synthetic.ts'));
    expect(source).not.toMatch(/child_process/);
    expect(source).not.toMatch(/\bdocker\b/i);
    // Никаких платных внешних вызовов: только doubles на границах.
    expect(source).toContain('SyntheticFailures');
  });
});
