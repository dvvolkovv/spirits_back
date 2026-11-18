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
  isSyntheticGateHostname,
  SYNTHETIC_APPLY_FLAG,
  SYNTHETIC_CONFIRM_FLAG,
  SYNTHETIC_DELETION_PREFIX,
  SYNTHETIC_GATE_ENV,
  SYNTHETIC_GATE_ENV_VALUE,
  SYNTHETIC_GATE_HOSTNAMES,
  SyntheticFailures,
  SyntheticGateError,
  SyntheticPreflightError,
  restoreAccountDeletionWorkerEnv,
  withAccountDeletionWorkerEnabled,
} from './account-deletion.synthetic';

/**
 * Task 22 — unit-контракты синтетической проверки lifecycle.
 *
 * Гейты CLI проверяются ЗДЕСЬ чистой функцией и spawn-ом ОТКАЗНЫХ веток.
 * ВНИМАНИЕ: полная тройка гейтов (--apply --confirm-account-deletion-cleanup
 * + ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io + hostname из точного
 * allow-list SYNTHETIC_GATE_HOSTNAMES) НИКОГДА не передаётся spawn-у: на
 * CI-ноде os.hostname() = ugliest-salmon.ptr.network, это имя входит в
 * allow-list, и живой запуск synthetic — это Gate B, отдельное ОК
 * владельца. Успешный путь покрывает account-deletion.synthetic.pg.spec.ts
 * напрямую через composition root, без CLI.
 */

const fullGateEnv = (): Record<string, string> => ({
  [SYNTHETIC_GATE_ENV]: SYNTHETIC_GATE_ENV_VALUE,
});

describe('checkSyntheticGates — тройной гейт до любой записи', () => {
  const full = {
    argv: [SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG],
    env: fullGateEnv(),
    hostname: 'ugliest-salmon',
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

  it('FQDN тест-ноды ugliest-salmon.ptr.network при полной тройке — пропускает', () => {
    // os.hostname() на тест-ноде отдаёт FQDN, а не короткое имя.
    expect(() => checkSyntheticGates({ ...full, hostname: 'ugliest-salmon.ptr.network' }))
      .not.toThrow();
  });

  // Двойники разрешённых имён — страховка от префиксной, регистронезависимой
  // и нормализующей (trim, хвостовая точка) реализации: allow-list
  // сравнивается строго на равенство.
  const hostnameDoubles = [
    'ugliest-salmon.evil.example',
    'ugliest-salmon-2',
    'UGLIEST-SALMON',
    'ugliest-salmon.ptr.network.',
    'ugliest-salmon ',
    ' ugliest-salmon',
    '',
  ];

  it.each(hostnameDoubles)('двойник hostname %p → SyntheticGateError', (name) => {
    expect(() => checkSyntheticGates({ ...full, hostname: name }))
      .toThrow(SyntheticGateError);
  });

  it('isSyntheticGateHostname — только точные имена allow-list', () => {
    expect(isSyntheticGateHostname('ugliest-salmon')).toBe(true);
    expect(isSyntheticGateHostname('ugliest-salmon.ptr.network')).toBe(true);
    for (const name of hostnameDoubles) {
      expect(isSyntheticGateHostname(name)).toBe(false);
    }
  });

  it('константы гейтов и префикс — без дрейфа', () => {
    expect(SYNTHETIC_GATE_ENV).toBe('ACCOUNT_DELETION_SYNTHETIC_ENV');
    expect(SYNTHETIC_GATE_ENV_VALUE).toBe('test.linkeon.io');
    expect(SYNTHETIC_GATE_HOSTNAMES).toEqual(['ugliest-salmon', 'ugliest-salmon.ptr.network']);
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
    // Прецедент — dry-run.spec.ts: ts-node spawn без Nest. Env ребёнка
    // собирается явно, без process.env, — но этого мало: CLI делает
    // `import 'dotenv/config'`, а cwd = корень репозитория. В чекауте на
    // стенде там может лежать .env с DATABASE_URL, и dotenv подмешал бы его
    // (и любой другой ключ из файла, включая гейт-env, если он там окажется)
    // в env ребёнка. Поэтому:
    // - DOTENV_CONFIG_PATH=/nonexistent — dotenv/config читает путь из этой
    //   переменной вместо ./.env; отсутствующий файл dotenv глотает
    //   (возвращает error, процесс не падает);
    // - гейт-env и DATABASE_URL заданы ПУСТЫМИ строками, а не опущены:
    //   dotenv не перезаписывает ключи, которые уже есть в process.env
    //   (даже пустые), так что второй рубеж держит и при случайно
    //   найденном .env. Пустой гейт != test.linkeon.io; пустой DATABASE_URL
    //   CLI считает отсутствующим и выходит с кодом 2 до подключения, даже
    //   если гейт пропустил.
    // Из-за последнего код 2 и пустой stdout одинаковы у отказа гейта и у
    // отказа по DATABASE_URL — поэтому каждый отказный кейс проверяет в
    // stderr именно synthetic_gates_not_met.
    // Кейсы, которым нужен гейт-env (fullGateEnv), переопределяют его через
    // spread. Полная тройка гейтов сюда не передаётся никогда.
    return spawnSync(process.execPath, [
      require.resolve('ts-node/dist/bin'),
      '-P', path.join(repo, 'tsconfig.json'),
      path.join(repo, 'scripts', 'account-deletion-synthetic.ts'),
      ...args,
    ], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        PATH: process.env.PATH ?? '',
        TS_NODE_TRANSPILE_ONLY: '1',
        [SYNTHETIC_GATE_ENV]: '',
        DATABASE_URL: '',
        DOTENV_CONFIG_PATH: '/nonexistent',
        ...env,
      },
    });
  }

  it('без флагов → exit 2, stdout пуст, в stderr — synthetic_gates_not_met', () => {
    const res = spawnCli([], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('synthetic_gates_not_met');
  }, 120_000);

  it('только --apply → exit 2, stdout пуст, в stderr — synthetic_gates_not_met', () => {
    const res = spawnCli([SYNTHETIC_APPLY_FLAG], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('synthetic_gates_not_met');
  }, 120_000);

  it('--apply + confirm без env-гейта → exit 2, stdout пуст, в stderr — synthetic_gates_not_met', () => {
    const res = spawnCli([SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG], {});
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('synthetic_gates_not_met');
  }, 120_000);

  it('флаги + env на чужом hostname → exit 2, stdout пуст, в stderr — synthetic_gates_not_met', () => {
    // На CI-ноде os.hostname() = ugliest-salmon.ptr.network — имя входит в
    // allow-list, поэтому там кейс пропускается: гейт hostname ветку не
    // закрыл бы, CLI отказал бы уже по пустому DATABASE_URL, и проверка
    // stderr ниже упала бы. До базы CLI не дошёл бы и без пропуска (пустой
    // DATABASE_URL — код 2 до подключения): пропуск и пустой DATABASE_URL —
    // двойная страховка.
    if (isSyntheticGateHostname(hostname())) return;
    const res = spawnCli(
      [SYNTHETIC_APPLY_FLAG, SYNTHETIC_CONFIRM_FLAG],
      fullGateEnv(),
    );
    expect(res.status).toBe(2);
    expect(res.stdout).toBe('');
    expect(res.stderr).toContain('synthetic_gates_not_met');
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

describe('env воркера вокруг синтетического тика — восстановление, а не удаление (ревью Task 25, п.6)', () => {
  const KEY = 'ACCOUNT_DELETION_WORKER_ENABLED';
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    saved = process.env;
    process.env = { ...saved };
  });

  afterEach(() => {
    process.env = saved;
  });

  it('прежнее false: внутри true, после — снова false (аварийный выключатель не снят)', async () => {
    process.env[KEY] = 'false';
    const inside = await withAccountDeletionWorkerEnabled(async () => process.env[KEY]);
    expect(inside).toBe('true');
    expect(process.env[KEY]).toBe('false');
  });

  it('прежде не задано: после — снова не задано (не пустая строка и не true)', async () => {
    delete process.env[KEY];
    await withAccountDeletionWorkerEnabled(async () => undefined);
    expect(KEY in process.env).toBe(false);
  });

  it('исключение внутри: значение восстановлено, ошибка проброшена', async () => {
    process.env[KEY] = ' Off ';
    await expect(withAccountDeletionWorkerEnabled(async () => {
      throw new Error('tick failed');
    })).rejects.toThrow('tick failed');
    expect(process.env[KEY]).toBe(' Off ');
  });

  it('restoreAccountDeletionWorkerEnv: undefined — удалить, иначе — присвоить прежнее', () => {
    process.env[KEY] = 'true';
    restoreAccountDeletionWorkerEnv(undefined);
    expect(KEY in process.env).toBe(false);
    restoreAccountDeletionWorkerEnv('0');
    expect(process.env[KEY]).toBe('0');
  });
});
