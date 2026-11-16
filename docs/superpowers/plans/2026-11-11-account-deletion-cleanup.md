# Account Deletion Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Немедленно останавливать работу явно удалённых и merge-loser аккаунтов, а через 30 дней необратимо очищать их личные ресурсы через persistent per-resource jobs с защитой от реактивации.

**Architecture:** Отдельный `account-deletion` core отвечает только за lifecycle, read-only planner, persistent jobs, lease/coordinator и безопасные ошибки; SQL и внешние операции остаются в доменных адаптерах. Явное удаление сохраняет текущий немедленный `account.core.immediate` после stop, merge-loser получает `account.core.purge` через 30 дней; identities survivor-а не затрагиваются. Dry-run вызывает тот же `collect` без Nest lifecycle, SQL-записей и внешних клиентов.

**Tech Stack:** NestJS 10, TypeScript 5, PostgreSQL 16 (`pg`, raw SQL), Jest/ts-jest, AWS S3 SDK, существующие product host-agent, Telegram Grammy, Attendee, LiveKit и ElevenLabs adapters.

**Spec:** `docs/superpowers/specs/2026-11-11-account-deletion-cleanup-design.md`, commit `6654411c29383bc342f3cd427f9185dcc8b30aab`.

---

## Обязательные условия выполнения

- Работа только в `/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup`, ветка `feat/account-deletion-cleanup`; baseline `origin/main=e57f4f09e81021205211b68617414968d3518012`.
- Тесты, tsc и сборки — только на `dv@85.192.61.231`, отдельное дерево `~/ci/wt/account-deletion-cleanup`; всегда `source ~/.nvm/nvm.sh`, `npm ci`, `--maxWorkers=2`, checkout по точному SHA. Не трогать `~/spirits_back`, `~/spirits_front`, `~/dev` и рабочее дерево `~/ci/spirits_back`, кроме `fetch`/`worktree add`.
- На маке не запускать Jest, tsc или build. `product-runner` тесты тоже только на ноде.
- Каждая функциональная задача: RED test commit/push → подтверждённый FAIL на ноде → минимальная реализация → GREEN commit/push → подтверждённый PASS. Все коммиты, включая RED, содержат trailer `Co-Authored-By: Claude Code <noreply@anthropic.com>`. Не использовать amend, force-push или rebase.
- **После каждой функциональной задачи контроллер обязан провести два отдельных ревью: (1) соответствие спецификации и задаче, (2) качество и безопасность кода. Переход без обоих ревью запрещён.** Это требование контроллеру, а не шаг исполнителя.
- Репозиторий публичный. В тестах использовать `u-deleted`, `u-survivor`, UUID и маркеры `ЛИЧНЫЙ-ТЕКСТ`, `СЕКРЕТ-НЕ-ЛОГИРОВАТЬ`; не использовать реальные телефоны, токены или секреты.
- Любые live migrations, `deploy.sh`, synthetic apply на test, prod dry-run и worker activation выполняются только в явно обозначенных задачах и только после отдельного OK владельца на конкретное действие. До Task 23 таких действий нет. Прямые SSH/docker-операции coordinator, ручной `pm2 restart`, ручное редактирование серверных файлов и обход `deploy.sh` запрещены всегда.
- Не включать исторические `state='deleted'` с NULL-полями. Не добавлять custom-agent versions/replicas, UI, новые продуктовые возможности или изменения биллинга.

## Карта файлов и границы

| Файл/каталог | Ответственность |
|---|---|
| `src/account-deletion/migrations/001_account_deletion.sql` | `user_id.deleted_at/deletion_id`, `account_deletion_jobs`, индексы; без backfill |
| `src/account-deletion/account-deletion.types.ts` | Единые job/payload/adapter/planner типы |
| `src/account-deletion/account-deletion.safe.ts` | Allowlist ошибок, payload/log guards, retry backoff |
| `src/account-deletion/account-deletion.planner.ts` | Read-only `collect`, пишущий `persist`, dependency metadata |
| `src/account-deletion/account-deletion.jobs.ts` | Atomic claim/lease/retry/done/cancel, keyset выбор аккаунтов |
| `src/account-deletion/account-deletion.coordinator.ts` | Hourly cron, advisory lock, disabled-by-default flag |
| `src/account-deletion/account-deletion.lifecycle.ts` | `begin`, stop, explicit finalize, merge sequencing |
| `src/account-deletion/account-deletion.registry.ts` | Runtime executors; core не импортирует доменные Nest modules |
| `src/{routine-push,tg-bot,products,calendar,integrations,voice-call,chat,voice-avatar,events,tasks,support,peer,contacts,referral,retention,backup,devices,guest-trial,identity,misc,profile}/*account-deletion*` | Discovery и выполнение только своего домена |
| `scripts/account-deletion-dry-run.ts` | Только read-only planner и JSON-количества |
| `scripts/account-deletion-synthetic.ts` | Только test-node synthetic lifecycle с двумя явными apply-подтверждениями |
| `src/platform-kb/articles/account.ts`, `src/platform-kb/values.ts` | Публичная политика до любого включения |

**Module wiring в соответствующей доменной задаче обязателен:** `src/app.module.ts` импортирует `AccountDeletionModule` в Task 4. Каждый доменный module импортирует core и регистрирует свой adapter в `providers`: `routine-push/routine-push.module.ts`, `tg-bot/tg-bot.module.ts`, `products/products.module.ts`, `calendar/calendar.module.ts`, `integrations/integrations.module.ts`, `voice-call/voice-call.module.ts`, `chat/chat.module.ts`, `misc/misc.module.ts`, `video/video.module.ts`, `speech/speech.module.ts`, `avatar/avatar.module.ts`, `voice-avatar/voice-avatar.module.ts`, `events/events.module.ts`, `tasks/tasks.module.ts`, `support/support.module.ts`, `peer/peer.module.ts`, `contacts/contacts.module.ts`, `referral/referral.module.ts`, `retention/retention.module.ts`, `backup/backup.module.ts`, `devices/devices.module.ts`, `guest-trial/guest-trial.module.ts`, `identity/identity.module.ts`, `profile/profile.module.ts`. Push adapter регистрируется в `routine-push.module.ts`, Contacts adapter — в `contacts.module.ts`, legacy SMM — в `misc.module.ts`. В `git add` каждой задачи включаются перечисленные module files; забытый provider ловится `registry.assertReady()` и PG lifecycle test, а не обнаруживается на prod.

## Единый coordinator contract

```typescript
export type DeletionOrigin = 'explicit' | 'merge';
export type DeletionPhase = 'immediate' | 'purge';
export type DeletionErrorKind =
  | 'timeout' | 'external_5xx' | 'external_4xx' | 'not_found'
  | 'permission' | 'rate_limited' | 'db' | 'external_unknown'
  | 'owner_unverifiable' | 'unsupported_external' | 'cancelled';

export interface DeletionJobSpec {
  resourceType: string;
  resourceKey: string;
  phase: DeletionPhase;
  payload: Record<string, unknown>;
}
export interface DeletionAccount {
  userId: string;
  deletionId: string;
  deletedAt: Date;
}
export interface DeletionDiscovery {
  account: DeletionAccount;
  origin: DeletionOrigin;
  db: { query(sql: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }> };
}
export interface DeletionSkip { resourceType: string; reason: string }
export interface DeletionPlan { jobs: DeletionJobSpec[]; skips: DeletionSkip[] }
export interface DeletionJobRow extends DeletionJobSpec {
  id: string;
  deletionId: string;
  userId: string;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  attempts: number;
  nextAttemptAt: Date;
  leaseUntil: Date | null;
  lastErrorKind: DeletionErrorKind | null;
}
export interface DeletionExecution {
  db: DeletionDiscovery['db'];
  assertCurrent(job: DeletionJobRow): Promise<void>;
}
export interface AccountDeletionAdapter {
  readonly resourceTypes: readonly string[];
  execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void>;
}
export type DeletionDiscoverer = (ctx: DeletionDiscovery) => Promise<DeletionPlan>;
```

`resourceKey` — UUID/хэш/короткая техническая константа, не `userId`. Для MinIO `resourceKey=sha256(bucket+'\0'+key)`; payload может содержать allowlisted MinIO key, но не message text, `FoundFile`, prompt, token, secret, `userId`, credentials URL или `composed_plan`. Ключи, выводимые из `userId` (avatar, legacy voice document, video upload), в payload не дублируются: адаптер вычисляет их из `job.userId` либо читает сохранённую доменную строку до её удаления.

`DELETION_DEPENDENCIES`: `account.core.*` ждёт все `*.stop`; `product.purge` ждёт свой `product.stop`; `custom-agent.purge` — все `telegram.purge`; `voice.purge` — свой `voice.stop` и все `voice-document.purge`; остальные purge-задачи независимы, чтобы один сбой не блокировал другие домены.

---

## Фаза 0 — изолированный CI и baseline

### Task 0: CI-дерево и baseline

**Files:** репозиторий не изменяется.

- [ ] **Step 1: Создать изолированное дерево на ноде**

```bash
ssh -n dv@85.192.61.231 'git -C ~/ci/spirits_back fetch -q origin && if [ ! -e ~/ci/wt/account-deletion-cleanup/.git ]; then git -C ~/ci/spirits_back worktree add -q --detach ~/ci/wt/account-deletion-cleanup 6654411c29383bc342f3cd427f9185dcc8b30aab; fi && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach 6654411c29383bc342f3cd427f9185dcc8b30aab && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npm ci --no-audit --no-fund && printf "CI_READY\n"'
```

Expected: `CI_READY`, Node 22, чистое дерево на spec SHA.

- [ ] **Step 2: Снять unit baseline**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest --runTestsByPath src/profile/account-deletion.spec.ts src/profile/session-prefix-like.spec.ts src/identity/identity.link-candidate.spec.ts src/identity/identity.is-deleted.spec.ts src/auth/refresh-deleted.spec.ts src/tg-bot/tg-config.private.spec.ts src/routine-push/routine-push.busy-retry.spec.ts src/routine-push/routine-push.linkeon-tools.spec.ts src/routine-push/routine-failure.spec.ts src/push/push.ssrf.spec.ts src/products/product-lifecycle.service.spec.ts src/products/product-purge.service.spec.ts src/products/block.service.spec.ts src/calendar/calendar.service.spec.ts src/talerid/talerid-oauth.service.spec.ts src/voice-call/voice-call.service.spec.ts src/voice-call/voice-call-reaper.spec.ts src/meeting/attendee.client.spec.ts src/chat/chat-files/extract.spec.ts src/chat/chat-files/chat-files.search.spec.ts src/voice-avatar/voice-avatar.service.spec.ts src/platform-kb/kb.spec.ts --maxWorkers=2 && printf "BASELINE_UNIT_OK\n"'
```

Expected: все перечисленные suites PASS и `BASELINE_UNIT_OK`. При красном baseline остановиться; дальнейшие задачи не маскируют чужие падения.

- [ ] **Step 3: Снять PG baseline в одноразовых БД**

Каждый PG suite запускается в собственной fresh БД: часть product migrations создаёт enum/type заново, поэтому общая БД для всех suites даёт ложный `pg_type_typname_nsp_index`.

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_base_$(date +%s)_$$ && createdb -h /var/run/postgresql "$DB" && trap "dropdb -h /var/run/postgresql --if-exists \"$DB\"" EXIT && PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest --runTestsByPath src/identity/identity.unlink.pg.spec.ts src/tg-bot/tg-config.private.pg.spec.ts src/products/product-lifecycle.pg.spec.ts --maxWorkers=2 && printf "BASELINE_PG_OK\n"'
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_purge_base_$(date +%s)_$$ && createdb -h /var/run/postgresql "$DB" && trap "dropdb -h /var/run/postgresql --if-exists \"$DB\"" EXIT && PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest --runTestsByPath src/products/product-purge.pg.spec.ts --maxWorkers=2 && printf "BASELINE_PURGE_PG_OK\n"'
```

Expected: PG suites именно PASS, не skipped; `BASELINE_PG_OK` и `BASELINE_PURGE_PG_OK`.

- [ ] **Step 4: Снять type/build baseline и зафиксировать правило delta**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && npm run build && printf "BASELINE_BUILD_OK\n"'
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.json --noEmit > /tmp/account-deletion-tsc-baseline.log 2>&1; rc=$?; printf "BROAD_TSC_BASELINE_EXIT=%s ERRORS=%s\n" "$rc" "$(grep -c "error TS" /tmp/account-deletion-tsc-baseline.log || true)"'
```

Expected: `BASELINE_BUILD_OK`. На исходном `6654411c` широкий `tsconfig.json` имеет 172 исторические ошибки в unrelated tests/voice-host/product-runner; владелец 11.11 подтвердил продолжение с production gate и normalized delta, а не исправлением чужих ошибок. Финальная проверка сравнивает нормализованный набор ошибок с этим baseline: новых ошибок быть не должно, старый набор не объявляется регрессией feature. Контроллер сохраняет команды, SHA и сводки как baseline; никаких live apply/deploy.

---

## Фаза 1 — схема, безопасный planner и persistent coordinator

### Task 1: Миграция lifecycle и persistent jobs

**Files:**
- Create: `src/account-deletion/migrations/001_account_deletion.sql`
- Create: `src/account-deletion/account-deletion.schema.ts`
- Create: `src/account-deletion/account-deletion.schema.pg.spec.ts`

- [ ] **Step 1: Написать failing PG test**

```typescript
import { Pool } from 'pg';
import { readFileSync } from 'fs';

const PG = process.env.PROVISIONING_PG_URL;
(PG ? describe : describe.skip)('account deletion schema', () => {
  it('создаёт generation и jobs, не заполняя исторический deleted', async () => {
    const pool = new Pool({ connectionString: PG });
    await pool.query(`CREATE TABLE user_id (internal_id text PRIMARY KEY, state text, update_date timestamptz DEFAULT now())`);
    await pool.query(`INSERT INTO user_id VALUES ('u-historical', 'deleted', now())`);
    const sql = readFileSync('src/account-deletion/migrations/001_account_deletion.sql', 'utf8');
    await pool.query('BEGIN');
    await pool.query(sql);
    await pool.query('COMMIT');
    await pool.query(sql);
    const user = await pool.query(`SELECT deleted_at, deletion_id FROM user_id WHERE internal_id='u-historical'`);
    expect(user.rows[0]).toEqual({ deleted_at: null, deletion_id: null });
    const deletionId = '11111111-1111-1111-1111-111111111111';
    await pool.query(`INSERT INTO account_deletion_jobs (deletion_id,user_id,resource_type,resource_key,phase) VALUES ($1,'u-1','chat-file.purge','a','purge')`, [deletionId]);
    await expect(pool.query(`INSERT INTO account_deletion_jobs (deletion_id,user_id,resource_type,resource_key,phase) VALUES ($1,'u-1','chat-file.purge','a','purge')`, [deletionId])).rejects.toMatchObject({ code: '23505' });
    await pool.query('DROP TABLE account_deletion_jobs, user_id');
    await pool.end();
  });
});
```

Внешний `trap` команды прогона дополнительно удаляет одноразовую БД даже при падении test.

- [ ] **Step 2: Commit/push RED**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.schema.pg.spec.ts
git -C "$WT" commit -m "test(privacy): схема deletion generation и jobs (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_red_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \"\$DB\" && trap 'dropdb -h /var/run/postgresql --if-exists \"\$DB\"' EXIT && PROVISIONING_PG_URL=\"postgres:///\$DB?host=/var/run/postgresql\" npx jest src/account-deletion/account-deletion.schema.pg.spec.ts --maxWorkers=2"
```

Expected: FAIL `ENOENT: no such file or directory, open 'src/account-deletion/migrations/001_account_deletion.sql'`.

- [ ] **Step 3: Добавить минимальную миграцию и startup loader**

```sql
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='user_id' AND column_name='deleted_at') THEN
    ALTER TABLE user_id ADD COLUMN deleted_at timestamptz NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='user_id' AND column_name='deletion_id') THEN
    ALTER TABLE user_id ADD COLUMN deletion_id uuid NULL;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS account_deletion_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deletion_id uuid NOT NULL,
  user_id text NOT NULL,
  resource_type text NOT NULL,
  resource_key text NOT NULL,
  phase text NOT NULL CHECK (phase IN ('immediate','purge')),
  payload_jsonb jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload_jsonb)='object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz NULL,
  last_error_kind text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz NULL,
  UNIQUE (deletion_id, resource_type, resource_key)
);

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='user_id_deletion_due_idx') THEN
    CREATE INDEX user_id_deletion_due_idx ON user_id (deleted_at, internal_id)
      WHERE state='deleted' AND deletion_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='user_id_deletion_id_uidx') THEN
    CREATE UNIQUE INDEX user_id_deletion_id_uidx ON user_id (deletion_id) WHERE deletion_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND indexname='account_deletion_jobs_claim_idx') THEN
    CREATE INDEX account_deletion_jobs_claim_idx ON account_deletion_jobs (next_attempt_at, id)
      WHERE status IN ('pending','failed','running');
  END IF;
END
$migration$;
```

`AccountDeletionSchemaService.onModuleInit()` загружает SQL через `path.join(__dirname,'migrations','001_account_deletion.sql')` с fallback `path.join(__dirname,'..','..','src','account-deletion','migrations','001_account_deletion.sql')`, затем выполняет `inTransaction(this.pg, async (tx) => { await tx.query('SELECT pg_advisory_xact_lock(1947433921)'); await tx.query("SET LOCAL lock_timeout='5s'"); await tx.query(sql); })`. Никаких `UPDATE ... deleted_at` для существующих строк.

- [ ] **Step 4: Commit/push GREEN и прогнать PG test**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/migrations/001_account_deletion.sql src/account-deletion/account-deletion.schema.ts src/account-deletion/account-deletion.schema.pg.spec.ts
git -C "$WT" commit -m "feat(privacy): схема очистки удалённых аккаунтов" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_green_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \"\$DB\" && trap 'dropdb -h /var/run/postgresql --if-exists \"\$DB\"' EXIT && PROVISIONING_PG_URL=\"postgres:///\$DB?host=/var/run/postgresql\" npx jest src/account-deletion/account-deletion.schema.pg.spec.ts --maxWorkers=2 && printf 'SCHEMA_GREEN_OK\n'"
```

Expected: повторное применение PASS, historical NULL, duplicate job `23505`, `SCHEMA_GREEN_OK`.

---

### Task 2: Безопасные contracts, ошибки и backoff

**Files:**
- Create: `src/account-deletion/account-deletion.types.ts`
- Create: `src/account-deletion/account-deletion.safe.ts`
- Create: `src/account-deletion/account-deletion.safe.spec.ts`

- [ ] **Step 1: RED — secret/userId canaries и границы backoff**

```typescript
import { assertSafeJobSpec, retryDelayMs, safeDeletionMessage } from './account-deletion.safe';

describe('account deletion safety', () => {
  it('не допускает личные данные и секреты в payload/log', () => {
    expect(() => assertSafeJobSpec({ resourceType:'chat-file.purge', resourceKey:'abc', phase:'purge', payload:{ text:'ЛИЧНЫЙ-ТЕКСТ' } }, '79000000001')).toThrow('unsafe_payload');
    expect(() => assertSafeJobSpec({ resourceType:'video-job.purge', resourceKey:'abc', phase:'purge', payload:{ key:'79000000001/source.mp4' } }, '79000000001')).toThrow('unsafe_payload');
    const line = safeDeletionMessage({ deletionId:'d-1', resourceType:'product.purge', resourceKey:'p-1', attempts:2, kind:'timeout' });
    expect(line).toBe('deletion=d-1 type=product.purge key=p-1 attempt=2 kind=timeout');
  });
  it('ограничивает экспоненту шестью часами', () => {
    expect([1,2,3,20].map(retryDelayMs)).toEqual([60_000,120_000,240_000,21_600_000]);
  });
});
```

- [ ] **Step 2: RED commit/push и запуск**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.safe.spec.ts
git -C "$WT" commit -m "test(privacy): безопасные payload и журналы (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest src/account-deletion/account-deletion.safe.spec.ts --maxWorkers=2"
```

Expected: FAIL `Cannot find module './account-deletion.safe'`.

- [ ] **Step 3: GREEN — полные чистые функции**

```typescript
import { createHash } from 'crypto';
import type { DeletionErrorKind, DeletionJobSpec } from './account-deletion.types';

export const ACCOUNT_DELETION_RETENTION_DAYS = 30;
export const ACCOUNT_DELETION_RETENTION_MS = ACCOUNT_DELETION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED = false;
const FORBIDDEN = new Set(['text','content','prompt','message','token','secret','secret_enc','password','userId','user_id','composed_plan']);
export function retryDelayMs(attempts: number): number {
  return Math.min(21_600_000, 60_000 * 2 ** Math.min(Math.max(attempts - 1, 0), 8));
}
export function deletionResourceHash(bucket: string, key: string): string {
  return createHash('sha256').update(`${bucket}\0${key}`).digest('hex');
}
export function assertSafeJobSpec(job: DeletionJobSpec, userId: string): void {
  const visit = (value: unknown, key?: string): void => {
    if (key && FORBIDDEN.has(key)) throw new Error('unsafe_payload');
    if (typeof value === 'string' && userId.length >= 6 && value.includes(userId)) throw new Error('unsafe_payload');
    if (Array.isArray(value)) value.forEach((item) => visit(item));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k,v]) => visit(v,k));
  };
  visit(job.payload);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(job.resourceKey)) throw new Error('unsafe_resource_key');
}
export function accountDeletionWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  if (env.ACCOUNT_DELETION_WORKER_ENABLED === 'false') return false;
  if (env.ACCOUNT_DELETION_WORKER_ENABLED === 'true') return true;
  return ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED;
}
export function safeDeletionMessage(i: { deletionId:string; resourceType:string; resourceKey:string; attempts:number; kind:DeletionErrorKind }): string {
  return `deletion=${i.deletionId} type=${i.resourceType} key=${i.resourceKey} attempt=${i.attempts} kind=${i.kind}`;
}
export function deletionErrorKind(e: any): DeletionErrorKind {
  if (e?.kind === 'cancelled') return 'cancelled';
  if (e?.code === 'ETIMEDOUT' || e?.name === 'TimeoutError') return 'timeout';
  if (e?.$metadata?.httpStatusCode === 404 || e?.response?.status === 404) return 'not_found';
  if (e?.response?.status === 429) return 'rate_limited';
  if (e?.response?.status === 401 || e?.response?.status === 403) return 'permission';
  if ((e?.response?.status ?? 0) >= 500) return 'external_5xx';
  if ((e?.response?.status ?? 0) >= 400) return 'external_4xx';
  if (typeof e?.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return 'db';
  return 'external_unknown';
}
```

`DeletionCancelledError` и `DeletionRetryError` содержат только `kind`, не provider message. `account-deletion.types.ts` содержит ровно contract из начала плана и literal union всех resource types из задач ниже.

- [ ] **Step 4: GREEN commit/push и запуск**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.types.ts src/account-deletion/account-deletion.safe.ts src/account-deletion/account-deletion.safe.spec.ts
git -C "$WT" commit -m "feat(privacy): безопасные deletion contracts" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest src/account-deletion/account-deletion.safe.spec.ts --maxWorkers=2 && printf 'SAFETY_GREEN_OK\n'"
```

Expected: `SAFETY_GREEN_OK`; canary отсутствует в ошибке и логе.

---

### Task 3: Один planner для apply и dry-run

**Files:**
- Create: `src/account-deletion/account-deletion.planner.ts`
- Create: `src/account-deletion/account-deletion.catalog.ts`
- Create: `src/account-deletion/account-deletion.jobs.ts`
- Create: `src/account-deletion/account-deletion.planner.pg.spec.ts`

- [ ] **Step 1: RED — повторный planner не дублирует и не перезаписывает payload**

```typescript
it('persist идемпотентен, collect не пишет и сохраняет последний external ID', async () => {
  const account = { userId:'u-deleted', deletionId:randomUUID(), deletedAt:new Date('2026-11-01T00:00:00Z') };
  const discovery = jest.fn(async () => ({ jobs:[{ resourceType:'elevenlabs-voice.purge',resourceKey:'voice-1',phase:'purge' as const,payload:{voiceId:'external-1'} }], skips:[] }));
  const planner = new AccountDeletionPlanner([discovery]);
  const first = await planner.collect(pg, account, 'merge');
  expect(first.jobs.some((j) => j.resourceType === 'account.core.purge')).toBe(true);
  expect(writes).toEqual([]);
  await planner.persist(pg, account, first);
  await pg.query(`UPDATE account_deletion_jobs SET payload_jsonb='{"voiceId":"external-retry"}'`);
  await planner.persist(pg, account, first);
  const rows = await pg.query(`SELECT payload_jsonb FROM account_deletion_jobs WHERE resource_type='elevenlabs-voice.purge'`);
  expect(rows.rows).toHaveLength(1);
  expect(rows.rows[0].payload_jsonb).toEqual({ voiceId:'external-retry' });
});
```

Дополнительные `it` в том же suite: `explicit` создаёт `account.core.immediate` с `next_attempt_at=now`, `merge` — `account.core.purge` с `deletedAt+30 days`; пустой discovery всё равно создаёт ровно один core job.

- [ ] **Step 2: RED commit/push и PG FAIL**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.planner.pg.spec.ts
git -C "$WT" commit -m "test(privacy): идемпотентный planner (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_planner_red_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \"\$DB\" && trap 'dropdb -h /var/run/postgresql --if-exists \"\$DB\"' EXIT && PROVISIONING_PG_URL=\"postgres:///\$DB?host=/var/run/postgresql\" npx jest src/account-deletion/account-deletion.planner.pg.spec.ts --maxWorkers=2"
```

Expected: FAIL `Cannot find module './account-deletion.planner'`.

- [ ] **Step 3: GREEN — collect/persist и runAt**

```typescript
export class AccountDeletionPlanner {
  constructor(private readonly discoverers: readonly DeletionDiscoverer[]) {}
  async collect(db: Db, account: DeletionAccount, origin: DeletionOrigin): Promise<DeletionPlan> {
    const jobs: DeletionJobSpec[] = [{
      resourceType: origin === 'explicit' ? 'account.core.immediate' : 'account.core.purge',
      resourceKey: 'account', phase: origin === 'explicit' ? 'immediate' : 'purge', payload: {},
    }];
    const skips: DeletionSkip[] = [];
    for (const discover of this.discoverers) {
      const part = await discover({ db, account, origin });
      for (const job of part.jobs) assertSafeJobSpec(job, account.userId);
      jobs.push(...part.jobs);
      skips.push(...part.skips);
    }
    return { jobs, skips };
  }
  async persist(db: Db, account: DeletionAccount, plan: DeletionPlan): Promise<void> {
    for (const job of plan.jobs) {
      const runAt = job.phase === 'purge' ? new Date(account.deletedAt.getTime() + ACCOUNT_DELETION_RETENTION_MS) : new Date();
      await db.query(`INSERT INTO account_deletion_jobs
        (deletion_id,user_id,resource_type,resource_key,phase,payload_jsonb,next_attempt_at)
        VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (deletion_id,resource_type,resource_key) DO NOTHING`,
        [account.deletionId,account.userId,job.resourceType,job.resourceKey,job.phase,JSON.stringify(job.payload),runAt]);
    }
  }
}
```

`account-deletion.catalog.ts` экспортирует `DELETION_DISCOVERERS` и `DELETION_DEPENDENCIES`; доменные задачи только добавляют свои pure discoverers. Dry-run никогда не вызывает `persist`. В `jobs.ts` реализовать `assertCurrent`: join `account_deletion_jobs` и `user_id`, требуя совпадение `job.deletionId`, `state='deleted'`, `status='running'`, `attempts` и lease; иначе `DeletionCancelledError`.

- [ ] **Step 4: GREEN commit/push и PG PASS**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.planner.ts src/account-deletion/account-deletion.catalog.ts src/account-deletion/account-deletion.jobs.ts src/account-deletion/account-deletion.planner.pg.spec.ts
git -C "$WT" commit -m "feat(privacy): read-only planner и persistent dedupe" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_planner_green_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \"\$DB\" && trap 'dropdb -h /var/run/postgresql --if-exists \"\$DB\"' EXIT && PROVISIONING_PG_URL=\"postgres:///\$DB?host=/var/run/postgresql\" npx jest src/account-deletion/account-deletion.planner.pg.spec.ts --maxWorkers=2 && printf 'PLANNER_GREEN_OK\n'"
```

Expected: два planner PASS, duplicate отсутствует, payload retry сохранён, `PLANNER_GREEN_OK`.

---

### Task 4: Hourly coordinator, lease и advisory lock

**Files:**
- Create: `src/account-deletion/account-deletion.registry.ts`
- Create: `src/account-deletion/account-deletion.runner.ts`
- Create: `src/account-deletion/account-deletion.coordinator.ts`
- Create: `src/account-deletion/account-deletion.module.ts`
- Modify: `src/account-deletion/account-deletion.jobs.ts`
- Create: `src/account-deletion/account-deletion.coordinator.pg.spec.ts`

- [ ] **Step 1: RED — expired lease, historical exclusion, failure isolation**

```typescript
it('после restart забирает expired lease, не выбирает historical и изолирует сбой', async () => {
  await insertDeleted('u-historical', null, null);
  const current = await insertDeleted('u-current', new Date('2026-10-01'), randomUUID());
  const first = await insertJob(current, 'calendar.stop', 'cal-1', { status:'running', attempts:1, leaseUntil:new Date(Date.now()-1000) });
  const second = await insertJob(current, 'routine.stop', 'r-1', { status:'pending', attempts:0 });
  const coordinator = makeCoordinator({ retentionMs:0, batchSize:1 });
  await coordinator.tick();
  expect((await job(first.id)).attempts).toBe(2);
  expect((await job(second.id)).status).toBe('done');
  expect(await jobsFor('u-historical')).toHaveLength(0);
  expect(logLines.join('\n')).not.toContain('u-current');
});
```

Второй тест делает `calendar.stop` adapter throw `{response:{status:503}}`: job получает `failed`, `last_error_kind='external_5xx'`, `next_attempt_at` ограничен backoff, а `routine.stop` всё равно `done`. Третий: два `tryAdvisoryLock` мока, второй возвращает `null` → второй tick не вызывает planner/adapters. Четвёртый: `ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED=false` и нет env → ни одного SQL.

- [ ] **Step 2: RED commit/push и PG FAIL**

Явно добавить coordinator spec, commit `test(privacy): lease coordinator и historical exclusion (красный)` с trailer, push и запустить PG suite на новом SHA. Expected: FAIL `Cannot find module './account-deletion.coordinator'`.

- [ ] **Step 3: GREEN — atomic claim и tick**

```typescript
export async function claimNext(db: Db, deletionId?: string): Promise<DeletionJobRow | null> {
  const r = await db.query(`UPDATE account_deletion_jobs j
    SET status='running',attempts=j.attempts+1,lease_until=now()+interval '5 minutes',updated_at=now()
    WHERE j.id=(SELECT c.id FROM account_deletion_jobs c
      JOIN user_id u ON u.internal_id=c.user_id AND u.state='deleted' AND u.deletion_id=c.deletion_id
      WHERE (($1::uuid IS NULL) OR c.deletion_id=$1)
        AND ((c.status IN ('pending','failed') AND c.next_attempt_at<=now())
          OR (c.status='running' AND c.lease_until<now()))
      ORDER BY c.next_attempt_at,c.id LIMIT 1 FOR UPDATE OF c SKIP LOCKED)
    RETURNING j.*`, [deletionId ?? null]);
  return r.rows[0] ? mapDeletionJob(r.rows[0]) : null;
}

@Cron('0 23 * * * *', { name:'account-deletion-coordinator' })
async tick(options: { retentionMs?:number; batchSize?:number } = {}): Promise<void> {
  if (!accountDeletionWorkerEnabled(process.env)) return;
  const lock = await this.pg.tryAdvisoryLock(1947433922);
  if (!lock) return;
  try {
    let after: [Date,string] | null = null;
    do {
      const accounts = await this.jobs.dueAccounts(after, options.batchSize ?? 50, options.retentionMs ?? ACCOUNT_DELETION_RETENTION_MS);
      for (const account of accounts) {
        const plan = await this.planner.collect(this.pg, account, await this.jobs.originOf(account));
        await this.planner.persist(this.pg, account, plan);
        await this.runner.runAccount(account.deletionId);
      }
      after = accounts.length ? [accounts.at(-1)!.deletedAt,accounts.at(-1)!.userId] : null;
    } while (after);
  } finally { await lock.release(); }
}
```

`dueAccounts` использует `(deleted_at,internal_id) > ($1,$2)`, `ORDER BY deleted_at,internal_id LIMIT $3` и строго `state='deleted' AND deletion_id IS NOT NULL AND deleted_at<=now()-retention`; недосрочные immediate jobs вызываются только напрямую из `AccountDeletionLifecycle`, а не hourly worker. `runAccount` проверяет dependencies до claim, запускает heartbeat `UPDATE account_deletion_jobs SET lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 AND deletion_id=$2 AND attempts=$3 AND status='running'` каждые 30 секунд, а finish/fail условны тем же token. Любой adapter error классифицируется без `e.message`; цикл продолжается со следующего ресурса.

`AccountDeletionModule` регистрирует schema/planner/jobs/runner/coordinator/registry как `@Global()` core, но не импортирует доменные modules. Доменные адаптеры регистрируются в registry в `onModuleInit`; `registry.assertReady()` перед первым реальным begin требует executor для каждого типа каталога.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Добавить ровно пять новых файлов и `jobs.ts`, commit `feat(privacy): persistent hourly deletion coordinator` с trailer, push, PG test coordinator + planner. Expected: `2 suites PASS`, expired lease reclaim, historical excluded, failed calendar не мешает routine, advisory overlap ничего не выполняет.

---

## Фаза 2 — немедленная остановка активной работы

### Task 5: Routines и push — stop, guards, purge

**Files:**
- Create: `src/routine-push/routine-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/routine-push/routine-store.service.ts:141-227`
- Modify: `src/routine-push/routine-push.service.ts:92-215`
- Modify: `src/push/push.service.ts:145-227`
- Modify: `src/routine-push/routine-push.busy-retry.spec.ts`
- Modify: `src/push/push.ssrf.spec.ts`

- [ ] **Step 1: RED — deleted account не генерирует и не создаёт ресурсы**

```typescript
it('retry после deleted не вызывает LLM/history/push, а purge не трогает соседа', async () => {
  state.set('u-deleted','deleted');
  await service.fireNow('u-deleted','routine-1');
  expect(chat.generateAgentReply).not.toHaveBeenCalled();
  expect(push.sendPush).not.toHaveBeenCalled();
  expect(db.history).toHaveLength(0);
  await adapter.execute(job('routine.purge','routine-1'), ctx('u-deleted'));
  expect(db.routines.map((r) => r.userId)).toEqual(['u-other']);
});
it('deleted не может создать subscription, retry после регенерации не пишет history', async () => {
  state.set('u-deleted','deleted');
  await pushService.subscribe('u-deleted', subscription);
  expect(db.subscriptions).toHaveLength(0);
  chat.generateAgentReply.mockImplementation(async () => { state.set('u-deleted','deleted'); return 'готово'; });
  await service.fireNow('u-deleted','routine-1');
  expect(db.history).toHaveLength(0);
  expect(push.sendPush).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: RED commit/push и focused FAIL**

Добавить оба adapter spec и изменённые existing specs, commit `test(privacy): остановка routines и push (красный)` с trailer, push, запустить `src/routine-push src/push --maxWorkers=2`. Expected: FAIL отсутствует active-account fence.

- [ ] **Step 3: GREEN — SQL fence на каждом входе и после LLM**

```sql
-- listEnabled
SELECT r.id,r.user_id,r.title,r.assistant_id,r.prompt,r.send_hour,r.tz,r.days,r.last_sent_date
FROM routine_pushes r JOIN user_id u ON u.internal_id=r.user_id AND u.state='active'
WHERE r.enabled=true;
-- claimToday
UPDATE routine_pushes r SET last_sent_date=$2,updated_at=now()
WHERE r.id=$1 AND r.enabled=true AND r.last_sent_date IS DISTINCT FROM $2
  AND EXISTS (SELECT 1 FROM user_id u WHERE u.internal_id=r.user_id AND u.state='active')
RETURNING r.id;
-- history после generateAgentReply
INSERT INTO custom_chat_history (session_id,sender_type,agent,content,message_type)
SELECT $1,'ai',$2,$3,'text' WHERE EXISTS
  (SELECT 1 FROM user_id WHERE internal_id=$4 AND state='active');
```

`deliver` дополнительно вызывает strict `accountIsActive` до генерации и перед `sendPush`; `scheduleRetry`, `fireNow`, `create/update`, `subscribe/registerNative/sendPush` используют тот же SQL predicate. `routine-account-deletion.adapter.ts` discover создаёт `routine.stop/purge` по каждому ID и один `push.purge` при наличии subscriptions. Stop делает `UPDATE routine_pushes SET enabled=false WHERE id/user_id` с `EXISTS state/deletion_id`, затем `clearRetryTimersForUser`; purge удаляет только `id+user_id` после `assertCurrent`. Push purge удаляет `WHERE user_id`, не сохраняя endpoint в payload. Все destructive SQL содержат deletion predicate.

- [ ] **Step 4: GREEN commit/push и focused PASS**

`git add` ровно файлы задачи, commit `feat(privacy): остановка и очистка routines/push` с trailer, push; на ноде `npx jest src/routine-push src/push src/account-deletion --maxWorkers=2`. Expected: PASS, повторный execute не меняет чужие строки, disabled worker не вызывается.

---

### Task 6: Telegram/custom assistants — strict archive и FK-safe purge

**Files:**
- Create: `src/tg-bot/tg-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/tg-bot/tg-config.service.ts:94-135,201-214,301-377`
- Modify: `src/tg-bot/tg-identity.service.ts:46-94`
- Modify: `src/tg-bot/tg-video-dispatch.service.ts:40-112`
- Modify: `src/custom-agents/custom-agents.service.ts:118-136` (только комментарий о неприменимости normal remove к purge)
- Create: `src/custom-agents/custom-agents.account-deletion.spec.ts`

- [ ] **Step 1: RED — archive failure retry и FK порядок**

```typescript
it('timeout leaveChat сохраняет chat ID и не помечает stop done', async () => {
  grammy.leaveChat.mockRejectedValue({ code:'ETIMEDOUT' });
  await expect(adapter.execute(stopJob, ctx)).rejects.toMatchObject({ kind:'timeout' });
  expect(stopJob.payload).toEqual({ chatId:'-100200' });
  expect(db.configs[0].status).toBe('archived');
  expect(db.configs[0].id).toBe('cfg-1');
});
it('purge: tokens/messages/configs до custom_agents, admin agents и versions сохраняются', async () => {
  await adapter.execute(customAgentJob, ctx);
  expect(db.customAgents).toHaveLength(1);
  await adapter.execute(configPurgeJob, ctx);
  await adapter.execute(customAgentJob, ctx);
  expect(db.claimTokens).toHaveLength(0);
  expect(db.messages).toHaveLength(0);
  expect(db.customAgents).toHaveLength(0);
  expect(db.adminAgents).toHaveLength(1);
  expect(db.agentVersions).toHaveLength(1);
});
```

Добавить тесты: `consumeAuthToken` для deleted → `BadRequestException`; `reissueClaim/ensurePrivateConfig` не воскрешают config; TG video selection исключает archived/deleted, а уже выбранная строка повторно проверяется перед `axios.get` и `sendVideo`; чужая group config и её история остаются.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): strict TG archive и purge порядок (красный)` с trailer, push, запустить `src/tg-bot src/custom-agents`. Expected: FAIL stop возвращает success несмотря на timeout, custom agent блокируется archived FK, deleted token проходит.

- [ ] **Step 3: GREEN — archiveForAccountDeletion и purge**

```typescript
async archiveForAccountDeletion(id: string, ownerId: string, chatId: string | null): Promise<void> {
  await this.pg.query(`UPDATE tg_bot_configs c SET status='archived',archived_at=COALESCE(archived_at,now())
    WHERE c.id=$1 AND c.owner_user_id=$2 AND EXISTS
      (SELECT 1 FROM user_id u WHERE u.internal_id=c.owner_user_id AND u.state='deleted' AND u.deletion_id=$3)`, [id,ownerId,currentDeletionId]);
  if (!chatId) return;
  try { await this.grammy.leaveChat(Number(chatId)); }
  catch (e:any) {
    if ([400,403,404].includes(e?.response?.status) && isAlreadyAbsentTelegram(e)) return;
    throw new DeletionRetryError(deletionErrorKind(e));
  }
}
```

`currentDeletionId` передаётся параметром метода, не хранится в service. Discovery сохраняет только `{chatId}`; tokens немедленно `consumed_at=now`, pending video → `delivery_status='failed', delivery_error='account_deleted'`. `tg-video-dispatch` использует `JOIN tg_bot_configs c ON c.id=tg.config_id AND c.status IN ('active','silent')` и `JOIN user_id u ON u.internal_id=vj.user_id AND u.state='active'`, затем тот же predicate перед внешней отправкой.

Purge в одном transaction: `DELETE tg_claim_tokens WHERE owner_user_id`, `DELETE tg_bot_messages WHERE config_id`, `DELETE tg_bot_configs WHERE id+owner`, затем отдельный custom-agent job удаляет `custom_agents WHERE id+owner_user_id AND NOT EXISTS (SELECT 1 FROM tg_bot_configs WHERE custom_agent_id=id)`. Каждый statement проверяет deletion generation; `agents/agent_versions` не затрагиваются SQL вообще.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): безопасная остановка и очистка Telegram/custom assistants` с trailer, push; `npx jest src/tg-bot src/custom-agents src/account-deletion --maxWorkers=2`. Expected: PASS, повторный purge идемпотентен, leave timeout остаётся retry.

---

### Task 7: Products — немедленный forced archive через существующий host-agent

**Files:**
- Create: `src/products/product-forced-stop.ts`
- Create: `src/products/product-account-deletion.service.ts`
- Create: `src/products/product-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/products/product-account-deletion.pg.spec.ts`
- Modify: `src/products/block.service.ts:294-350` (использовать extracted helper без изменения admin behavior)
- Modify: `src/products/product-lifecycle.service.ts:580-887`
- Modify: `src/products/turns.service.ts:297-320`
- Modify: `src/products/products.module.ts`

- [ ] **Step 1: RED — running/provisioning/blocked останавливаются, sleep pending не success**

```typescript
it('archive убивает running job/turn и ждёт подтверждённый sleep', async () => {
  await seedProduct({ id:'p-1',user_id:'u-deleted',status:'provisioning',host_id:'host-shared',slug:'slug-1' });
  await seedProvisionJob({ product_id:'p-1',status:'running',kind:'provision' });
  await seedTurn({ product_id:'p-1',status:'running' });
  await adapter.execute(productStopJob, ctx);
  expect(await provisionStatus('provision')).toBe('failed');
  expect(await turnStatus()).toBe('failed');
  expect(await productStatus('p-1')).toBe('archived');
  expect(await activeJobKind('p-1')).toBe('sleep');
  await expect(adapter.execute(productStopJob, ctx)).rejects.toMatchObject({ kind:'external_unknown' });
  expect(await productField('p-1','host_id')).toBe('host-shared');
  expect(await productField('p-1','slug')).toBe('slug-1');
});
```

PG tests также: blocked продукт архивируется без confirmation card; `purge_after=deleted_at+30 days`; restore/turn enqueue для deleted ничего не меняет; shared host и продукт соседа не меняются; статический import scan adapter не содержит `node:child_process`, `ssh` или `docker`.

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): account forced product stop (красный)` с trailer, push, PG test нового suite + `product-lifecycle.pg.spec.ts`. Expected: FAIL `Cannot find module './product-account-deletion.adapter'`.

- [ ] **Step 3: GREEN — extracted Block CTE, account predicates**

```sql
WITH target AS (
  SELECT p.id FROM products p JOIN user_id u ON u.internal_id=p.user_id
  WHERE p.id=$1 AND p.user_id=$2 AND u.state='deleted' AND u.deletion_id=$3
  FOR UPDATE OF p
), killed_jobs AS (
  UPDATE product_provision_jobs j SET status='failed',error='account_deleted',finished_at=now()
  FROM target t WHERE j.product_id=t.id AND j.status IN ('queued','running') RETURNING j.id
), killed_turns AS (
  UPDATE product_turns tr SET status='failed',error='account_deleted',finished_at=now()
  FROM target t WHERE tr.product_id=t.id AND tr.status IN ('queued','running') RETURNING tr.id
), marked AS (
  UPDATE products p SET status='archived',archived_at=COALESCE(archived_at,now()),
    purge_after=$4,first_prompt=NULL,first_prompt_channel=NULL
  FROM target t WHERE p.id=t.id RETURNING p.id
), queued AS (
  INSERT INTO product_provision_jobs(product_id,kind,status)
  SELECT m.id,'sleep','queued' FROM marked m
  WHERE (SELECT count(*) FROM killed_jobs)>=0
  ON CONFLICT DO NOTHING
  RETURNING product_id
) SELECT (SELECT id FROM target) AS id,(SELECT count(*) FROM queued) AS queued;
```

`ON CONFLICT DO NOTHING` допустим только потому, что следующий шаг обязан проверить фактическое наличие sleep и вызвать существующий `queueSleepForDeleted(productId)` для repair; отсутствие подтверждённого sleep остаётся ошибкой, а не молчаливым успехом. Adapter считает stop выполненным только при `sleep.status='done'`; queued/running/failed → `DeletionRetryError('external_unknown')`, payload `{productId,slug,hostId}` не затирается. Host остаётся pull-моделью `product_provision_jobs → HostApi.poll → sleepProduct`; coordinator не вызывает runner напрямую.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): немедленная остановка продуктов через host-agent` с trailer, push; PG suites `product-account-deletion`, `product-lifecycle`, unit `block.service`, `product-lifecycle.service`. Expected: PASS, sleep pending никогда не отмечается done, admin block baseline без дельты.

---

### Task 8: Products — purge только после purged_at, затем relational cleanup

**Files:**
- Modify: `src/products/product-account-deletion.service.ts`
- Modify: `src/products/product-account-deletion.adapter.ts`
- Modify: `src/products/product-purge.service.ts:207-402`
- Modify: `src/products/product-account-deletion.pg.spec.ts`
- Modify: `src/products/provisioning.complete-rekey-purge.spec.ts`

- [ ] **Step 1: RED — host timeout и неподтверждённый purge сохраняют всё техническое**

```typescript
it('queued/running purge не удаляет relational rows; confirmed purge удаляет только свой продукт', async () => {
  await seedArchivedDueProduct('p-deleted','u-deleted','host-shared');
  await seedArchivedDueProduct('p-other','u-other','host-shared');
  await adapter.execute(productPurgeJob, ctx);
  expect(await activeJobKind('p-deleted')).toBe('purge');
  expect(await productExists('p-deleted')).toBe(true);
  await reportHostPurgeSuccess('p-deleted');
  await adapter.execute(productPurgeJob, ctx);
  expect(await productExists('p-deleted')).toBe(false);
  expect(await turnsActionsJobsDomains('p-deleted')).toEqual({ turns:0,actions:0,jobs:0,domains:0 });
  expect(await productExists('p-other')).toBe(true);
  expect(await hostExists('host-shared')).toBe(true);
});
it('неизвестный host исход оставляет slug/host/purge job', async () => {
  await seedPurgeRunning('p-deleted');
  await expect(adapter.execute(productPurgeJob,ctx)).rejects.toMatchObject({ kind:'external_unknown' });
  expect(productPurgeJob.payload).toEqual({ productId:'p-deleted',slug:'slug-1',hostId:'host-shared' });
  expect(await productExists('p-deleted')).toBe(true);
});
```

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): подтверждённый product purge перед relational delete (красный)` с trailer, push, запустить новый PG suite. Expected: FAIL relational rows удаляются до `purged_at` либо scoped method отсутствует.

- [ ] **Step 3: GREEN — scoped wrappers поверх существующего purge**

Добавить `wipeExpiredForProduct(productId,userId)`, `queuePurgeForProduct(productId,userId)`, `removeBackupForProduct(productId,userId)` через extraction существующих SQL/path guards; глобальные scheduler methods сохраняют прежние сигнатуры и вызывают тот же helper. Account adapter:

```typescript
async purgeProduct(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
  await ctx.assertCurrent(job);
  await this.lifecycle.wipeExpiredForProduct(job.userId, job.resourceKey);
  await ctx.assertCurrent(job);
  await this.lifecycle.queuePurgeForProduct(job.userId, job.resourceKey);
  const product = await this.lifecycle.purgeState(job.userId, job.resourceKey);
  if (!product?.purged_at) throw new DeletionRetryError('external_unknown');
  await ctx.assertCurrent(job);
  await this.lifecycle.removeBackupForProduct(job.userId, job.resourceKey);
  if (product.repo_url && !(await this.lifecycle.backupCleared(job.userId,job.resourceKey))) {
    throw new DeletionRetryError('external_unknown');
  }
  await ctx.assertCurrent(job);
  await this.lifecycle.deletePurgedProduct(job.userId,job.resourceKey,job.deletionId);
}
```

`deletePurgedProduct` в transaction сначала проверяет `purged_at IS NOT NULL` + generation, удаляет `product_actions WHERE product_id`, затем `products WHERE id+user_id+purged_at`; turns/provision jobs/domains удаляются существующими cascades. `product_hosts/product_host_agent` не упоминаются. Повторный вызов при отсутствии строки success.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): полная очистка продуктов после host confirmation` с trailer, push; PG account/product-purge/provisioning.complete-rekey-purge + host unit `product-runner/src/host/{purge,sleep,index}.spec.ts` на ноде. Expected: backend и host suites PASS, normal purge retention baseline не изменился, account-specific relational delete только после `purged_at`.

---

### Task 9: Calendar и OAuth/интеграции — stop новых вызовов и локальный purge

**Files:**
- Create: `src/calendar/calendar-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/integrations/integration-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/calendar/calendar.service.ts:223-346,402-527`
- Modify: `src/trip/trip.service.ts:469-503`
- Modify: `src/zoom/zoom-oauth.service.ts:98-100`
- Modify: `src/talerid/talerid-oauth.service.ts:281-283`
- Modify: `src/profile/profile.service.ts` (удалить private `revokeAppleAccess` после переноса)

- [ ] **Step 1: RED — нельзя угадать владельца внешнего события**

```typescript
it('external event без durable ownership evidence не удаляется, local rows очищаются', async () => {
  db.proposals.push({ id:'pr-1',user_id:'u-deleted',event:{ uid:'shared-1',title:'ЛИЧНЫЙ-ТЕКСТ' } });
  const plan = await discoverCalendar(ctx);
  expect(plan.skips).toContainEqual({ resourceType:'calendar.external',reason:'owner_unverifiable' });
  expect(calendar.deleteEvent).not.toHaveBeenCalled();
  await adapter.execute(calendarPurgeJob,ctx);
  expect(db.proposals).toHaveLength(0);
  expect(db.connections).toHaveLength(0);
  expect(db.tripCalendars).toHaveLength(0);
});
it('calendar failure оставляет connection и retry, global integrations не меняются', async () => {
  calendar.disconnect.mockRejectedValue({ response:{ status:503 } });
  await expect(adapter.execute(calendarStopJob,ctx)).rejects.toMatchObject({ kind:'external_5xx' });
  expect(db.connections[0].id).toBe('cal-1');
  expect(db.integrationFlags).toEqual(beforeFlags);
});
```

Также RED: `reconnect/createEvent/deleteEvent/listEvents` deleted не вызывают connector; Zoom/Taler disconnect идемпотентны; Apple revoke выполняется до identity unlink, timeout оставляет stop retry, токены не попадают в payload/log.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): остановка календаря и интеграций без чужих событий (красный)` с trailer, push; `npx jest src/calendar src/trip src/integrations src/talerid src/zoom`. Expected: FAIL connector вызывается после deleted / adapter отсутствует.

- [ ] **Step 3: GREEN — active guard и безопасный fallback**

`CalendarService` получает private `assertActive(userId)` со strict `SELECT state FROM user_id`; вызывается до `creds/exchangeCreds/talerIdConnected`, `connect/reconnect`, `createEvent/deleteEvent`, `listEvents` и `TripService.applyAction`. `calendar.stop` использует существующие `disconnect/disconnectExchange` (их текущее правило сохраняет `secret_enc` для reconnect); `calendar.purge` удаляет `calendar_proposals`, `trip_calendars`, `calendar_connections` по `user_id` с generation predicate. Существующие UIDs без `createdByLinkeon` + owner evidence не используются для внешнего DELETE; skip reason фиксирован.

`integration-account-deletion.adapter` создаёт account-level `integration.apple.stop`, `integration.zoom.stop`, `integration.talerid.stop`. Apple tokens читаются через `IdentityService.providerRefreshTokens` только в памяти execute и передаются существующему `OAuthAppleService.revokeToken`; Zoom/Taler используют существующие `disconnect` hard-delete. `integration_flags` и singleton `short_youtube_account` не выбираются и не изменяются. Неизвестный revoke/disconnect result → retry; identities удаляет только account.core после всех stop.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): остановка и очистка календаря/OAuth интеграций` с trailer, push; focused suites + `talerid-oauth.service.spec.ts`, `calendar.service.spec.ts`. Expected: PASS, ни один fixture без ownership proof не вызывает external event deletion, секреты/токены отсутствуют в jobs/log.

---

### Task 10: Voice/meetings — stop только своих ботов и доступа

**Files:**
- Create: `src/voice-call/voice-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/voice-call/voice-call.service.ts:174-182,693-723`
- Modify: `src/voice-call/livekit.client.ts:79-113`
- Modify: `src/voice-call/voice-document.service.ts:152-171`
- Modify: `src/voice-call/specialist-job.service.ts:48-72`
- Modify: `src/meeting/attendee.client.spec.ts`

- [ ] **Step 1: RED — unknown bot и shared room**

```typescript
it('Attendee null сохраняет external_bot_id и не завершает stop', async () => {
  attendee.removeBot.mockResolvedValue(null);
  await expect(adapter.execute(voiceStopJob,ctx)).rejects.toMatchObject({ kind:'external_unknown' });
  expect(db.calls[0].external_bot_id).toBe('bot-external-1');
  expect(voiceStopJob.payload).toEqual({ callId:'call-1',externalBotId:'bot-external-1',roomKind:'shared' });
});
it('shared room не закрывается, удаляются только agents удалённого аккаунта', async () => {
  attendee.removeBot.mockResolvedValue(true);
  await adapter.execute(voiceStopJob,ctx);
  expect(livekit.removeAgentsStrict).toHaveBeenCalledWith('room-shared');
  expect(livekit.closeRoomStrict).not.toHaveBeenCalled();
  expect(roomService.close).not.toHaveBeenCalled();
  expect(db.meetingRooms).toHaveLength(1);
  expect(db.otherParticipantCalls).toHaveLength(1);
});
```

Добавить RED: voice document/specialist `setImmediate` после deleted не вызывает LLM/MinIO и не обновляет строки; sole personal room можно закрыть strict методом, любой unknown LiveKit outcome сохраняет retry.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): stop voice bots без удаления shared rooms (красный)` с trailer, push; `npx jest src/voice-call src/meeting`. Expected: FAIL текущий `releaseBot` молча возвращается при null, strict LiveKit методов нет.

- [ ] **Step 3: GREEN — tri-state в account adapter**

```typescript
async stopVoice(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
  const p = job.payload as { callId:string; externalBotId:string | null; roomKind:'sole' | 'shared' };
  await ctx.assertCurrent(job);
  if (p.externalBotId) {
    const result = await this.attendee.removeBot(p.externalBotId).catch(() => null);
    if (result === null) throw new DeletionRetryError('external_unknown');
    await ctx.assertCurrent(job);
    await this.voice.clearReleasedBotForDeletion(p.callId,job.deletionId,job.userId);
  }
  await ctx.assertCurrent(job);
  const stopped = p.roomKind === 'shared'
    ? await this.voice.markInterruptedKeepingRoomStrict(p.callId,job.deletionId)
    : await this.voice.markInterruptedStrict(p.callId,job.deletionId);
  if (!stopped) throw new DeletionRetryError('external_unknown');
}
```

Discovery определяет `roomKind='shared'` при наличии `room_name` у другого `user_id` либо persistent `meeting_rooms`; сохраняет только call/bot IDs, никогда `external_url`/Zoom URL. Новые strict LiveKit методы возвращают confirmed boolean и не глотают ошибки; старые interactive methods сохраняют поведение. `RoomService.close` не вызывается.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): немедленная остановка voice/meeting ресурсов` с trailer, push; focused `src/voice-call src/meeting`. Expected: PASS, unknown IDs сохраняются, shared room и другие участники остаются.

---

## Фаза 3 — все personal-resource адаптеры и shared-data обезличивание

### Task 11: Chat refs — exhaustive discovery и MinIO purge

**Files:**
- Create: `src/chat/chat-files/chat-file-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/chat/chat-files/chat-file-account-deletion.pg.spec.ts`
- Modify: `src/chat/chat.service.ts:3245-3267`
- Modify: `src/common/services/storage.service.ts` (+ `storage.service.spec.ts`)
- Modify: `src/video/video.service.ts:363-404`
- Modify: `src/voice-avatar/voice-avatar.service.ts:244-258`

- [ ] **Step 1: RED — keyset без 5000 limit и безопасный payload**

```typescript
it('читает human+ai всеми страницами и сохраняет только MinIO locator', async () => {
  await seedHistory([
    { id:1,session_id:'u-deleted_a',sender_type:'human',content:'[VIDEO_JOB:11111111-1111-1111-1111-111111111111]' },
    { id:2,session_id:'u-deleted_a',sender_type:'ai',content:`[Файл](${chatUrl}) ЛИЧНЫЙ-ТЕКСТ` },
    { id:3,session_id:'u-deleted_a',sender_type:'ai',content:'[external](https://example.com/x.mp4)' },
  ]);
  const plan = await discoverChatFiles({ ...ctx, pageSize:1 });
  expect(plan.jobs).toHaveLength(1);
  expect(plan.jobs[0].resourceKey).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(plan.jobs[0].payload)).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
  expect(storage.delete).not.toHaveBeenCalledWith(expect.objectContaining({ key:'x.mp4' }));
});
```

Добавить RED: MinIO timeout → payload и job retry сохранены; URL того же объекта в `u-other` history → объект сохраняется; `storage.delete` 2xx/absent success; chat insert после deleted ничего не создаёт; video tick и voice clone после deleted не вызывают provider.

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): исчерпывающий snapshot chat file refs (красный)` с trailer, push; новый PG + `chat-files` tests. Expected: FAIL текущий discovery limit/adapter отсутствует.

- [ ] **Step 3: GREEN — keyset и reference recheck**

```sql
SELECT id,content FROM custom_chat_history
WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\' AND id > $2
ORDER BY id LIMIT $3;
```

Использовать `extractChatFiles(content,env)` только как candidate parser, затем allowlist `MINIO_PUBLIC_URL`, `chatFilesBucket()`, owned static roots и marker ownership через `video_jobs.id=$1 AND video_jobs.user_id=$2` / `speech_clips.id=$1 AND speech_clips.user_id=$2`. Не копировать `FoundFile`. Discovery читает все sender types, пока страница не пуста. `ChatService.saveChatHistory` меняет insert на `INSERT ... SELECT ... WHERE EXISTS (user_id state='active')`; video poll и `profileAndClone` имеют strict active checks до provider и до DB update.

Purge перед каждым delete повторно проверяет generation и отсутствие ссылок во всех `custom_chat_history`, `generated_images`, `video_jobs`, `speech_clips`, `voice_calls` и DOC_PLACES. При confirmed sole ownership вызывает существующий `StorageService.delete` (2xx = confirmed); thumbnails удаляются через `thumbKeyFor` после той же проверки. Неизвестный S3 result пробрасывается в retry. Произвольный external URL и relay `/tmp` не удаляются.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): сохранение и очистка chat file ссылок` с trailer, push; новые PG/unit + `src/chat/chat-files src/common/services/storage.service.spec.ts src/chat/chat.service*.spec.ts`. Expected: PASS, 2+ keyset pages, shared object сохранён, ни текста ни userId в payload/log.

---

### Task 12: Generated images и video jobs — strict object deletion

**Files:**
- Create: `src/misc/image-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/video/video-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/misc/misc.service.ts:502-556`
- Modify: `src/video/video.service.ts:284-304,1222-1235,1299-1305,1365-1385`
- Read: `src/common/net/own-media.ts` (использовать существующий `ownStaticPath`, файл не изменять)

- [ ] **Step 1: RED — текущий best-effort не считается purge**

```typescript
it('MinIO failure не удаляет video row и technical IDs', async () => {
  storage.delete.mockRejectedValue({ code:'ETIMEDOUT' });
  await expect(adapter.execute(videoJob,ctx)).rejects.toMatchObject({ kind:'timeout' });
  expect(db.videoJobs[0].id).toBe('video-1');
  expect(db.videoJobs[0].kling_task_id).toBe('interaction-1');
  expect(videoJob.payload).toEqual({ videoJobId:'video-1' });
});
it('generated image: объект удалён до row, prompt не сохраняется в job', async () => {
  await adapter.execute(imageJob,ctx);
  expect(storage.delete).toHaveBeenCalledBefore(db.deleteGeneratedImage);
  expect(JSON.stringify(imageJob.payload)).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
  expect(db.generatedImages).toHaveLength(0);
});
```

Добавить RED: `deleteS3Objects` больше не используется account adapter, пока он `allSettled` игнорирует ошибки; local final MP4/JPG и `_veoconcat` удаляются только через checked own paths; legacy Yandex image использует свой configured S3 strict delete, не MinIO; `video-uploads/<userId>` читается из сохранённой row, не кладётся в payload; TG delivery row удаляется cascade вместе с video job.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): strict purge images/video (красный)` с trailer, push; `npx jest src/misc src/video`. Expected: FAIL row удаляется после rejected object deletion / adapters отсутствуют.

- [ ] **Step 3: GREEN — strict domain methods**

Добавить `deleteGeneratedImageForDeletion(userId,imageId,deletionId)` и `deleteVideoForDeletion(userId,videoJobId,deletionId)`. Они повторно читают row и generation, удаляют каждый owned MinIO/static object с await и без `allSettled` suppression, затем в transaction перепроверяют generation и удаляют row. Несуществующий object/path считается confirmed absence. Omni interaction ID не считается deletable file: discovery фиксирует безопасный skip `{resourceType:'video.provider',reason:'unsupported_external'}`, не вызывает несуществующий Veo cancel/delete API; owned MinIO/local objects всё равно очищаются до row deletion.

`ownStaticPath` и video path helpers обязаны reject symlink/root escape; `product`/другие user keys не вычисляются из произвольного URL. Повторный вызов при отсутствии row success.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): очистка generated images и video resources` с trailer, push; focused `src/misc src/video src/tg-bot/tg-video*`. Expected: PASS, object failure оставляет row/interaction ID, provider unsupported не вызывает выдуманный API.

---

### Task 13: Speech и avatars — shared cache и canonical ownership

**Files:**
- Create: `src/speech/speech-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/avatar/avatar-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/speech/speech.service.ts:310-375,454-464`
- Modify: `src/avatar/avatar.service.ts:53-91`

- [ ] **Step 1: RED — общий speech object и agent avatar сохраняются**

```typescript
it('одинаковый cache_key у соседа: удаляет свою row, сохраняет общий mp3', async () => {
  db.speechClips.push(ownClip, { ...ownClip,id:'clip-other',user_id:'u-other' });
  await speechAdapter.execute(speechJob,ctx);
  expect(storage.delete).not.toHaveBeenCalled();
  expect(db.speechClips.map((r) => r.id)).toEqual(['clip-other']);
});
it('avatar payload не содержит userId, shared agent avatar не удаляется', async () => {
  expect(avatarJob.payload).toEqual({});
  await avatarAdapter.execute(avatarJob,ctx);
  expect(storage.delete).toHaveBeenCalledWith({ bucket:'linkeon-assets',key:'avatars/users/u-deleted.jpg' });
  expect(storage.delete).not.toHaveBeenCalledWith(expect.objectContaining({ key:expect.stringContaining('avatars/agents/') }));
});
```

Добавить MinIO failure tests для clip/listen/avatar: локальная row/URL остаются, retry продолжается с того же technical ID; listen parts удаляются по одному до row deletion.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): shared speech и avatar ownership (красный)` с trailer, push; `npx jest src/speech src/avatar`. Expected: FAIL adapters отсутствуют / общий clip удаляется.

- [ ] **Step 3: GREEN — reference count и derive-at-execute**

Speech discovery сохраняет `{clipId}`/`{listenId}`, не text/cache URLs. Перед object delete выполняется `SELECT count(*) FROM speech_clips WHERE cache_key=$1 AND user_id<>$2`; при других ссылках объект пропускается, собственная row удаляется после generation check. Listen nonce parts удаляются strict, затем row. Avatar job пустой: execute вычисляет только canonical `avatars/users/${job.userId}.{jpg,png,webp,gif}` и `public/avatars/${job.userId}.jpg`; `profile_data.avatar_url` не используется как произвольная цель. `avatars/agents` не выбирается.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): очистка speech и пользовательских avatars` с trailer, push; focused suites. Expected: PASS, shared clip/agent avatar сохраняются, payload без userId/текста.

---

### Task 14: ElevenLabs — confirmed deleted/absent или retry

**Files:**
- Create: `src/voice-avatar/voice-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/voice-avatar/voice-avatar.service.ts:201-209,275-280`

- [ ] **Step 1: RED — timeout/missing key/5xx не теряют external ID**

```typescript
it.each([{ code:'ETIMEDOUT' },{ response:{ status:500 } },{}])('unknown ElevenLabs outcome = retry', async (failure) => {
  axios.delete.mockRejectedValue(failure);
  await expect(adapter.execute(voiceJob,ctx)).rejects.toBeInstanceOf(DeletionRetryError);
  expect(db.userVoice[0].elevenlabs_voice_id).toBe('voice-external-1');
  expect(voiceJob.payload).toEqual({ voiceId:'voice-external-1' });
});
it('404 = confirmed absence, затем удаляется локальная row', async () => {
  axios.delete.mockRejectedValue({ response:{ status:404 } });
  await adapter.execute(voiceJob,ctx);
  expect(db.userVoice).toHaveLength(0);
});
```

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): строгий ElevenLabs purge (красный)` с trailer, push; `npx jest src/voice-avatar`. Expected: FAIL текущий `deleteClone` молча возвращается, row удаляется.

- [ ] **Step 3: GREEN — отдельный strict method**

```typescript
async deleteCloneConfirmed(voiceId: string): Promise<'deleted' | 'absent'> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new DeletionRetryError('external_unknown');
  try {
    await axios.delete(`${EL_BASE}/voices/${encodeURIComponent(voiceId)}`, { headers:{ 'xi-api-key':key },timeout:30_000 });
    return 'deleted';
  } catch (e:any) {
    if (e?.response?.status === 404) return 'absent';
    throw new DeletionRetryError(deletionErrorKind(e));
  }
}
```

Account adapter вызывает `ctx.assertCurrent` до external и до `DELETE user_voice WHERE user_id/deletion generation`; interactive `deleteClone/removeVoice` не меняют своё поведение для других сценариев. Snapshot `voiceId` делается discovery до любого `ingestSample/profileAndClone` stop; фоновое клонирование уже fenced в Task 11.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): подтверждённое удаление ElevenLabs voice clone` с trailer, push; `npx jest src/voice-avatar src/account-deletion --maxWorkers=2`. Expected: PASS, unknown outcome никогда не очищает ID/row, 404 идемпотентен.

---

### Task 15: Voice documents и voice calls — references, затем rows

**Files:**
- Modify: `src/voice-call/voice-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/voice-call/voice-document-account-deletion.ts` (+ `.pg.spec.ts`)
- Modify: `src/voice-call/voice-document-migration.ts:47-66,327-371`

- [ ] **Step 1: RED — docs до voice row, shared transcript сохраняется**

```typescript
it('MinIO document failure сохраняет call/job rows и external IDs', async () => {
  storage.delete.mockRejectedValue({ response:{ status:503 } });
  await expect(adapter.execute(voiceDocumentJob,ctx)).rejects.toMatchObject({ kind:'external_5xx' });
  expect(db.voiceCalls).toHaveLength(1);
  expect(db.voiceCallJobs).toHaveLength(1);
  expect(db.voiceCalls[0].external_bot_id).toBe('bot-1');
});
it('voice.purge ждёт document jobs, не трогает shared room/чужой transcript', async () => {
  await expect(runner.runJob(voicePurgeJob)).rejects.toMatchObject({ kind:'external_unknown' });
  expect(adapter.execute).not.toHaveBeenCalled();
  await runner.runJob(voiceDocumentJob);
  await runner.runJob(voicePurgeJob);
  expect(db.meetingRooms).toHaveLength(1);
  expect(db.otherVoiceCalls).toHaveLength(1);
});
```

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): voice documents перед voice rows (красный)` с trailer, push; новый PG + voice adapter tests. Expected: FAIL document/call dependency отсутствует.

- [ ] **Step 3: GREEN — DOC_PLACES и derived keys**

Discovery использует существующий `DOC_PLACES` для поиска ссылок, но payload содержит только `{docId,keyKind:'hashed'|'legacy'}`. `voiceDocumentKey` вычисляет hashed key; legacy key вычисляется из `job.userId` в execute и не сохраняется в payload. Перед MinIO delete выполняется проверка всех DOC_PLACES на ссылки других аккаунтов; shared document сохраняется. Только после confirmed object absence/delete удаляются ссылки/собственные rows. `voice.purge` удаляет `voice_calls WHERE id+user_id` после stop и всех `voice-document.purge`; `voice_call_jobs` удаляется существующим cascade. TalerID note IDs, живущие только в `notesByCall`, не восстанавливаются перебором: discovery возвращает `external_note_id_unavailable`, никакого list/delete всех заметок.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): очистка voice documents/calls с сохранением shared rooms` с trailer, push; `npx jest src/voice-call src/meeting --maxWorkers=2` с `PROVISIONING_PG_URL` для нового PG suite. Expected: PASS, unknown document/Attendee outcome сохраняет IDs, shared history остаётся.

---

### Task 16: Events — обезличивание без уничтожения чужих агрегатов

**Files:**
- Create: `src/events/events-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/events/events.service.ts:123-171`
- Modify: `src/events/events.controller.ts:23-45` (только вызов существующего track, без доверия body.userId как ownership proof)

- [ ] **Step 1: RED — own events anonymized, чужая referral связь сохраняется**

```typescript
it('стирает identity/session/props только у собственных events', async () => {
  db.events.push(
    { id:1,user_id:'u-deleted',session_id:'s-1',name:'login',props:{ secret:'СЕКРЕТ-НЕ-ЛОГИРОВАТЬ' },source:'web' },
    { id:2,user_id:'u-leader',session_id:'s-2',name:'referral',props:{ referee:'u-deleted' },source:'web' },
  );
  await adapter.execute(eventsJob,ctx);
  expect(db.events[0]).toMatchObject({ user_id:null,session_id:null,props:{},name:'login',source:'web' });
  expect(db.events[1]).toMatchObject({ user_id:'u-leader',props:{ referee:'u-deleted' } });
});
it('buffer flush отбрасывает deleted user и его session после commit deletion', async () => {
  state.set('u-deleted','deleted');
  events.track('late',{ userId:'u-deleted',props:{ text:'ЛИЧНЫЙ-ТЕКСТ' } });
  events.track('late-session',{ sessionId:'u-deleted_agent' });
  await events.flushForTest();
  expect(db.events).toHaveLength(0);
});
```

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): обезличивание events и запрет поздних записей (красный)` с trailer, push; `npx jest src/events`. Expected: FAIL adapter/flush filter отсутствует.

- [ ] **Step 3: GREEN — batch state filter и scoped UPDATE**

```sql
UPDATE events e SET user_id=NULL,session_id=NULL,props='{}'::jsonb
WHERE (e.user_id=$1 OR e.session_id LIKE $1 || '\\_%' ESCAPE '\\')
  AND EXISTS (SELECT 1 FROM user_id u
    WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2);
```

`flush` собирает candidate IDs из `userId` и session prefix, одним `SELECT internal_id FROM user_id WHERE internal_id=ANY($1) AND state='deleted'` отфильтровывает deleted перед существующего multi-row INSERT. Props-only совпадения не используются как ownership evidence. `name/ts/source` сохраняются как действительно обезличенные агрегаты; payments/security logs не затрагиваются.

- [ ] **Step 4: GREEN commit/push и PASS**

Commit `feat(privacy): обезличивание events при удалении аккаунта` с trailer, push; `npx jest src/events src/account-deletion --maxWorkers=2`. Expected: PASS, deleted buffer не вставляется, чужая referral attribution и anonymous aggregates сохраняются.

---

### Task 17A: Tasks и Support — немедленная остановка и delayed purge

**Files:**
- Create: `src/tasks/tasks-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/support/support-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/tasks/tasks.service.ts:86-106`
- Modify: `src/support/support.service.ts:75-137,1152-1230`
- Modify: `src/alert-bot/alert-bot.store.ts` (только owner-scoped draft lookup/delete)

- [ ] **Step 1: RED — extraction/reply после deleted запрещены, shared health сохраняется**

```typescript
it('tasks: LLM не вызывается после deleted, purge удаляет events cascade', async () => {
  state.set('u-deleted','deleted');
  await tasks.extractFromTurn('u-deleted','1','личный вопрос','личный ответ');
  expect(claude.ask).not.toHaveBeenCalled();
  await tasksAdapter.execute(taskPurgeJob,ctx);
  expect(db.tasks).toHaveLength(0);
  expect(db.taskEvents).toHaveLength(0);
});
it('support: сначала drafts, потом ticket; service_health и alert_bot_turns сохраняются', async () => {
  await supportAdapter.execute(supportStopJob,ctx);
  expect(db.tickets[0].status).toBe('closed');
  await supportAdapter.execute(supportPurgeJob,ctx);
  expect(db.drafts).toHaveLength(0);
  expect(db.tickets).toHaveLength(0);
  expect(db.supportMessages).toHaveLength(0);
  expect(db.supportEvents).toHaveLength(0);
  expect(db.serviceHealth).toHaveLength(1);
  expect(db.alertBotTurns).toHaveLength(1);
});
```

Отдельный RED: `SupportService.createTicket/addUserReply` для deleted не создаёт ticket/message; stop failure оставляет ticket для retry, а `support.purge` не выполняется до `support.stop`.

- [ ] **Step 2: RED commit/push и FAIL**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/tasks/tasks-account-deletion.adapter.spec.ts src/support/support-account-deletion.adapter.spec.ts src/support/support.controller.spec.ts
git -C "$WT" commit -m "test(privacy): stop/purge tasks и support (красный)" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest src/tasks src/support --maxWorkers=2"
```

Expected: FAIL adapters отсутствуют и deleted extraction/reply проходит.

- [ ] **Step 3: GREEN — active checks и dependency ordering**

`TasksService.extractFromTurn` проверяет `state='active'` до `listActive/askLLMForDecision` и повторно до `applyDecision`. `tasks.stop` переводит active tasks в `archived`; `tasks.purge` делает `DELETE FROM tasks WHERE user_id=$1` с generation predicate, существующий cascade удаляет `task_events`. `SupportService.createTicket/addUserReply/adminReply` проверяет состояние аккаунта-владельца ticket до записи. `support.stop` переводит незавершённые tickets в `closed`; `support.purge` сначала удаляет `alert_bot_ticket_drafts` по ticket IDs, затем `support_tickets WHERE id+user_id`; cascades удаляют messages/events. `service_health` и operational `alert_bot_turns` не упоминаются в SQL.

- [ ] **Step 4: GREEN commit/push и PASS**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/tasks/tasks-account-deletion.adapter.ts src/tasks/tasks-account-deletion.adapter.spec.ts src/tasks/tasks.service.ts src/support/support-account-deletion.adapter.ts src/support/support-account-deletion.adapter.spec.ts src/support/support.service.ts src/alert-bot/alert-bot.store.ts
git -C "$WT" commit -m "feat(privacy): очистка tasks и support tickets" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest src/tasks src/support src/alert-bot --maxWorkers=2 && printf 'TASKS_SUPPORT_GREEN_OK\n'"
```

Expected: `TASKS_SUPPORT_GREEN_OK`, чужие tickets и service health не изменены.

---

### Task 17B: Peer и Contacts — redact/tombstone вместо удаления shared history

**Files:**
- Create: `src/peer/peer-account-deletion.adapter.ts` (+ `.pg.spec.ts`)
- Create: `src/contacts/contacts-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/peer/peer.service.ts:47-443`
- Modify: `src/contacts/contacts.service.ts:41-49,124-165`

- [ ] **Step 1: RED — сообщения другого участника и safety blocks/reports сохраняются**

```typescript
it('peer purge удаляет только свои messages и заменяет свои IDs на deletion alias', async () => {
  await peerAdapter.execute(peerPurgeJob,ctx);
  expect(db.peerMessages.map((m) => m.sender_id)).toEqual(['u-other']);
  expect(db.conversations[0].user_a_id + '<' + db.conversations[0].user_b_id).toBe(db.conversations[0].user_a_id + '<' + db.conversations[0].user_b_id);
  expect(db.conversations[0]).not.toMatchObject({ user_a_id:'u-deleted' });
  expect(db.requests[0].intro_message).toBe('');
  expect(db.incomingBlocks[0].blocked_id).toBe(deletionAlias);
  expect(db.reports[0].reason).toBe('moderation evidence');
});
```

Проверки: `user_a_id<user_b_id` и pair uniqueness сохраняются через `LEAST/GREATEST(deletionAlias,otherId)`; `sendRequest/sendMessage/block/report` deleted не создают rows; outgoing blocks удаляются, incoming blocks получают alias; contact request другого человека остаётся, а message удалённого requester очищается по surrogate `ai_profiles_consolidated.id`.

- [ ] **Step 2: RED commit/push и PG FAIL**

Добавить два новых spec, commit `test(privacy): peer/contacts tombstone shared history (красный)` с trailer, push, checkout SHA и запустить `PROVISIONING_PG_URL` PG suite `src/peer/peer-account-deletion.pg.spec.ts src/contacts/contacts-account-deletion.adapter.spec.ts`. Expected: FAIL adapter отсутствует / cascade удаляет чужие messages.

- [ ] **Step 3: GREEN — deletion-scoped alias без переименования user_id**

```sql
UPDATE peer_conversations SET user_a_id=LEAST($2,other_id),user_b_id=GREATEST($2,other_id)
FROM (SELECT id,user_a_id AS other_id FROM peer_conversations WHERE user_b_id=$1
      UNION SELECT id,user_b_id AS other_id FROM peer_conversations WHERE user_a_id=$1) sides
WHERE peer_conversations.id=sides.id
  AND EXISTS (SELECT 1 FROM user_id WHERE internal_id=$1 AND state='deleted' AND deletion_id=$3);
```

`deletionAlias='deleted:'+deletionId`; `user_id.internal_id` и surrogate profile ID не переименовываются. Peer purge: delete `peer_messages WHERE sender_id=userId`; redact `intro_message` только если `from_user_id=userId`; alias обе стороны requests/conversations; delete outgoing blocks и alias incoming; alias reporter/target в `user_reports`, сохраняя reason/context под security-retention. `peer.stop` переводит pending requests в `withdrawn` и новые sends блокируются active guard. Contacts использует surrogate ID только для redaction, не удаляет profile shell и не разрывает joins.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Добавить adapters/specs и два service, commit `feat(privacy): обезличивание peer и contact history` с trailer, push; повторить PG команду Step 2. Expected: PASS, pair constraints и чужие messages/reports/blocks сохранены, alias повторного execute не меняется.

---

### Task 17C: Referral и outreach — stop выплат/рассылок, ledger сохраняется

**Files:**
- Create: `src/referral/referral-account-deletion.adapter.ts` (+ `.pg.spec.ts`)
- Create: `src/retention/retention-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/referral/referral.service.ts:150-226` и методы register/withdraw/payout
- Modify: `src/retention/retention-sql.ts:6-60`
- Modify: `src/retention/retention-recipient-resolver.ts:12-60`
- Modify: `src/retention/retention.service.ts:192-256`
- Modify: `src/admin/admin.service.ts:563-586,741-781`

- [ ] **Step 1: RED — pending withdrawal блокирует purge, settled ledger не теряет суммы**

```typescript
it('pending withdrawal сохраняет обязательство и retry', async () => {
  db.withdrawals.push({ id:'w-1',leader_id:'leader-1',status:'pending',amount_rub:500,requisites:'ЛИЧНЫЙ-ТЕКСТ' });
  await expect(adapter.execute(referralPurgeJob,ctx)).rejects.toMatchObject({ kind:'external_unknown' });
  expect(db.withdrawals[0]).toMatchObject({ amount_rub:500,requisites:'ЛИЧНЫЙ-ТЕКСТ',status:'pending' });
});
it('settled: aliases вместо phone, amounts/payment IDs/ledger неизменны', async () => {
  db.withdrawals[0].status='paid';
  const before = financialSnapshot(db);
  await adapter.execute(referralPurgeJob,ctx);
  expect(financialSnapshot(db)).toEqual(before);
  expect(db.leaders[0]).toMatchObject({ is_active:false,name:'',user_phone:deletionAlias });
  expect(db.referees[0].referee_phone).toBe(deletionAlias);
  expect(db.withdrawals[0].requisites).toBe('');
});
```

Retention RED: segment SQL и recipient resolver исключают `state<>'active'`; непосредственно перед email/SMS/TG send повторная проверка отсекает deleted; `retention_email_unsubscribes` и security rate-limit TTL сохраняются.

- [ ] **Step 2: RED commit/push и PG FAIL**

Добавить referral/retention specs, commit `test(privacy): referral pseudonymization и outreach stop (красный)` с trailer, push, запустить referral PG + retention/admin focused tests. Expected: FAIL текущие queries допускают deleted, pending withdrawal удаляется.

- [ ] **Step 3: GREEN — deactivate + pseudonymize без финансовых потерь**

`referral.stop` устанавливает `referral_leaders.is_active=false`; register/withdraw/payout и все outreach senders получают strict active predicate. При purge любой `pending` withdrawal → `DeletionRetryError('external_unknown')` и никаких изменений. Для settled: один alias заменяет `referral_leaders.user_phone`, `referral_referees.referee_phone`, `referral_commissions.referee_phone`, `referral_token_payouts.user_phone`, `referral_withdrawals.user_phone`; leader name очищается, slug заменяется на `deleted-${deletionId}`, requisites settled withdrawals на `''`. `payment_id`, `commission_ids`, amounts, paid_out, `token_transactions` и остальной ledger не меняются. Повторная регистрация телефона не упирается в старый unique referee.

`GENERAL_SEGMENT_SQL/CURIOUS_SEGMENT_SQL` join `user_id u ON u.internal_id=uid AND u.state='active'`; resolver добавляет `AND state='active'` в accounts и фильтрует profiles/identities через `EXISTS`. Send path делает ещё один strict check после подготовки письма/SMS. Suppression list не удаляется.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Добавить ровно файлы задачи, commit `feat(privacy): остановка outreach и обезличивание referral links` с trailer, push; повторить PG/focused команду Step 2. Expected: PASS, pending obligations и financial snapshots сохранены, deleted recipients не получают сообщения.

---

### Task 17D: Backups, devices, guest claims и legacy auth

**Files:**
- Create: `src/backup/backup-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/devices/devices-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/guest-trial/guest-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/identity/legacy-auth-account-deletion.adapter.ts` (+ `.spec.ts`)
- Modify: `src/common/services/redis.service.ts` (cursor-based `deleteByPrefix`)

- [ ] **Step 1: RED — unclaimed trial/settings/suppression не затрагиваются**

```typescript
it('purge удаляет только claimed session и account-addressable carry/verification keys', async () => {
  await guestAdapter.execute(guestStopJob,ctx);
  await legacyAuthAdapter.execute(verificationStopJob,ctx);
  await guestAdapter.execute(guestPurgeJob,ctx);
  expect(redis.deletedPrefixes).toEqual(['guest-carry:u-deleted:','ev-sent-u-deleted-']);
  expect(db.guestSessions).toEqual([unclaimedSession]);
  expect(db.guestSettings).toEqual(beforeSettings);
  expect(db.unsubscribes).toEqual(beforeSuppressions);
});
it('backups/devices/short_codes удаляются, платёжный token ledger остаётся', async () => {
  await backupAdapter.execute(backupJob,ctx);
  await devicesAdapter.execute(devicesJob,ctx);
  await legacyAuthAdapter.execute(shortCodeJob,ctx);
  expect(db.profileBackups).toHaveLength(0);
  expect(db.userDevices).toHaveLength(0);
  expect(db.shortCodes).toHaveLength(0);
  expect(db.tokenTransactions).toHaveLength(1);
});
```

- [ ] **Step 2: RED commit/push и FAIL**

Добавить четыре spec, commit `test(privacy): backups/devices/guest/legacy auth purge (красный)` с trailer, push, checkout SHA и запустить `src/backup src/devices src/guest-trial src/identity`. Expected: FAIL adapters отсутствуют.

- [ ] **Step 3: GREEN — derive hashes/keys в execute**

`profile-backup.purge` и `devices.purge` удаляют по `user_id` с generation predicate. Guest `claimed_by_hash=sha256('guest-claim:'+userId)` вычисляется в execute; payload пустой. `guest-carry.stop`/`auth-verification.stop` используют `SCAN cursor MATCH prefix*` маленькими batches и `UNLINK`, никогда `KEYS`; magic-link token keys и SMS/security rate limits остаются до естественного TTL. `legacy-auth.purge` удаляет `short_codes.phone=userId`; `retention_email_unsubscribes`, unclaimed trials и global `guest_trial_settings` не выбираются.

- [ ] **Step 4: GREEN commit/push и PASS**

Добавить adapters/specs и Redis helper, commit `feat(privacy): очистка backups/devices/guest/legacy auth` с trailer, push, повторить focused команду Step 2 и `src/common/services/redis*.spec.ts`. Expected: PASS, prefixes не попадают в logs/payload, unclaimed/global/suppression сохранены.

---

### Task 17E: Legacy SMM — stop credentials и scrubbing при сохранении billing shells

**Files:**
- Create: `src/misc/legacy-smm-account-deletion.adapter.ts` (+ `.pg.spec.ts`)

- [ ] **Step 1: RED — official/shared и суммы сохраняются**

```typescript
it('legacy SMM scrub не удаляет billing evidence и official campaign', async () => {
  const before = billingSnapshot(db);
  await adapter.execute(legacySmmStopJob,ctx);
  await adapter.execute(legacySmmPurgeJob,ctx);
  expect(db.socialAccounts[0]).toMatchObject({ status:'revoked',credentials:{} });
  expect(db.oauthStates).toHaveLength(0);
  expect(db.campaigns.find((c) => c.id==='own').topic).toBeNull();
  expect(db.scenarios[0]).toMatchObject({ title:'',dialog:[],broll_prompts:[],scenes_json:null });
  expect(db.videos[0]).toMatchObject({ render_state:{},mp4_url:null,error_message:null });
  expect(billingSnapshot(db)).toEqual(before);
  expect(db.campaigns.find((c) => c.id==='official').topic).toBe('platform topic');
  expect(db.musicTracks).toHaveLength(1);
  expect(db.pricing).toHaveLength(1);
});
```

Добавить RED: `smm_event_log` собственных video/publication удаляется до scrub; active publication/video/campaign переводятся в `cancelled`; внешний post без существующего deletion adapter даёт `unsupported_external` skip, а не выдуманный API/SSH вызов.

- [ ] **Step 2: RED commit/push и PG FAIL**

Добавить PG spec, commit `test(privacy): legacy SMM scrub с сохранением billing (красный)` с trailer, push, запустить его с `PROVISIONING_PG_URL`. Expected: FAIL adapter отсутствует / cascade удаляет premium generation.

- [ ] **Step 3: GREEN — scrub вместо cascade billing**

Discovery выбирает только `smm_campaign.user_id=userId AND is_linkeon_official=false`, создаёт `legacy-smm.stop/purge` с `{campaignId}`. Stop: campaign/video/publication → `cancelled`, social account → `status='revoked',credentials='{}'`, OAuth state delete. Purge в одном transaction с generation check: delete собственные `smm_event_log`; scrub `smm_creator_campaign` text/URLs, `smm_scenario` title/dialog/broll/scenes, `smm_publication` caption/external IDs/URLs, `smm_video` render_state/mp4/error, `smm_campaign` topic/conversation; `smm_billing_ledger.user_id` и `smm_premium_generation.user_id` получают deletion alias. Строки и все `tokens_charged/refunded/amount/internal_cost` сохраняются, поэтому destructive cascade не нужен. `smm_music_track/smm_pricing/official` не выбираются.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Добавить adapter/spec, commit `feat(privacy): обезличивание legacy SMM без потери ledger` с trailer, push, повторить PG test. Expected: PASS, personal text/URLs/credentials очищены, billing snapshot и shared official data неизменны.

---

### Task 17: Account core — recapture, graph и атомарный local finalize

**Files:**
- Create: `src/profile/profile-account-deletion.discovery.ts`
- Create: `src/profile/profile-account-deletion.adapter.ts` (+ `.spec.ts`)
- Create: `src/profile/profile-account-deletion.pg.spec.ts`
- Modify: `src/profile/profile.service.ts:149-234`

- [ ] **Step 1: RED — refs durable до history, каждый delete fenced**

```typescript
it('повторный capture добавляет поздний file до удаления history', async () => {
  await seedDeletedAccount({ userId:'u-deleted',deletionId:'d-1' });
  await seedHistory('u-deleted','[file](https://minio.test/linkeon-chat-files/late/file.pdf)');
  await adapter.execute(coreImmediateJob,ctx);
  const ref = await db.query(`SELECT payload_jsonb FROM account_deletion_jobs WHERE resource_type='chat-file.purge'`);
  expect(ref.rows).toHaveLength(1);
  expect(await historyCount('u-deleted')).toBe(0);
  expect(JSON.stringify(ref.rows[0].payload_jsonb)).not.toContain('ЛИЧНЫЙ-ТЕКСТ');
});
it('reactivation между graph и local delete отменяет finalize', async () => {
  neo4j.deleteUserGraph.mockImplementation(async () => { await reactivate('u-deleted','d-new'); });
  await expect(adapter.execute(coreImmediateJob,ctx)).rejects.toMatchObject({ kind:'cancelled' });
  expect(await historyCount('u-deleted')).toBe(1);
  expect(await identityCount('u-deleted')).toBe(1);
});
```

PG suite также проверяет: explicit core immediate очищает `custom_chat_history`, `action_plans`, profile/business data, tokens, `user_identities`, `tg_user_identities`, password/email/welcome bonus; merge core purge не трогает identities, уже перенесённые survivor-у; payments и security logs сохраняются; `user_id` остаётся tombstone, jobs остаются audit.

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): account core capture и deletion fencing (красный)` с trailer, push; новый PG suite. Expected: FAIL adapter отсутствует / поздняя ссылка теряется.

- [ ] **Step 3: GREEN — два коротких transaction, network вне transaction**

```typescript
async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
  await ctx.assertCurrent(job);
  await this.recapture.collectAndPersist(job); // отдельная короткая tx; новые stop jobs блокируют core dependency
  await this.jobs.assertNoImmediateBlockers(job.deletionId);
  await ctx.assertCurrent(job);
  await this.neo4j.deleteUserGraph(job.userId);
  await ctx.assertCurrent(job);
  await inTransaction(this.pg, async (tx) => {
    await this.jobs.lockAndAssertCurrent(tx,job);
    await deleteOwnedCoreRows(tx,job);
  });
}
```

`deleteOwnedCoreRows` использует escaped session prefix и для каждого DELETE/UPDATE `EXISTS (SELECT 1 FROM user_id WHERE internal_id=job.userId AND state='deleted' AND deletion_id=job.deletionId)`. Порядок: history/action plans → profile/business clear → identity/TG unlink → tombstone password/email/welcome bonus. `tasks`, support, peer, referral, backups, devices, guest и legacy SMM обрабатываются только доменными Tasks 17A–17E, а не раздувают core. Graph call идемпотентен и выполняется до local tx; сбой graph оставляет local rows для retry. `user_id.internal_id` и surrogate `ai_profiles_consolidated.id` остаются минимальным lifecycle/billing shell, phone/email/contacts/profile fields очищаются; переименование `internal_id` не добавляется. `ProfileService.deleteProfile` больше не содержит собственных SQL/network вызовов и в Task 18 только делегирует lifecycle.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): fenced account core finalize` с trailer, push; PG profile/account-deletion + unit profile/session-prefix. Expected: PASS, reactivation cancel не удаляет новый аккаунт, file refs предшествуют history delete, payments/security logs без изменений.

---

## Фаза 4 — подключение явного удаления, merge и reactivation

### Task 18: Явное DELETE — begin, stop, затем текущий immediate finalize

**Files:**
- Create: `src/account-deletion/account-deletion.lifecycle.ts` (+ `.spec.ts`)
- Modify: `src/profile/profile.service.ts:149-234`
- Modify: `src/profile/profile.controller.ts:61-66` (только safe error mapping)
- Modify: `src/profile/profile.module.ts`
- Modify: `src/profile/account-deletion.spec.ts`
- Create: `src/profile/profile-deletion.lifecycle.pg.spec.ts`

- [ ] **Step 1: RED — поле/generation атомарны и stop предшествует history**

```typescript
it('DELETE создаёт generation, jobs и вызывает stop до core finalize', async () => {
  await profile.deleteProfile('u-deleted');
  const u = await userRow('u-deleted');
  expect(u.state).toBe('deleted');
  expect(u.deleted_at).not.toBeNull();
  expect(u.deletion_id).toMatch(UUID);
  expect(calls).toEqual(['begin','routine.stop','telegram.stop','product.stop','calendar.stop','voice.stop','core.immediate']);
  expect(await historyCount('u-deleted')).toBe(0);
});
it('stop failure не удаляет history/identities и не возвращает ложный success', async () => {
  registry.fail('telegram.stop',new DeletionRetryError('timeout'));
  await expect(profile.deleteProfile('u-deleted')).rejects.toBeInstanceOf(ServiceUnavailableException);
  expect(await historyCount('u-deleted')).toBe(1);
  expect(await identityCount('u-deleted')).toBe(1);
  expect((await userRow('u-deleted')).deletion_id).toBeTruthy();
});
```

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): explicit deletion stop-before-finalize (красный)` с trailer, push; PG lifecycle + `profile/account-deletion.spec.ts`. Expected: FAIL текущий delete удаляет history до stop и state ставит последним.

- [ ] **Step 3: GREEN — lifecycle API**

```typescript
async deleteExplicit(userId: string): Promise<void> {
  await this.registry.assertReady();
  const account = await this.begin(userId,'explicit');
  if (!account) return; // historical deleted без generation не включается
  await this.runner.runImmediateStops(account.deletionId);
  const core = await this.jobs.find(account.deletionId,'account.core.immediate','account');
  await this.runner.runJob(core);
}
```

`begin` в `inTransaction` делает `SELECT ... FOR UPDATE`; active получает `state='deleted',deleted_at=now(),deletion_id=gen_random_uuid()` и `RETURNING`; повторный request с текущим generation использует его для retry, после reactivation новое удаление получает новый UUID. В той же tx planner collect/persist читает refs до history. External stop выполняется после commit. `ProfileService.deleteProfile` только `await deletion.deleteExplicit(userId); return {success:true}`; `ServiceUnavailableException` имеет фиксированное безопасное сообщение, HTTP не раскрывает deletionId.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): coordinated explicit account deletion` с trailer, push; PG lifecycle + все account-deletion/profile tests. Expected: PASS, stop failure оставляет history/identity и persistent jobs для повторного explicit request с тем же generation; hourly worker обрабатывает их только после 30-day cutoff, успешный порядок соответствует calls.

---

### Task 19: Merge loser — credit-first, stop, identity move, delayed core purge

**Files:**
- Modify: `src/identity/identity.service.ts:348-407`
- Modify: `src/identity/identity.link-candidate.spec.ts:167-212`
- Create: `src/identity/identity.merge-deletion.pg.spec.ts`
- Modify: `src/account-deletion/account-deletion.lifecycle.ts`

- [ ] **Step 1: RED — survivor не получает loser cleanup**

```typescript
it('merge: balance credit-first, loser stop до identity move, core purge через 30 дней', async () => {
  await identity.mergeAccounts('u-conflict','u-target');
  expect(calls).toEqual(['credit-survivor','debit-loser','begin-merge','stop-loser','move-identities']);
  const loser = await userRow(loserId);
  expect(loser.state).toBe('deleted');
  expect(loser.deletion_id).toBeTruthy();
  expect(await coreJob(loser.deletion_id)).toMatchObject({ resource_type:'account.core.purge',phase:'purge' });
  expect(await historyCount(loserId)).toBe(1);
  expect(apple.revokeToken).toHaveBeenCalledBefore(calls.indexOf('move-identities'));
  expect(await survivorIdentityCount(survivorId)).toBe(2);
});
```

Добавить RED: stop failure не переносит identities и не удаляет history; повторный merge не начисляет баланс повторно, потому что loser balance уже нулевой; `tg_user_identities` loser отвязывается после stop, survivor TG не затрагивается.

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): merge loser deletion generation и delayed purge (красный)` с trailer, push; новый PG + link-candidate unit. Expected: FAIL текущий merge ставит только state и переносит identities до stop.

- [ ] **Step 3: GREEN — отдельный merge orchestration без ProfileService cycle**

```typescript
const loser = await this.deletion.begin(loserUserId,'merge');
await this.deletion.stopOnly(loser.deletionId);
await inTransaction(this.pg, async (tx) => {
  await this.deletion.assertCurrent(tx,loser);
  await tx.query(`UPDATE user_identities SET user_id=$1 WHERE user_id=$2`,[survivorUserId,loserUserId]);
  await tx.query(`DELETE FROM tg_user_identities WHERE linkeon_user_id=$1
    AND EXISTS (SELECT 1 FROM user_id WHERE internal_id=$1 AND state='deleted' AND deletion_id=$2)`,[loserUserId,loser.deletionId]);
  await tx.query(`UPDATE user_id SET password_hash=NULL,primary_email=NULL,welcome_bonus_at=NULL,update_date=now()
    WHERE internal_id=$1 AND state='deleted' AND deletion_id=$2`,[loserUserId,loser.deletionId]);
});
```

Существующие balance calls и комментарий credit-first остаются до этого блока. `IdentityService` получает core lifecycle через `@Optional()`/module import, но core не импортирует `IdentityModule`; `ProfileService` в merge не вызывается. После return coordinator выполняет доменные и `account.core.purge` не раньше `deleted_at+30 days`.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): очистка merge-loser с защитой survivor` с trailer, push; PG merge + identity unit + account-deletion coordinator. Expected: PASS, balance ordering baseline сохранён, history loser остаётся до cutoff, survivor resources не удаляются.

---

### Task 20: Reactivation — одна connection transaction и отмена старых jobs

**Files:**
- Modify: `src/identity/identity.service.ts:197-248,290-305`
- Modify: `src/profile/account-deletion.spec.ts`
- Create: `src/identity/identity.reactivation.pg.spec.ts`

- [ ] **Step 1: RED — same internal_id, cancel running lease, stale worker**

```typescript
it('регистрация очищает generation и отменяет jobs, старый worker не удаляет новый аккаунт', async () => {
  const first = await resolvePhone('u-phone');
  await profile.deleteProfile(first.userId);
  const old = await userRow(first.userId);
  await insertJob(old.deletion_id,'running');
  const second = await resolvePhone('u-phone');
  expect(second.userId).toBe(first.userId);
  const active = await userRow(first.userId);
  expect(active).toMatchObject({ state:'active',deleted_at:null,deletion_id:null });
  expect(await unfinishedJobs(old.deletion_id)).toHaveLength(0);
  await expect(jobs.assertCurrent(staleJob)).rejects.toMatchObject({ kind:'cancelled' });
  expect(await newAccountResourceCount(first.userId)).toBe(1);
});
it('повторное удаление после reactivation создаёт новый UUID', async () => {
  const oldId = await deleteThenReactivate('u-phone');
  await profile.deleteProfile('u-phone');
  expect((await userRow('u-phone')).deletion_id).not.toBe(oldId);
});
```

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): reactivation отменяет старую deletion generation (красный)` с trailer, push; PG reactivation + profile unit. Expected: FAIL fields не очищаются, running job не cancelled, BEGIN использует pool.

- [ ] **Step 3: GREEN — `inTransaction` для всего create/reactivate блока**

```typescript
await inTransaction(this.pg, async (tx) => {
  const old = await tx.query(`SELECT deletion_id FROM user_id WHERE internal_id=$1 FOR UPDATE`,[userId]);
  await tx.query(`UPDATE account_deletion_jobs SET status='cancelled',lease_until=NULL,completed_at=now(),updated_at=now()
    WHERE user_id=$1 AND deletion_id=$2 AND status IN ('pending','running','failed')`,[userId,old.rows[0]?.deletion_id]);
  await tx.query(`UPDATE user_id SET state='active',deleted_at=NULL,deletion_id=NULL,update_date=now()
    WHERE internal_id=$1 AND state<>'active'`,[userId]);
  await ensureProfileAndIdentity(tx);
  await this.issueWelcomeBonus(tx,userId);
});
```

Весь существующий step 3 `resolveOrCreate` использует один tx client; `issueWelcomeBonus` принимает `SlotQueryable`, не `this.pg`. Events track остаются после COMMIT. Historical deleted с NULL reactivates без создания jobs и не выбирается coordinator. Старый running worker дополнительно отсекается job status/attempt lease и user generation перед каждым destructive шагом.

- [ ] **Step 4: GREEN commit/push и PG PASS**

Commit `feat(privacy): безопасная реактивация после удаления` с trailer, push; PG reactivation/unlink + identity/profile focused. Expected: PASS, welcome bonus по-прежнему выдаётся один раз в tx, stale worker cancel, новый deletion UUID отличается.

---

## Фаза 5 — strict dry-run, synthetic и публичная политика

### Task 21: Strict dry-run CLI без Nest side effects

**Files:**
- Create: `src/account-deletion/account-deletion.dry-run.ts` (+ `.spec.ts`)
- Create: `scripts/account-deletion-dry-run.ts`

- [ ] **Step 1: RED — read-only transaction и внешние mocks не вызываются**

```typescript
it('dry-run использует collect, но не persist/adapters/migrations/external clients', async () => {
  const calls:string[] = [];
  const db = readOnlyPgRecorder(calls);
  const result = await dryRunAccountDeletion(db,{ retentionMs:0 });
  expect(calls.every((sql) => /^\s*SELECT\b/i.test(sql))).toBe(true);
  expect(persist).not.toHaveBeenCalled();
  expect(registry.execute).not.toHaveBeenCalled();
  expect(storage.delete).not.toHaveBeenCalled();
  expect(grammy.leaveChat).not.toHaveBeenCalled();
  expect(host.poll).not.toHaveBeenCalled();
  expect(result).toEqual({ accounts:1,jobsByType:{'product.purge':1},skipsByReason:{owner_unverifiable:1} });
});
```

PG variant выполняет `BEGIN READ ONLY` в одноразовой БД и проверяет отсутствие изменений в `user_id/account_deletion_jobs/products/tg_bot_configs`, отсутствие `schema_migrations` и отсутствие файлов отчёта; recorder собирает только planner queries после начала transaction.

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(privacy): side-effect-free deletion dry-run (красный)` с trailer, push; `npx jest src/account-deletion/account-deletion.dry-run.spec.ts`. Expected: FAIL module отсутствует.

- [ ] **Step 3: GREEN — JSON counts only**

```typescript
export async function dryRunAccountDeletion(db:Db, options:{retentionMs:number}): Promise<DryRunSummary> {
  const accounts = await selectDeletionCandidates(db,options.retentionMs);
  const summary = { accounts:accounts.length,jobsByType:{} as Record<string,number>,skipsByReason:{} as Record<string,number> };
  for (const account of accounts) {
    const origin = await readExistingOrigin(db,account);
    const plan = await new AccountDeletionPlanner(DELETION_DISCOVERERS).collect(db,account,origin);
    for (const job of plan.jobs) summary.jobsByType[job.resourceType]=(summary.jobsByType[job.resourceType] ?? 0)+1;
    for (const skip of plan.skips) summary.skipsByReason[skip.reason]=(summary.skipsByReason[skip.reason] ?? 0)+1;
  }
  return summary;
}
```

`readExistingOrigin` читает существующий core job и не создаёт новый при dry-run. CLI использует `pg.Client` с `options:'-c default_transaction_read_only=on'`, `dotenv.config()` без печати env, не создаёт Nest app и не импортирует `AppModule`/schema service. Любой `--apply` завершатся кодом 2 с `dry-run only`; stdout только `JSON.stringify(summary,null,2)` и финальный `ACCOUNT_DELETION_DRY_RUN_OK`; нет userId/deletion lists/files.

- [ ] **Step 4: GREEN commit/push и PASS + broad tsc**

Commit `feat(privacy): строгий dry-run очистки аккаунтов` с trailer, push; focused Jest + `npx tsc -p tsconfig.json --noEmit`. Expected: PASS, все SQL SELECT, external mocks ноль, `ACCOUNT_DELETION_DRY_RUN_OK`.

---

### Task 22: End-to-end synthetic с ускоренным cutoff и fault injection

**Files:**
- Create: `src/account-deletion/account-deletion.synthetic.pg.spec.ts`
- Create: `scripts/account-deletion-synthetic.ts`
- Create: `src/account-deletion/account-deletion.synthetic.spec.ts`

- [ ] **Step 1: RED — reactivation до cutoff и вторая полная очистка**

```typescript
it('synthetic: stop → reactivate cancel → новое удаление → partial failures → retry → done', async () => {
  const fixture = await seedSyntheticAccountWithAllResources();
  const first = await lifecycle.deleteExplicit(fixture.userId);
  expect(await stoppedResources(first.deletionId)).toEqual(allStopTypes);
  await reactivate(fixture.userId);
  await runner.runAccount(first.deletionId);
  expect(await newAccountResources(fixture.userId)).not.toEqual(emptyResources);
  const second = await lifecycle.deleteExplicit(fixture.userId);
  expect(second.deletionId).not.toBe(first.deletionId);
  failures.inject('minio','timeout').inject('host','external_unknown').inject('elevenlabs','external_5xx').inject('calendar','external_5xx');
  await coordinator.tick({ retentionMs:1,batchSize:2 });
  expect(await failedKinds(second.deletionId)).toEqual(expect.arrayContaining(['timeout','external_unknown','external_5xx']));
  expect(await externalIdsPresent(second.deletionId)).toBe(true);
  failures.clear();
  await coordinator.tick({ retentionMs:0,batchSize:2 });
  expect(await unfinishedJobs(second.deletionId)).toHaveLength(0);
  expect(await sharedResources(fixture.otherUserId)).toEqual(allSharedResources);
});
```

Historical deleted контрольный row остаётся; dry-run перед apply имеет нулевой write/external count; coordinator restart моделируется новым instance с expired lease.

- [ ] **Step 2: RED commit/push и PG FAIL**

Commit `test(privacy): полный synthetic deletion/reactivation (красный)` с trailer, push; новый PG suite. Expected: FAIL full flow не завершается / отсутствует wiring.

- [ ] **Step 3: GREEN — test-only composition root**

Synthetic использует реальные PG migrations/services и host-agent completion через `ProvisioningService.completeJob`, а не `UPDATE purged_at` напрямую; MinIO/Attendee/ElevenLabs/calendar fault adapters возвращают strict tri-state. Никакого Docker/SSH и платных внешних вызовов. `retentionMs` передаётся только constructor аргументом в тесте; production env не имеет укороченного cutoff.

`scripts/account-deletion-synthetic.ts` использует тот же composition root и требует одновременно `--apply --confirm-account-deletion-cleanup`, env `ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io` и hostname `ugliest-salmon`; иначе exit 2 до любой записи. Скрипт создаёт только synthetic IDs с префиксом `synthetic-deletion-`, в finally удаляет одноразовые тестовые fixtures по deletionId и печатает только `SYNTHETIC_TEST_OK` и counts.

- [ ] **Step 4: GREEN commit/push и PG PASS + broad tsc**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" add src/account-deletion/account-deletion.synthetic.pg.spec.ts src/account-deletion/account-deletion.synthetic.spec.ts scripts/account-deletion-synthetic.ts
git -C "$WT" commit -m "feat(privacy): synthetic проверка полного lifecycle" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_synthetic_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \"\$DB\" && trap 'dropdb -h /var/run/postgresql --if-exists \"\$DB\"' EXIT && PROVISIONING_PG_URL=\"postgres:///\$DB?host=/var/run/postgresql\" npx jest src/account-deletion/account-deletion.synthetic.pg.spec.ts src/account-deletion/account-deletion.synthetic.spec.ts --maxWorkers=2 && npx tsc -p tsconfig.json --noEmit && printf 'SYNTHETIC_PG_OK\n'"
```

Expected: `SYNTHETIC_PG_OK`, partial failures безопасно повторяются, чужие/shared resources сохранены. Live script здесь не запускать.

---

### Task 23: Platform KB и публичная политика до включения

**Files:**
- Modify: `src/platform-kb/articles/account.ts:28-48`
- Modify: `src/platform-kb/values.ts`
- Modify: `src/platform-kb/values.spec.ts`
- Modify: `src/account-deletion/account-deletion.safe.ts`
- Create: `src/platform-kb/account-deletion.spec.ts`

- [ ] **Step 1: RED — прежнее обещание сохранить ресурсы запрещено**

```typescript
import { account } from './articles/account';
import { renderArticle } from './render';
import { V } from './values';

describe('справка об удалении аккаунта', () => {
  const web = renderArticle(account,'ru','web');
  it('stop сразу, очистка через срок из production constant, reactivation отменяет', () => {
    expect(V.accountDeletionDays).toBe('30');
    expect(web).toContain(`через ${V.accountDeletionDays} дней`);
    expect(web).toMatch(/останавливаются сразу/);
    expect(web).toMatch(/повторная регистрация до очистки отменяет/);
    expect(web).not.toMatch(/Удаление аккаунта не трогает продукты/);
    expect(web).not.toContain('Отменить удаление аккаунта.');
  });
});
```

- [ ] **Step 2: RED commit/push и FAIL**

Commit `test(kb): политика stop/30-day cleanup (красный)` с trailer, push; `npx jest src/platform-kb`. Expected: FAIL старая строка «не трогает» и отсутствие reactivation/30 days.

- [ ] **Step 3: GREEN — точная замена account.ts**

В `account-deletion.safe.ts` экспортировать `ACCOUNT_DELETION_RETENTION_DAYS=30`, вычислять из него `ACCOUNT_DELETION_RETENTION_MS`; `V.accountDeletionDays=String(ACCOUNT_DELETION_RETENTION_DAYS)`. Текст статьи:

```text
- Удаление аккаунта: переписка с ассистентами, анкета, профиль и способы входа стираются сразу после остановки активной работы. Продукты, Telegram-боты, рутины, push и подключённые интеграции останавливаются сразу. Личные файлы, медиа, продукты, свои ассистенты, календари, голос, расшифровки и другие личные ресурсы удаляются или обезличиваются через ${V.accountDeletionDays} дней. Общие комнаты, чужие события и чужие данные сохраняются.
- Повторная регистрация до очистки отменяет её и возвращает аккаунт в активное состояние; после завершённой очистки восстановить ресурсы нельзя.
- При объединении ресурсы loser-аккаунта не переходят survivor-у и очищаются по тому же расписанию.
```

Раздел «Чего нельзя» заменяет «Отменить удаление» на «Восстановить ресурсы после завершённой очистки». Убрать весь прежний абзац про «не трогает» и «написать на support». Платежи/security logs и сроки их хранения не описывать как удаляемые.

- [ ] **Step 4: GREEN commit/push и PASS + render**

Commit `docs(kb): политика остановки и очистки удалённых аккаунтов` с trailer, push; `npx jest src/platform-kb --maxWorkers=2 && npx ts-node scripts/render-kb.ts ru web`. Expected: все KB suites PASS, digits guard принимает число из `V`, rendered account не содержит прежнего обещания.

---

## Фаза 6 — финальные gates и отдельно подтверждаемая активация

### Task 24: Финальные gates и staged dry-run/apply без активации prod worker

**Files:** код не изменяется, кроме исправлений отдельным RED/GREEN циклом при найденном дефекте.

- [ ] **Step 1: Полный related unit gate на точном GREEN SHA**

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/account-deletion-cleanup
git -C "$WT" push origin feat/account-deletion-cleanup
SHA=$(git -C "$WT" rev-parse HEAD)
ssh -n dv@85.192.61.231 "git -C ~/ci/wt/account-deletion-cleanup fetch -q origin && git -C ~/ci/wt/account-deletion-cleanup checkout -q --detach $SHA && cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx jest src/account-deletion src/profile src/identity src/routine-push src/push src/tg-bot src/custom-agents src/products src/calendar src/trip src/integrations src/talerid src/zoom src/voice-call src/meeting src/chat/chat-files src/misc src/video src/speech src/avatar src/voice-avatar src/events src/tasks src/support src/alert-bot src/peer src/contacts src/referral src/retention src/backup src/devices src/guest-trial src/platform-kb --maxWorkers=2 && printf 'FINAL_UNIT_OK\n'"
```

Expected: `FINAL_UNIT_OK`, ноль новых failures относительно Task 0.

- [ ] **Step 2: Полный related PG gate**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && DB=account_deletion_final_$(date +%s)_$$ && createdb -h /var/run/postgresql "$DB" && trap "dropdb -h /var/run/postgresql --if-exists \"$DB\"" EXIT && PROVISIONING_PG_URL="postgres:///$DB?host=/var/run/postgresql" npx jest src/account-deletion src/identity/identity.unlink.pg.spec.ts src/identity/identity.merge-deletion.pg.spec.ts src/identity/identity.reactivation.pg.spec.ts src/profile/profile-deletion.lifecycle.pg.spec.ts src/profile/profile-account-deletion.pg.spec.ts src/tg-bot/tg-config.private.pg.spec.ts src/products/product-lifecycle.pg.spec.ts src/products/product-purge.pg.spec.ts src/products/product-account-deletion.pg.spec.ts src/voice-call/voice-document-account-deletion.pg.spec.ts src/chat/chat-files/chat-file-account-deletion.pg.spec.ts src/peer/peer-account-deletion.pg.spec.ts src/referral/referral-account-deletion.pg.spec.ts src/misc/legacy-smm-account-deletion.pg.spec.ts --maxWorkers=2 && printf "FINAL_PG_OK\n"'
```

Expected: все PG suites PASS, не skipped, `FINAL_PG_OK`.

- [ ] **Step 3: Type/build/host gates**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.build.json --noEmit && npm run build && cd product-runner && npm ci --no-audit --no-fund && npx tsc -p tsconfig.json --noEmit && npm test -- --runInBand --runTestsByPath src/host/index.spec.ts src/host/purge.spec.ts src/host/sleep.spec.ts && printf "FINAL_BUILD_HOST_OK\n"'
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && npx tsc -p tsconfig.json --noEmit > /tmp/account-deletion-tsc-final.log 2>&1; rc=$?; printf "BROAD_TSC_FINAL_EXIT=%s ERRORS=%s\n" "$rc" "$(grep -c "error TS" /tmp/account-deletion-tsc-final.log || true)"; node -e '"'"'const fs=require("fs"); for (const f of process.argv.slice(1)) { const lines=fs.readFileSync(f,"utf8").split("\n").map((l)=>l.replace(/^(.+?)\(\d+,\d+\): (error TS\d+:.*)$/,"$1: $2")).sort(); fs.writeFileSync(f+".norm",lines.join("\n")+"\n"); }'"'"' /tmp/account-deletion-tsc-baseline.log /tmp/account-deletion-tsc-final.log && diff -u /tmp/account-deletion-tsc-baseline.log.norm /tmp/account-deletion-tsc-final.log.norm'
```

Expected: `FINAL_BUILD_HOST_OK`, production build и product-runner type/tests зелёные. Нормализованный diff широкого `tsconfig.json` пустой: исторические 172 baseline-ошибки не маскируют новые, новых ошибок нет.

- [ ] **Step 4: OWNER GATE A — test deploy с worker disabled**

Контроллер получает отдельный OK владельца на merge в main и `TEST_ONLY` deploy. Без этого OK шаг пропускается и выполнение останавливается. После OK интеграция выполняется через `superpowers:finishing-a-development-branch`, затем только:

```bash
TEST_ONLY=1 BACK_ONLY=1 bash /Users/dmitry/Downloads/spirits_back/scripts/deploy.sh
```

Expected: двухфазный prod шаг не запускался, test smoke `ALL PHASES GREEN`; `ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED=false`, активного coordinator нет.

- [ ] **Step 5: Test dry-run из CI дерева**

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && git fetch -q origin && git checkout -q --detach origin/main && set -a && . /home/dv/spirits_back/.env && set +a && PGOPTIONS="-c default_transaction_read_only=on" ./node_modules/.bin/ts-node scripts/account-deletion-dry-run.ts'
```

Expected: JSON только с `accounts/jobsByType/skipsByReason`, `ACCOUNT_DELETION_DRY_RUN_OK`; нет SQL writes/external calls, userId/secret/text в выводе.

- [ ] **Step 6: OWNER GATE B — synthetic apply только на test**

После отдельного OK владельца именно на destructive synthetic apply:

```bash
ssh -n dv@85.192.61.231 'cd ~/ci/wt/account-deletion-cleanup && source ~/.nvm/nvm.sh && set -a && . /home/dv/spirits_back/.env && set +a && ACCOUNT_DELETION_SYNTHETIC_ENV=test.linkeon.io ./node_modules/.bin/ts-node scripts/account-deletion-synthetic.ts --apply --confirm-account-deletion-cleanup'
```

Expected: `SYNTHETIC_TEST_OK`; reactivation отменила первое поколение, второе прошло full cleanup после ускоренного cutoff, MinIO/host/ElevenLabs/calendar failures повторены, shared/foreign resources сохранены. Любые реальные пользовательские строки не затрагиваются.

- [ ] **Step 7: OWNER GATE C — code на prod с worker disabled и prod dry-run**

После отдельного OK на обычный двухфазный deploy с выключенным worker:

```bash
BACK_ONLY=1 bash /Users/dmitry/Downloads/spirits_back/scripts/deploy.sh
ssh -n dvolkov@212.113.106.202 'cd /home/dvolkov/spirits_back && PGOPTIONS="-c default_transaction_read_only=on" ./node_modules/.bin/ts-node scripts/account-deletion-dry-run.ts'
```

Expected: оба smoke `ALL PHASES GREEN`, prod dry-run отдаёт только counts и `ACCOUNT_DELETION_DRY_RUN_OK`; никаких apply, bot/product stop или worker tick. Контроллер отдельно проверяет отсутствие SQL writes/external effects и сохраняет только безопасный summary. После этого выполнение останавливается до нового OK.

---

### Task 25: OWNER GATE D — отдельное включение prod worker

**Files:**
- Modify: `src/account-deletion/account-deletion.safe.ts` (`ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED`)
- Modify: `src/account-deletion/account-deletion.coordinator.pg.spec.ts`

Эта задача не начинается вместе с реализацией. Она возможна только после Task 24, финальных двух ревью каждой задачи и **нового отдельного OK владельца именно на активную prod очистку**.

- [ ] **Step 1: RED — activation test**

```typescript
it('после owner-approved activation worker по умолчанию включён, env=false остаётся аварийным выключателем', () => {
  expect(accountDeletionWorkerEnabled({})).toBe(true);
  expect(accountDeletionWorkerEnabled({ ACCOUNT_DELETION_WORKER_ENABLED:'false' })).toBe(false);
});
```

Commit `test(privacy): owner-approved activation flag (красный)` с trailer, push, запуск на ноде. Expected: FAIL текущее default false.

- [ ] **Step 2: GREEN — одна строка activation**

```typescript
export const ACCOUNT_DELETION_WORKER_DEFAULT_ENABLED = true;
```

Commit `feat(privacy): включение очистки удалённых аккаунтов после owner OK` с trailer, push, coordinator PG suite и финальные gates Task 24 Steps 1–3 повторить. Expected: default true, `env=false` отключает tick, остальные suites без дельты.

- [ ] **Step 3: Только `deploy.sh`, никакого ручного apply**

После merge через контроллера и ещё одного подтверждения, что OK владельца всё ещё действует:

```bash
BACK_ONLY=1 bash /Users/dmitry/Downloads/spirits_back/scripts/deploy.sh
```

Expected: test → smoke → prod → smoke зелёные; worker активируется только штатным кодом, hourly advisory lock и deletion generation действуют. Не запускать ручной prod apply, не удалять выбранные аккаунты, не менять env на сервере. Дальнейшие ручные удаления — только новыми отдельными подтверждениями владельца.

---

## Финальная проверка покрытия спецификации

- Lifecycle fields/historical/reactivation: Tasks 1, 18–20; merge survivor isolation: Task 19.
- Immediate routines/TG/products/integrations/voice stop до history: Tasks 5–11, 18–19.
- Chat file refs до `custom_chat_history`: Tasks 11, 17–18, повторный capture закрывает late writers.
- Persistent unique jobs, hourly keyset, advisory lock, leases/backoff/error isolation: Tasks 1–4.
- Все семь названных спецификацией доменных адаптеров + events + account core: Tasks 5–17; дополнительные tasks/support, peer/contacts, referral/outreach, backups/devices/guest/legacy auth и legacy SMM: Tasks 17A–17E; платежи/security logs/общие ресурсы явно сохраняются.
- MinIO/host/ElevenLabs/calendar failures: Tasks 8–9, 11–15, 22.
- Dry-run без writes/external effects: Tasks 3, 21, 24.
- Synthetic accelerated cutoff/reactivation/partial failures: Tasks 22, 24.
- KB до включения: Task 23; worker и prod apply только отдельные owner gates: Tasks 24–25.

## Главные риски и обязательные контрольные точки

1. **Reactivation race:** любой внешний и DB destructive шаг повторно проверяет generation; тест reactivation между graph и local delete обязателен.
2. **Late async writers:** SQL active predicates + второй capture перед core, а не только in-memory timers.
3. **Shared resources:** URL/UID не доказывает владение; shared speech, rooms, hosts, admin agents, global integrations и чужие events сохраняются.
4. **Unknown external result:** никогда не очищать последний ID и не отмечать done по timeout; `ON CONFLICT DO NOTHING` сохраняет payload retry.
5. **Host-agent asynchronous:** queued/running purge не равен удалённому host; relational cleanup только после `purged_at` и backup resolution.
6. **Startup migration locks:** catalog guards + advisory xact lock + 5s lock timeout; повторный прогон не должен брать CREATE INDEX locks.
7. **Dry-run ложный через Nest init:** CLI не поднимает AppModule, не запускает миграции/timers/external clients и работает под read-only PG transaction.
8. **Активация раньше политики:** KB и staged dry-run обязательны до Task 25; любой prod apply/worker enable требует нового OK владельца.
