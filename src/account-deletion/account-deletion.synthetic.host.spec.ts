import { createHash } from 'crypto';
import * as synthetic from './account-deletion.synthetic';
import {
  cleanupSyntheticFixture,
  seedSyntheticFixture,
  SYNTHETIC_DELETION_PREFIX,
  SYNTHETIC_HIST_PHONE,
  SYNTHETIC_MAIN_PHONE,
  SYNTHETIC_OTHER_ID,
  SYNTHETIC_RESTART_PHONE,
} from './account-deletion.synthetic';
import type { SyntheticStack } from './account-deletion.synthetic';

/**
 * Синтетический хост продуктов: посев заводит СВОЙ хост, cleanup его убирает.
 *
 * Зачем: synthetic (Gate B) идёт против живой базы стенда test.linkeon.io, где
 * в product_hosts — только боевой хост стенда. Раньше посев клал туда
 * 'host-shared' (audience 'clients', accepts_new по умолчанию true) через
 * ON CONFLICT DO NOTHING, а cleanup хосты не трогал: после прогона на стенде
 * оставалась фиктивная машина, которую pickForNewProduct выбрал бы для
 * клиентских продуктов, и она же сдвигала счётчики реестра (HostGuard,
 * noRoom).
 *
 * Проверяется без базы: стек с записывающим фейком pg. pg-спек на ноде
 * без PROVISIONING_PG_URL пропускается, а этот — нет.
 *
 * Ожидаемый id — по префиксу фикстур; экспорт SYNTHETIC_HOST_ID читается
 * через namespace, чтобы отсутствие экспорта было красным кейсом, а не
 * ошибкой компиляции всего файла.
 */

const HOST_ID = `${SYNTHETIC_DELETION_PREFIX}host`;
const USER_IDS = [SYNTHETIC_MAIN_PHONE, SYNTHETIC_OTHER_ID, SYNTHETIC_HIST_PHONE, SYNTHETIC_RESTART_PHONE];

type Call = { sql: string; params: unknown[] };

function recordingPg(opts: { failAll?: boolean } = {}) {
  const calls: Call[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (opts.failAll) throw new Error('relation does not exist');
      return { rows: [], rowCount: 0 };
    }),
  };
  return { calls, pg };
}

function fakeStack(pg: unknown): SyntheticStack {
  return {
    pg,
    hostAgentScope: new Set<string>(),
    identity: { resolveOrCreate: jest.fn(async () => ({ status: 'ok' })) },
    seedHistoryRow: jest.fn(async () => undefined),
  } as unknown as SyntheticStack;
}

/** Колонка → значение для однострочного INSERT … (cols) VALUES (vals). */
function insertValues(call: Call): Record<string, unknown> {
  const m = /INSERT INTO\s+\w+\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/i.exec(call.sql);
  if (!m) throw new Error(`не однострочный INSERT: ${call.sql.slice(0, 60)}`);
  const cols = m[1].split(',').map((s) => s.trim());
  const vals = m[2].split(',').map((s) => s.trim());
  expect(vals).toHaveLength(cols.length);
  const out: Record<string, unknown> = {};
  cols.forEach((col, i) => {
    const v = vals[i];
    const param = /^\$(\d+)$/.exec(v);
    if (param) out[col] = call.params[Number(param[1]) - 1];
    else if (/^'.*'$/.test(v)) out[col] = v.slice(1, -1);
    else if (/^(true|false)$/i.test(v)) out[col] = v.toLowerCase() === 'true';
    else if (/^-?\d+$/.test(v)) out[col] = Number(v);
    else out[col] = v;
  });
  return out;
}

const indexOf = (calls: Call[], re: RegExp, withParam?: unknown): number =>
  calls.findIndex((c) => re.test(c.sql) && (withParam === undefined || c.params.includes(withParam)));

const lastIndexOf = (calls: Call[], re: RegExp): number => {
  for (let i = calls.length - 1; i >= 0; i -= 1) if (re.test(calls[i].sql)) return i;
  return -1;
};

describe('синтетический хост продуктов — свой id и уборка', () => {
  it('экспортирует SYNTHETIC_HOST_ID с префиксом фикстур', () => {
    expect((synthetic as unknown as Record<string, unknown>).SYNTHETIC_HOST_ID).toBe(HOST_ID);
  });

  describe('cleanupSyntheticFixture', () => {
    async function runCleanup(opts: { failAll?: boolean } = {}) {
      const { calls, pg } = recordingPg(opts);
      await cleanupSyntheticFixture(fakeStack(pg), { deletionIds: [], userIds: USER_IDS });
      return calls;
    }

    it('удаляет синтетический хост — ПОСЛЕ всех удалений products', async () => {
      const calls = await runCleanup();
      const hostIdx = indexOf(calls, /DELETE FROM product_hosts\b/, HOST_ID);
      expect(hostIdx).toBeGreaterThanOrEqual(0);
      // products.host_id → product_hosts без ON DELETE: пока на хосте есть
      // продукт, удаление хоста упадёт.
      expect(hostIdx).toBeGreaterThan(lastIndexOf(calls, /DELETE FROM products\b/));
      // product_host_agent — CASCADE от хоста, но убирается явно и раньше.
      const agentIdx = indexOf(calls, /DELETE FROM product_host_agent\b/, HOST_ID);
      expect(agentIdx).toBeGreaterThanOrEqual(0);
      expect(agentIdx).toBeLessThan(hostIdx);
    });

    it('удаляет продукты на синтетическом хосте независимо от user_id', async () => {
      const calls = await runCleanup();
      const byHost = indexOf(calls, /DELETE FROM products WHERE host_id = \$1/, HOST_ID);
      expect(byHost).toBeGreaterThanOrEqual(0);
      expect(byHost).toBeLessThan(indexOf(calls, /DELETE FROM product_hosts\b/, HOST_ID));
    });

    it('журнал product_actions (FK SET NULL) убирается ДО products, включая продукты хоста', async () => {
      const calls = await runCleanup();
      const actionsIdx = indexOf(calls, /DELETE FROM product_actions\b/, HOST_ID);
      expect(actionsIdx).toBeGreaterThanOrEqual(0);
      expect(calls[actionsIdx].params).toContainEqual(USER_IDS);
      expect(actionsIdx).toBeLessThan(indexOf(calls, /DELETE FROM products\b/));
    });

    it('сбой каждой группы не мешает дойти до удаления хоста', async () => {
      const calls = await runCleanup({ failAll: true });
      expect(indexOf(calls, /DELETE FROM product_hosts\b/, HOST_ID)).toBeGreaterThanOrEqual(0);
    });
  });

  describe('seedSyntheticFixture', () => {
    async function runSeed() {
      const { calls, pg } = recordingPg();
      await seedSyntheticFixture(fakeStack(pg));
      return calls;
    }

    it('не заводит и не использует общий host-shared', async () => {
      const calls = await runSeed();
      for (const c of calls) {
        expect(c.sql).not.toContain('host-shared');
        expect(c.params).not.toContain('host-shared');
      }
    });

    it('заводит свой хост закрытым для новых продуктов (accepts_new = false)', async () => {
      const calls = await runSeed();
      const inserts = calls.filter((c) => /INSERT INTO product_hosts\b/.test(c.sql));
      expect(inserts).toHaveLength(1);
      const row = insertValues(inserts[0]);
      expect(row.id).toBe(HOST_ID);
      expect(row.accepts_new).toBe(false);
    });

    it('хеш токена агента хоста случайный на каждый посев, не от фикстурной строки', async () => {
      // Детерминированный хеш sha256('synthetic-deletion-host-agent-fixture')
      // вычисляет любой, кто читает публичный репозиторий; с прообразом в
      // руках HostGuard (сверяет sha256 токена с agent_token_hash) пропустил
      // бы запрос от имени синтетического хоста, пока его строка в базе.
      const tokenHash = (calls: Call[]): unknown => {
        const inserts = calls.filter((c) => /INSERT INTO product_hosts\b/.test(c.sql));
        expect(inserts).toHaveLength(1);
        return insertValues(inserts[0]).agent_token_hash;
      };
      const first = tokenHash(await runSeed());
      const second = tokenHash(await runSeed());
      const fixtureHash = createHash('sha256')
        .update(`${SYNTHETIC_DELETION_PREFIX}host-agent-fixture`)
        .digest('hex');
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toMatch(/^[0-9a-f]{64}$/);
      expect(first).not.toBe(second);
      expect(first).not.toBe(fixtureHash);
      expect(second).not.toBe(fixtureHash);
    });

    it('продукт посева стоит на синтетическом хосте', async () => {
      const calls = await runSeed();
      const inserts = calls.filter((c) => /INSERT INTO products\b/.test(c.sql));
      expect(inserts).toHaveLength(1);
      expect(insertValues(inserts[0]).host_id).toBe(HOST_ID);
    });
  });
});
