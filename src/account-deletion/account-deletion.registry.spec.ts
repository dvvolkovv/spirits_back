import { AccountDeletionRegistry } from './account-deletion.registry';
import { DELETION_RESOURCE_TYPES, SKIP_ONLY_RESOURCE_TYPES } from './account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionResourceType,
} from './account-deletion.types';

/**
 * Task 22.6 — контракт assertReady для прод-wiring-а.
 *
 * Синтетический e2e (Task 22) вскрыл прод-баг: 'calendar.external' и
 * 'video.provider' — skip-only типы. Discoverer'ы эмитируют по ним только
 * skips (video — 'unsupported_external', calendar — 'owner_unverifiable'),
 * а санитайзер (safeDeletionJobSnapshot) отклоняет JOB'ы этих типов
 * ('unsafe_resource_type') — задача никогда не создаётся и getExecutor для
 * них недостижим. Тем не менее assertReady() требовал исполнитель для
 * КАЖДОГО типа каталога, и ни один прод-адаптер эти два типа не
 * регистрирует → 'deletion_registry_not_ready' бросался ВСЕГДА →
 * deleteExplicit и stopOnly (merge-путь) были мертвы с момента деплоя.
 *
 * Контракт после фикса: assertReady требует исполнителей только для
 * несущих типов (каталог минус skip-only); getExecutor для
 * незарегистрированных типов — включая skip-only — по-прежнему бросает
 * 'deletion_executor_missing'. Skip-only имена зафиксированы литералами
 * И прибиты equality-assert-ом к SKIP_ONLY_RESOURCE_TYPES из safe.ts
 * (T22.6-minor): любое изменение множества — снятие типа или расширение —
 * становится сознательным обновлением спека, молча разойтись списки не могут.
 */

// Литеральная копия SKIP_ONLY_RESOURCE_TYPES (account-deletion.safe.ts);
// равенство с экспортом прибито первым тестом ниже.
const SKIP_ONLY_TYPES: readonly DeletionResourceType[] = [
  'calendar.external',
  'video.provider',
];

const loadBearingTypes = (): DeletionResourceType[] =>
  [...DELETION_RESOURCE_TYPES].filter(
    (resourceType) => !SKIP_ONLY_TYPES.includes(resourceType),
  );

const echoAdapter = (
  resourceTypes: readonly DeletionResourceType[],
): AccountDeletionAdapter => ({
  resourceTypes,
  execute: async () => undefined,
});

describe('AccountDeletionRegistry.assertReady — skip-only типы (T22.6)', () => {
  it('пин: литералы равны SKIP_ONLY_RESOURCE_TYPES из safe.ts (T22.6-minor)', () => {
    // Без этого assert-а РАСШИРЕНИЕ множества (третий skip-only тип) прошло бы
    // молча: спек счёл бы его load-bearing и сам зарегистрировал в реестре.
    expect([...SKIP_ONLY_RESOURCE_TYPES].sort()).toEqual([...SKIP_ONLY_TYPES].sort());
  });

  it('не требует исполнителей для skip-only типов', () => {
    // Санитарный контроль пинга: оба skip-only имени действительно в каталоге.
    for (const resourceType of SKIP_ONLY_TYPES) {
      expect(DELETION_RESOURCE_TYPES.has(resourceType)).toBe(true);
    }
    expect(loadBearingTypes()).toHaveLength(
      DELETION_RESOURCE_TYPES.size - SKIP_ONLY_TYPES.length,
    );

    const registry = new AccountDeletionRegistry();
    registry.register(echoAdapter(loadBearingTypes()));

    expect(() => registry.assertReady()).not.toThrow();

    // getExecutor не меняется: skip-only типы не зарегистрированы и остаются
    // недостижимыми — задача таких типов и не может возникнуть (санитайзер).
    expect(() => registry.getExecutor('calendar.external')).toThrow(
      'deletion_executor_missing',
    );
    expect(() => registry.getExecutor('video.provider')).toThrow(
      'deletion_executor_missing',
    );
  });

  it('контроль: пропуск несущего типа — deletion_registry_not_ready', () => {
    const registry = new AccountDeletionRegistry();
    registry.register(
      echoAdapter(
        loadBearingTypes().filter((resourceType) => resourceType !== 'routine.stop'),
      ),
    );

    expect(() => registry.assertReady()).toThrow('deletion_registry_not_ready');
  });
});
