# Durable Attendee Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Сделать приём Attendee webhook для Google Meet durable: сначала идемпотентно сохранять событие в PostgreSQL, затем доставлять в LiveKit с retry, recovery и ограниченным retention.

**Architecture:** `MeetWebhookController` проверяет HMAC и преобразует payload, `MeetingWebhookInboxStore` инкапсулирует SQL и миграцию, `MeetingWebhookDeliveryService` атомарно захватывает записи и асинхронно доставляет их. Семантика — at-least-once; формат сообщений voice-worker не меняется.

**Tech Stack:** NestJS 10, TypeScript, PostgreSQL 16, `pg`, Jest 29, Nest Schedule, LiveKit Server SDK.

**Spec:** `docs/superpowers/specs/2026-11-16-meet-webhook-durable-delivery-design.md`

## Статус и обязательные уточнения после reviews

- Task 1 завершён и принят на `6b575020`; Task 2 завершён и принят на `6d3858a1`.
  Их красные/зелёные snippets ниже — история TDD; фактический итог находится в текущем
  `src/meeting/meet-webhook-inbox.store.ts` и содержит дополнительные меры качества.
- `ClaimedInboxEvent.id` — **string**, потому что PostgreSQL BIGSERIAL/int8 возвращается из `pg`
  строкой. Все mocks и ожидания следующих задач используют строковые ID.
- Все завершения claim ограждены генерацией `attempts`. Итоговые сигнатуры:

```ts
markDelivered(id: string, claimAttempts: number): Promise<boolean>;
markDiscarded(id: string, claimAttempts: number, reason: string): Promise<boolean>;
markFailed(
  id: string,
  claimAttempts: number,
  error: string,
  nextRetryAt: Date,
): Promise<'pending' | 'dead' | null>;
```

`false`/`null` означает, что строка уже не принадлежит этой генерации claim; DeliveryService не
должен представлять такой исход как успешный переход или новый `dead`.

- Stale `processing` с `attempts >= 10` перед очередным claim переводится в `dead` с технической
  причиной lease expiry; попытка 11 не выдаётся. Stale строки с меньшим числом попыток reclaimable.
- Миграция дополнительно содержит non-partial `call_id` index для FK cascade и partial terminal
  `updated_at` index для retention. Retention counts используют `rowCount`, не `RETURNING` всех ID.

---

## Рабочие правила и CI

Работа идёт в ветке `docs/meet-webhook-inbox`; реализационные коммиты можно делать в ней же. Не переключать живые чекауты `~/spirits_back` и `~/spirits_front`. Не запускать Jest, TypeScript или build на Windows.

- [ ] **Step 1: Подготовить локальную ветку и CI-клон**

Выполнить в Git Bash из любого каталога:

```bash
git -C /d/Project/linkeon/spirits_back fetch origin
git -C /d/Project/linkeon/spirits_back status --short --branch
git -C /d/Project/linkeon/spirits_back push -u origin docs/meet-webhook-inbox
SHA=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npm ci"
```

Ожидание: рабочее дерево содержит только изменения текущей задачи; `npm ci` завершается кодом 0.

- [ ] **Step 2: Определить команды commit и прогона на тестовой ноде**

В том же Git Bash определить:

```bash
ATTRIB='Co-Authored-By: Kimi Code <noreply@moonshot.cn>'
run_ci() {
  local sha
  sha=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD) || return 1
  git -C /d/Project/linkeon/spirits_back push origin HEAD:docs/meet-webhook-inbox || return 1
  ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $sha && source ~/.nvm/nvm.sh && db=meet_inbox_\$(date +%s)_\$\$ && createdb -h /var/run/postgresql \$db && trap 'dropdb -h /var/run/postgresql --if-exists \$db' EXIT && PROVISIONING_PG_URL=\"postgres:///\$db?host=/var/run/postgresql\" npx jest $* --maxWorkers=2"
}
```

Каждый red/green прогон ниже выполняется через `run_ci`: тестовая нода получает код только из git и встаёт на конкретный SHA. Одноразовая БД удаляется через `trap` и при успехе, и при ошибке. Если тест красный по неожиданной причине — остановиться и исправить причину, не ослаблять assertion.

---

## Карта файлов

- Create `src/meeting/meet-webhook-inbox.store.ts` — типы inbox, migration runner и весь SQL.
- Create `src/meeting/migrations/006_meeting_webhook_events.sql` — таблица, constraints и индексы.
- Create `src/meeting/meet-webhook-inbox.pg.spec.ts` — реальные PostgreSQL-проверки SQL, конкуренции и каскада.
- Create `src/meeting/meet-webhook-delivery.service.ts` — pump, timeout, retry/backoff и retention scheduler.
- Create `src/meeting/meet-webhook-delivery.service.spec.ts` — поведение доставки без реальной сети.
- Modify `src/meeting/meet-webhook.controller.ts` — durable enqueue вместо process-local Set и прямого LiveKit send.
- Modify `src/meeting/meet-webhook.controller.spec.ts` — контракт приёма/подтверждения webhook.
- Modify `src/meeting/meeting.module.ts` — Nest wiring.
- Create `src/meeting/meeting.module.spec.ts` — проверка регистрации новых providers.
- Modify `src/account-deletion/account-deletion.synthetic.pg.spec.ts` — end-to-end проверка удаления inbox вместе с аккаунтом.

### Task 1: Миграция и идемпотентный enqueue

**Files:**

- Create: `src/meeting/migrations/006_meeting_webhook_events.sql`
- Create: `src/meeting/meet-webhook-inbox.store.ts`
- Create: `src/meeting/meet-webhook-inbox.pg.spec.ts`

- [ ] **Step 1: Написать failing PostgreSQL suite**

Создать `src/meeting/meet-webhook-inbox.pg.spec.ts`:

```ts
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MeetingWebhookInboxStore, NewInboxEvent } from './meet-webhook-inbox.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `meet_inbox_spec_${process.pid}`;
const CALL_ID = '11111111-1111-4111-8111-111111111111';

maybe('MeetingWebhookInboxStore PostgreSQL', () => {
  jest.setTimeout(30_000);
  let admin: Pool;
  let pool: Pool;
  let store: MeetingWebhookInboxStore;

  const event = (patch: Partial<NewInboxEvent> = {}): NewInboxEvent => ({
    callId: CALL_ID,
    idempotencyKey: 'key-1',
    trigger: 'bot.state_change',
    message: { v: 1, type: 'meet_bot_state', state: 'joined', fatal: false },
    ...patch,
  });

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 8, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(
      path.join(__dirname, '..', 'voice-call', 'migrations', '001_voice_calls.sql'), 'utf8',
    ));
    const pg = {
      query: (text: string, params?: any[]) => pool.query(text, params),
      getClient: () => pool.connect(),
    };
    store = new MeetingWebhookInboxStore(pg as any);
    await Promise.all([store.onModuleInit(), store.onModuleInit()]);
    await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status)
       VALUES ($1, 'inbox-user', 12, 'inbox-room', 'active')`,
      [CALL_ID],
    );
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM meeting_webhook_events');
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
  });

  it('параллельный startup применяет миграцию один раз', async () => {
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM schema_migrations WHERE filename = $1`,
      ['meeting/006_meeting_webhook_events.sql'],
    );
    expect(r.rows[0].n).toBe(1);
    expect(await store.onModuleInit()).toBeUndefined();
  });

  it('один ключ создаёт одну строку при конкурентном enqueue', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.enqueue(event())));
    expect(results.filter((x) => x === 'inserted')).toHaveLength(1);
    expect(results.filter((x) => x === 'duplicate')).toHaveLength(7);
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events');
    expect(r.rows[0].n).toBe(1);
  });

  it('NULL keys не сливают разные повторы', async () => {
    expect(await store.enqueue(event({ idempotencyKey: null }))).toBe('inserted');
    expect(await store.enqueue(event({ idempotencyKey: null }))).toBe('inserted');
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events');
    expect(r.rows[0].n).toBe(2);
  });

  it('ON DELETE CASCADE удаляет inbox вместе со звонком', async () => {
    const callId = randomUUID();
    await pool.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status)
       VALUES ($1, 'inbox-user', 12, $2, 'active')`,
      [callId, `room-${callId}`],
    );
    await store.enqueue(event({ callId }));
    await pool.query('DELETE FROM voice_calls WHERE id = $1', [callId]);
    const r = await pool.query('SELECT count(*)::int AS n FROM meeting_webhook_events WHERE call_id = $1', [callId]);
    expect(r.rows[0].n).toBe(0);
  });
});
```

- [ ] **Step 2: Закоммитить red-тест и подтвердить падение**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook-inbox.pg.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): красный PostgreSQL suite durable inbox" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: FAIL, TypeScript сообщает, что `./meet-webhook-inbox.store` не найден. Suite не должен быть `SKIP`: проверить, что `PROVISIONING_PG_URL` передан.

- [ ] **Step 3: Добавить миграцию**

Создать `src/meeting/migrations/006_meeting_webhook_events.sql`:

```sql
CREATE TABLE IF NOT EXISTS meeting_webhook_events (
  id               BIGSERIAL PRIMARY KEY,
  call_id          UUID NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
  idempotency_key  TEXT,
  trigger          TEXT NOT NULL,
  message          JSONB NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'processing', 'delivered', 'discarded', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_retry_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS meeting_webhook_events_key_idx
  ON meeting_webhook_events (call_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS meeting_webhook_events_due_idx
  ON meeting_webhook_events (next_retry_at, created_at, id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS meeting_webhook_events_stale_idx
  ON meeting_webhook_events (updated_at)
  WHERE status = 'processing';
```

- [ ] **Step 4: Реализовать startup migration и enqueue**

Создать `src/meeting/meet-webhook-inbox.store.ts`:

```ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PoolClient } from 'pg';
import { PgService } from '../common/services/pg.service';

export interface NewInboxEvent {
  callId: string;
  idempotencyKey: string | null;
  trigger: string;
  message: Record<string, unknown>;
}

export interface ClaimedInboxEvent {
  id: string; // BIGSERIAL/int8 приходит из pg строкой
  callId: string;
  trigger: string;
  message: Record<string, unknown>;
  attempts: number;
  recovered?: boolean;
}

@Injectable()
export class MeetingWebhookInboxStore implements OnModuleInit {
  private readonly logger = new Logger(MeetingWebhookInboxStore.name);
  private static readonly MIGRATION = '006_meeting_webhook_events.sql';
  private static readonly MIGRATION_NAME = `meeting/${MeetingWebhookInboxStore.MIGRATION}`;

  constructor(private readonly pg: PgService) {}

  async onModuleInit(): Promise<void> {
    const file = [
      path.join(__dirname, 'migrations', MeetingWebhookInboxStore.MIGRATION),
      path.join(__dirname, '..', '..', 'src', 'meeting', 'migrations', MeetingWebhookInboxStore.MIGRATION),
    ].find((candidate) => fs.existsSync(candidate));
    if (!file) {
      this.logger.warn('meeting webhook migration not found');
      return;
    }

    let client: PoolClient | null = null;
    try {
      client = await this.pg.getClient();
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '3s'");
      await client.query('SELECT pg_advisory_xact_lock(8675309)');
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
      const done = await client.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1',
        [MeetingWebhookInboxStore.MIGRATION_NAME],
      );
      if (done.rows.length) {
        await client.query('COMMIT');
        return;
      }
      await client.query(fs.readFileSync(file, 'utf8'));
      await client.query(
        'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
        [MeetingWebhookInboxStore.MIGRATION_NAME],
      );
      await client.query('COMMIT');
      this.logger.log(`meeting webhook migration applied: ${MeetingWebhookInboxStore.MIGRATION}`);
    } catch (e: any) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      this.logger.error(`meeting webhook migration failed: ${e?.message}`);
    } finally {
      client?.release();
    }
  }

  async enqueue(input: NewInboxEvent): Promise<'inserted' | 'duplicate'> {
    const r = await this.pg.query(
      `INSERT INTO meeting_webhook_events (call_id, idempotency_key, trigger, message)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (call_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.callId, input.idempotencyKey, input.trigger, JSON.stringify(input.message)],
    );
    const inserted = r.rows.length > 0;
    this.logger.debug(
      `[meet] inbox ${inserted ? 'inserted' : 'duplicate'} call=${input.callId} trigger=${input.trigger}`,
    );
    return inserted ? 'inserted' : 'duplicate';
  }
}
```

- [ ] **Step 5: Закоммитить реализацию и подтвердить green**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook-inbox.store.ts src/meeting/migrations/006_meeting_webhook_events.sql
git -C /d/Project/linkeon/spirits_back commit -m "feat(meeting): durable inbox migration и идемпотентный enqueue" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: `Tests: 4 passed, 4 total`; suite не skipped.

### Task 2: Claim, retry states и retention в реальной БД

**Files:**

- Modify: `src/meeting/meet-webhook-inbox.store.ts`
- Modify: `src/meeting/meet-webhook-inbox.pg.spec.ts`

- [ ] **Step 1: Добавить failing state-machine тесты**

Добавить в PostgreSQL suite перед закрывающим `});`:

```ts
  it('атомарный claim исключает двойной захват и поднимает stale processing', async () => {
    await store.enqueue(event());
    const claims = await Promise.all([store.claimBatch(), store.claimBatch()]);
    expect(claims.flat()).toHaveLength(1);
    expect(claims.flat()[0].attempts).toBe(1);
    expect(await store.claimBatch()).toHaveLength(0);

    await pool.query(
      `UPDATE meeting_webhook_events SET updated_at = now() - interval '61 seconds'`,
    );
    const stale = await store.claimBatch();
    expect(stale).toHaveLength(1);
    expect(stale[0].attempts).toBe(2);
    expect(stale[0].recovered).toBe(true);
  });

  it('failure возвращает pending с задержкой, десятая попытка становится dead', async () => {
    await store.enqueue(event());
    const [claimed] = await store.claimBatch();
    const retryAt = new Date(Date.now() + 1000);
    expect(await store.markFailed(claimed.id, claimed.attempts, 'temporary', retryAt)).toBe('pending');
    expect(await store.claimBatch()).toHaveLength(0);

    await pool.query(
      `UPDATE meeting_webhook_events
          SET attempts = 9, next_retry_at = now() - interval '1 second'`,
    );
    const [last] = await store.claimBatch();
    expect(last.attempts).toBe(10);
    expect(await store.markFailed(last.id, last.attempts, 'permanent', retryAt)).toBe('dead');
    const r = await pool.query(`SELECT status, last_error FROM meeting_webhook_events`);
    expect(r.rows[0]).toEqual({ status: 'dead', last_error: 'permanent' });
  });

  it('success и inactive переводят processing в delivered/discarded', async () => {
    await store.enqueue(event({ idempotencyKey: 'deliver' }));
    await store.enqueue(event({ idempotencyKey: 'discard' }));
    const claimed = (await store.claimBatch()).sort((a, b) => Number(a.id) - Number(b.id));
    await store.markDelivered(claimed[0].id);
    await store.markDiscarded(claimed[1].id, 'call inactive');
    const r = await pool.query(
      `SELECT status, delivered_at IS NOT NULL AS has_delivery, last_error
         FROM meeting_webhook_events ORDER BY id`,
    );
    expect(r.rows[0].status).toBe('delivered');
    expect(r.rows[0].has_delivery).toBe(true);
    expect(r.rows[1]).toEqual({ status: 'discarded', has_delivery: false, last_error: 'call inactive' });
  });

  it('retention удаляет только завершённые записи нужного возраста', async () => {
    for (const status of ['delivered', 'discarded', 'dead', 'pending', 'processing']) {
      await store.enqueue(event({ idempotencyKey: `retention-${status}` }));
      await pool.query(
        `UPDATE meeting_webhook_events
            SET status = $1,
                updated_at = CASE WHEN $1 = 'dead' THEN now() - interval '8 days'
                                  ELSE now() - interval '25 hours' END
          WHERE idempotency_key = $2`,
        [status, `retention-${status}`],
      );
    }
    await store.cleanup();
    const r = await pool.query(
      `SELECT idempotency_key FROM meeting_webhook_events ORDER BY idempotency_key`,
    );
    expect(r.rows.map((x) => x.idempotency_key)).toEqual(['retention-pending', 'retention-processing']);
  });
```

- [ ] **Step 2: Закоммитить red и проверить отсутствие методов**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook-inbox.pg.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): красные состояния durable inbox" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: FAIL с `store.claimBatch is not a function`.

- [ ] **Step 3: Реализовать атомарный SQL и переходы**

Добавить методы внутрь `MeetingWebhookInboxStore` после `enqueue`:

```ts
  async claimBatch(limit = 20): Promise<ClaimedInboxEvent[]> {
    const r = await this.pg.query(
      `WITH candidates AS (
         SELECT id, (status = 'processing') AS recovered
           FROM meeting_webhook_events
          WHERE (status = 'pending' AND next_retry_at <= now())
             OR (status = 'processing' AND updated_at < now() - interval '60 seconds')
          ORDER BY next_retry_at, created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE meeting_webhook_events AS e
          SET status = 'processing', attempts = e.attempts + 1, updated_at = now()
         FROM candidates
        WHERE e.id = candidates.id
        RETURNING e.id, e.call_id AS "callId", e.trigger, e.message, e.attempts,
                  candidates.recovered`,
      [limit],
    );
    return r.rows;
  }

  async markDelivered(id: number): Promise<void> {
    await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = 'delivered', delivered_at = now(), updated_at = now(), last_error = NULL
        WHERE id = $1 AND status = 'processing'`,
      [id],
    );
  }

  async markDiscarded(id: number, reason: string): Promise<void> {
    await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = 'discarded', last_error = left($2, 500), updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id, reason],
    );
  }

  async markFailed(
    id: number,
    attempts: number,
    error: string,
    nextRetryAt: Date,
  ): Promise<'pending' | 'dead'> {
    const status = attempts >= 10 ? 'dead' : 'pending';
    await this.pg.query(
      `UPDATE meeting_webhook_events
          SET status = $2, last_error = left($3, 500), next_retry_at = $4::timestamptz, updated_at = now()
        WHERE id = $1 AND status = 'processing'`,
      [id, status, error, nextRetryAt.toISOString()],
    );
    return status;
  }

  async cleanup(): Promise<{ completed: number; dead: number }> {
    const completed = await this.pg.query(
      `DELETE FROM meeting_webhook_events
        WHERE status IN ('delivered', 'discarded')
          AND updated_at < now() - interval '24 hours'
        RETURNING id`,
    );
    const dead = await this.pg.query(
      `DELETE FROM meeting_webhook_events
        WHERE status = 'dead' AND updated_at < now() - interval '7 days'
        RETURNING id`,
    );
    return { completed: completed.rows.length, dead: dead.rows.length };
  }
```

- [ ] **Step 4: Закоммитить и проверить green**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook-inbox.store.ts
git -C /d/Project/linkeon/spirits_back commit -m "feat(meeting): атомарные claims retry и retention" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: `Tests: 8 passed, 8 total`; все SQL assertions зелёные.

### Task 3: Durable receive вместо Set и прямого LiveKit send

**Files:**

- Modify: `src/meeting/meet-webhook.controller.ts`
- Modify: `src/meeting/meet-webhook.controller.spec.ts`

- [ ] **Step 1: Перевести controller suite на inbox contract**

В `src/meeting/meet-webhook.controller.spec.ts` заменить setup на:

```ts
  let inbox: { enqueue: jest.Mock };
  let delivery: { kick: jest.Mock };
  let calls: { load: jest.Mock; isActive: jest.Mock };
  let ctl: MeetWebhookController;

  beforeEach(() => {
    process.env.ATTENDEE_WEBHOOK_SECRET = SECRET;
    inbox = { enqueue: jest.fn().mockResolvedValue('inserted') };
    delivery = { kick: jest.fn() };
    calls = {
      load: jest.fn().mockResolvedValue({ id: 'c1', room_name: 'meet_c1', status: 'active' }),
      isActive: jest.fn().mockReturnValue(true),
    };
    ctl = new MeetWebhookController(calls as any, inbox as any, delivery as any);
  });

  const sent = () => inbox.enqueue.mock.calls[0][0].message;
```

Во всех conversion-тестах заменить `livekit.send.mock.calls[0][1]` на `sent()`, а
`livekit.send.mockClear()` на `inbox.enqueue.mockClear()`. Все отрицательные assertions
`expect(livekit.send).not.toHaveBeenCalled()` заменить на
`expect(inbox.enqueue).not.toHaveBeenCalled()`.

Первый participant test должен стать:

```ts
  it('вход участника сохраняется для комнаты звонка', async () => {
    const p = hook('participant_events.join_leave', {
      participant_name: 'Сергей', participant_uuid: 'u1', event_type: 'join', timestamp_ms: 1,
    });
    await ctl.receive(sign(p), p as any);
    expect(inbox.enqueue).toHaveBeenCalledWith({
      callId: 'c1', idempotencyKey: 'k1', trigger: 'participant_events.join_leave',
      message: { v: 1, type: 'meet_participant', event: 'join', uuid: 'u1', name: 'Сергей' },
    });
    expect(delivery.kick).toHaveBeenCalledTimes(1);
  });
```

Chat test должен проверять:

```ts
    expect(sent()).toEqual({
      v: 1, type: 'meet_chat',
      text: 'https://www.google.com/', sender: 'Владимир', uuid: 'u1', private: false,
    });
```

Удалить тесты старого in-memory eviction и прямого LiveKit failure. Заменить тесты duplicate,
unknown/load failure и insert errors на:

```ts
  it('подтверждённый duplicate безопасен и запускает pump', async () => {
    inbox.enqueue.mockResolvedValue('duplicate');
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
    expect(delivery.kick).toHaveBeenCalledTimes(1);
  });

  it('неизвестный звонок игнорируется', async () => {
    calls.load.mockResolvedValue(null);
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
    expect(inbox.enqueue).not.toHaveBeenCalled();
  });

  it('ошибка загрузки звонка даёт retryable 503', async () => {
    calls.load.mockRejectedValue(new Error('db down'));
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).rejects.toThrow(ServiceUnavailableException);
    expect(inbox.enqueue).not.toHaveBeenCalled();
  });

  it('ошибка INSERT даёт retryable 503', async () => {
    inbox.enqueue.mockRejectedValue(new Error('inbox down'));
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).rejects.toThrow(ServiceUnavailableException);
    expect(delivery.kick).not.toHaveBeenCalled();
  });

  it('удаление звонка в гонке INSERT подтверждается без retry', async () => {
    inbox.enqueue.mockRejectedValue({ code: '23503' });
    const p = hook('bot.state_change', { new_state: 'joined' });
    await expect(ctl.receive(sign(p), p as any)).resolves.toEqual({ ok: true });
    expect(delivery.kick).not.toHaveBeenCalled();
  });
```

В тесте разных ключей ожидать `inbox.enqueue` дважды. В тесте завершённого звонка оставить
`calls.isActive.mockReturnValue(false)` и проверять отсутствие enqueue.

- [ ] **Step 2: Закоммитить red и проверить старый constructor**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook.controller.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): красный durable receive contract" -m "$ATTRIB"
run_ci src/meeting/meet-webhook.controller.spec.ts
```

Ожидание: FAIL на несовпадении constructor/отсутствии enqueue в старом controller.

- [ ] **Step 3: Заменить controller receive path**

В `src/meeting/meet-webhook.controller.ts` удалить импорт `LiveKitClient`, поле `seen`,
`SEEN_LIMIT` и метод `remember`. Добавить imports:

```ts
import { MeetingWebhookInboxStore } from './meet-webhook-inbox.store';
import { MeetingWebhookDeliveryService } from './meet-webhook-delivery.service';
```

Заменить constructor и часть `receive` после проверки подписи на:

```ts
  constructor(
    private readonly calls: VoiceCallService,
    private readonly inbox: MeetingWebhookInboxStore,
    private readonly delivery: MeetingWebhookDeliveryService,
  ) {}

  async receive(
    @Headers('x-webhook-signature') signature: string,
    @Body() body: AttendeeHook,
  ): Promise<{ ok: true }> {
    const secret = process.env.ATTENDEE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('attendee webhooks are not configured');
    if (!verifyAttendeeSignature(secret, body, signature)) {
      this.logger.warn(
        `[meet] подпись не сошлась, trigger=${body?.trigger} канонизация=${canonicalJson(body).slice(0, 500)}`,
      );
      throw new UnauthorizedException('bad signature');
    }

    const callId = body.bot_metadata?.callId;
    if (!callId) return { ok: true };
    const msg = this.toDataMessage(body);
    if (!msg) return { ok: true };

    const call = await this.calls.load(callId).catch((e: any) => {
      this.logger.error(`[meet] не удалось загрузить звонок перед inbox: ${e?.message}`);
      throw new ServiceUnavailableException('voice calls unavailable');
    });
    if (!call || !this.calls.isActive(call)) return { ok: true };

    try {
      await this.inbox.enqueue({
        callId,
        idempotencyKey: body.idempotency_key || null,
        trigger: body.trigger,
        message: msg,
      });
    } catch (e: any) {
      if (e?.code === '23503') return { ok: true };
      this.logger.error(`[meet] inbox INSERT failed, trigger=${body.trigger}: ${e?.message}`);
      throw new ServiceUnavailableException('webhook inbox unavailable');
    }

    this.delivery.kick();
    return { ok: true };
  }
```

Сохранить декораторы `@Post('attendee')`, `@Headers`, `@Body` и весь `toDataMessage` без изменений.
Обновить верхний комментарий: после подписи `{ok:true}` означает durable enqueue/duplicate либо
намеренно отфильтрованное событие; `503` возвращается, когда полезен ретрай Attendee.

Controller и DeliveryService коммитятся вместе после green в Task 4: промежуточный TypeScript-код
не должен ссылаться на ещё не созданный модуль.

### Task 4: DeliveryService, timeout и at-least-once recovery

**Files:**

- Create: `src/meeting/meet-webhook-delivery.service.ts`
- Create: `src/meeting/meet-webhook-delivery.service.spec.ts`
- Modify: `src/meeting/meet-webhook.controller.ts`

- [ ] **Step 1: Написать failing delivery suite**

Создать `src/meeting/meet-webhook-delivery.service.spec.ts`:

```ts
import { MeetingWebhookDeliveryService, retryDelayMs } from './meet-webhook-delivery.service';

const EVENT = {
  id: '1',
  callId: 'c1',
  trigger: 'bot.state_change',
  message: { v: 1, type: 'meet_bot_state', state: 'joined', fatal: false },
  attempts: 1,
};

describe('MeetingWebhookDeliveryService', () => {
  let inbox: any;
  let calls: any;
  let livekit: any;
  let service: MeetingWebhookDeliveryService;

  beforeEach(() => {
    inbox = {
      claimBatch: jest.fn().mockResolvedValue([]),
      markDelivered: jest.fn().mockResolvedValue(true),
      markDiscarded: jest.fn().mockResolvedValue(true),
      markFailed: jest.fn().mockResolvedValue('pending'),
      cleanup: jest.fn().mockResolvedValue({ completed: 0, dead: 0 }),
    };
    calls = {
      load: jest.fn().mockResolvedValue({ room_name: 'meet_c1', status: 'active' }),
      isActive: jest.fn().mockReturnValue(true),
    };
    livekit = { send: jest.fn().mockResolvedValue(undefined) };
    service = new MeetingWebhookDeliveryService(inbox, calls, livekit);
  });

  afterEach(() => jest.useRealTimers());

  it('доставляет сохранённое сообщение без изменения формата', async () => {
    inbox.claimBatch.mockResolvedValue([EVENT]);
    await service.pump();
    expect(livekit.send).toHaveBeenCalledWith('meet_c1', EVENT.message);
    expect(inbox.markDelivered).toHaveBeenCalledWith('1', 1);
    expect(inbox.markFailed).not.toHaveBeenCalled();
  });

  it('закрытый звонок discard, а не бесконечный retry', async () => {
    inbox.claimBatch.mockResolvedValue([EVENT]);
    calls.isActive.mockReturnValue(false);
    await service.pump();
    expect(inbox.markDiscarded).toHaveBeenCalledWith('1', 1, 'call missing or inactive');
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('временный LiveKit failure получает retry, следующий pump завершает delivered', async () => {
    inbox.claimBatch
      .mockResolvedValueOnce([EVENT])
      .mockResolvedValueOnce([{ ...EVENT, attempts: 2 }]);
    livekit.send.mockRejectedValueOnce(new Error('room unavailable')).mockResolvedValueOnce(undefined);
    await service.pump();
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'room unavailable', expect.any(Date));
    await service.pump();
    expect(inbox.markDelivered).toHaveBeenCalledWith('1', 2);
    expect(livekit.send).toHaveBeenCalledTimes(2);
  });

  it('ошибка calls.load retryable, десятая попытка становится dead', async () => {
    inbox.claimBatch.mockResolvedValue([{ ...EVENT, attempts: 10 }]);
    calls.load.mockRejectedValue(new Error('postgres down'));
    inbox.markFailed.mockResolvedValue('dead');
    await service.pump();
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 10, 'postgres down', expect.any(Date));
    expect(livekit.send).not.toHaveBeenCalled();
  });

  it('LiveKit timeout превращается в bounded retry', async () => {
    jest.useFakeTimers();
    inbox.claimBatch.mockResolvedValue([EVENT]);
    livekit.send.mockReturnValue(new Promise(() => {}));
    const pumping = service.pump();
    await jest.advanceTimersByTimeAsync(10_000);
    await pumping;
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'livekit send timeout', expect.any(Date));
  });

  it('падение после send, но до delivered, оставляет событие на повтор', async () => {
    inbox.claimBatch.mockResolvedValue([EVENT]);
    inbox.markDelivered.mockRejectedValue(new Error('db died after send'));
    await service.pump();
    expect(livekit.send).toHaveBeenCalledTimes(1);
    expect(inbox.markFailed).toHaveBeenCalledWith('1', 1, 'db died after send', expect.any(Date));
  });

  it('reentrant pump не захватывает вторую партию параллельно', async () => {
    let release!: () => void;
    inbox.claimBatch.mockReturnValue(new Promise((resolve) => {
      release = () => resolve([]);
    }));
    const first = service.pump();
    await service.pump();
    expect(inbox.claimBatch).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('backoff соответствует спеке, retention использует store cleanup', async () => {
    expect([1, 2, 3, 4, 5, 10].map(retryDelayMs)).toEqual([1000, 2000, 5000, 15000, 60000, 60000]);
    await service.retention();
    expect(inbox.cleanup).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Закоммитить controller + red delivery suite и проверить FAIL**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook.controller.ts src/meeting/meet-webhook.controller.spec.ts src/meeting/meet-webhook-delivery.service.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): красный asynchronous delivery и durable controller" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-delivery.service.spec.ts src/meeting/meet-webhook.controller.spec.ts
```

Ожидание: FAIL, потому что `./meet-webhook-delivery.service` ещё не существует.

- [ ] **Step 3: Реализовать DeliveryService**

Создать `src/meeting/meet-webhook-delivery.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import {
  ClaimedInboxEvent,
  MeetingWebhookInboxStore,
} from './meet-webhook-inbox.store';

export const retryDelayMs = (attempts: number): number =>
  [1000, 2000, 5000, 15000][attempts - 1] ?? 60_000;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

@Injectable()
export class MeetingWebhookDeliveryService {
  private readonly logger = new Logger(MeetingWebhookDeliveryService.name);
  private running = false;

  constructor(
    private readonly inbox: MeetingWebhookInboxStore,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
  ) {}

  kick(): void {
    void this.pump().catch((e: any) => this.logger.error(`[meet] inbox pump failed: ${e?.message}`));
  }

  @Interval(1000)
  poll(): void {
    this.kick();
  }

  @Interval(60 * 60 * 1000)
  async retention(): Promise<void> {
    await this.inbox.cleanup().catch((e: any) => {
      this.logger.error(`[meet] inbox retention failed: ${e?.message}`);
    });
  }

  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const events = await this.inbox.claimBatch(20);
      await mapLimit(events, 5, (event) => this.deliver(event));
    } finally {
      this.running = false;
    }
  }

  private async deliver(event: ClaimedInboxEvent): Promise<void> {
    if (event.recovered) this.logger.warn(`[meet] recovered stale inbox event=${event.id}`);
    try {
      const call = await this.calls.load(event.callId);
      if (!call || !this.calls.isActive(call)) {
        const discarded = await this.inbox.markDiscarded(
          event.id, event.attempts, 'call missing or inactive',
        );
        if (!discarded) this.logger.debug(`[meet] stale discard ignored event=${event.id}`);
        return;
      }
      await this.sendWithTimeout(call.room_name, event.message);
      const delivered = await this.inbox.markDelivered(event.id, event.attempts);
      if (!delivered) this.logger.warn(`[meet] stale delivery completion ignored event=${event.id}`);
    } catch (e: any) {
      const error = String(e?.message ?? e).slice(0, 500);
      const delayMs = retryDelayMs(event.attempts);
      try {
        const status = await this.inbox.markFailed(
          event.id,
          event.attempts,
          error,
          new Date(Date.now() + delayMs),
        );
        if (status === null) {
          this.logger.debug(`[meet] stale failure ignored event=${event.id} attempt=${event.attempts}`);
          return;
        }
        const log = `[meet] inbox event=${event.id} attempt=${event.attempts} status=${status} nextRetryMs=${delayMs}: ${error}`;
        if (status === 'dead') this.logger.error(log);
        else this.logger.warn(log);
      } catch (dbError: any) {
        this.logger.error(`[meet] cannot record failure event=${event.id}: ${dbError?.message}`);
      }
    }
  }

  private async sendWithTimeout(roomName: string, message: Record<string, unknown>): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.livekit.send(roomName, message as any),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('livekit send timeout')), 10_000);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Закоммитить green implementation и прогнать оба suite**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meet-webhook-delivery.service.ts src/meeting/meet-webhook.controller.ts
git -C /d/Project/linkeon/spirits_back commit -m "feat(meeting): асинхронная LiveKit доставка с retry и recovery" -m "$ATTRIB"
run_ci src/meeting/meet-webhook-delivery.service.spec.ts src/meeting/meet-webhook.controller.spec.ts src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: controller, delivery и PostgreSQL suites PASS; таймаутный тест завершается fake timers,
а не реальными 10 секундами.

### Task 5: Nest wiring

**Files:**

- Modify: `src/meeting/meeting.module.ts`
- Create: `src/meeting/meeting.module.spec.ts`

- [ ] **Step 1: Написать failing metadata test**

Создать `src/meeting/meeting.module.spec.ts`:

```ts
import 'reflect-metadata';
import { MeetingModule } from './meeting.module';
import { MeetingWebhookDeliveryService } from './meet-webhook-delivery.service';
import { MeetingWebhookInboxStore } from './meet-webhook-inbox.store';

describe('MeetingModule durable webhook', () => {
  it('регистрирует Store и DeliveryService', () => {
    const providers = Reflect.getMetadata('providers', MeetingModule) as any[];
    expect(providers).toContain(MeetingWebhookInboxStore);
    expect(providers).toContain(MeetingWebhookDeliveryService);
  });
});
```

- [ ] **Step 2: Подтвердить red**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meeting.module.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): красный wiring durable inbox" -m "$ATTRIB"
run_ci src/meeting/meeting.module.spec.ts
```

Ожидание: FAIL, providers не содержат новые классы.

- [ ] **Step 3: Зарегистрировать providers**

Добавить imports в `src/meeting/meeting.module.ts`:

```ts
import { MeetingWebhookDeliveryService } from './meet-webhook-delivery.service';
import { MeetingWebhookInboxStore } from './meet-webhook-inbox.store';
```

Заменить providers на:

```ts
  providers: [MeetingService, AttendeeClient, MeetingWebhookInboxStore, MeetingWebhookDeliveryService],
```

- [ ] **Step 4: Подтвердить green**

```bash
git -C /d/Project/linkeon/spirits_back add src/meeting/meeting.module.ts
git -C /d/Project/linkeon/spirits_back commit -m "feat(meeting): подключить durable webhook providers" -m "$ATTRIB"
run_ci src/meeting
```

Ожидание: все `src/meeting` suites PASS.

### Task 6: Проверка удаления аккаунта на полном synthetic контуре

**Files:**

- Modify: `src/account-deletion/account-deletion.synthetic.pg.spec.ts`

- [ ] **Step 1: Добавить failing assertion после финального удаления**

В тесте `synthetic: stop → reactivate cancel → новое удаление → partial failures → retry → done`
сразу после `expect(await sharedResources(...)).toEqual(...)` добавить:

```ts
    const inboxOwners = await rows(
      `SELECT idempotency_key FROM meeting_webhook_events
        WHERE idempotency_key LIKE 'synthetic-inbox-%' ORDER BY idempotency_key`,
    );
    expect(inboxOwners).toEqual([
      { idempotency_key: `synthetic-inbox-${fixture.otherUserId}` },
    ]);
```

- [ ] **Step 2: Подтвердить red**

```bash
git -C /d/Project/linkeon/spirits_back add src/account-deletion/account-deletion.synthetic.pg.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(privacy): красная проверка каскада meeting inbox" -m "$ATTRIB"
run_ci src/account-deletion/account-deletion.synthetic.pg.spec.ts
```

Ожидание: FAIL: таблица отсутствует в synthetic schema либо control row другого пользователя не
была засеяна.

- [ ] **Step 3: Добавить реальную миграцию и контрольные записи**

После строки:

```ts
    await migration('meeting/migrations/005_zoom_url.sql');
```

добавить:

```ts
    await migration('meeting/migrations/006_meeting_webhook_events.sql');
```

После применения всех миграций, но до запуска deletion scenarios, добавить seed:

```ts
    await pool.query(
      `INSERT INTO meeting_webhook_events (call_id, idempotency_key, trigger, message)
       SELECT id,
              'synthetic-inbox-' || user_id,
              'bot.state_change',
              '{"v":1,"type":"meet_bot_state","state":"joined","fatal":false}'::jsonb
         FROM voice_calls`,
    );
```

После финального удаления обе inbox-строки основного пользователя должны исчезнуть каскадом,
строка `otherUserId` обязана остаться. Это проверяет и удаление, и отсутствие cross-user cascade.

- [ ] **Step 4: Подтвердить green**

```bash
git -C /d/Project/linkeon/spirits_back add src/account-deletion/account-deletion.synthetic.pg.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(privacy): удалить meeting inbox каскадно с аккаунтом" -m "$ATTRIB"
run_ci src/account-deletion/account-deletion.synthetic.pg.spec.ts src/meeting/meet-webhook-inbox.pg.spec.ts
```

Ожидание: оба PostgreSQL suite PASS, новый inbox assertion зелёный.

### Task 7: Полная проверка, merge и штатный deploy

**Files:**

- No planned file changes; verification and release only. Any defect fix must name and test the actual failing file in a new commit.

- [ ] **Step 1: Синхронизировать ветку с двигающимся origin/main**

```bash
git -C /d/Project/linkeon/spirits_back fetch origin
git -C /d/Project/linkeon/spirits_back merge --no-ff origin/main -m "Merge origin/main into durable webhook" -m "$ATTRIB"
```

Если ветка уже содержит `origin/main`, Git сообщит `Already up to date.` и не создаст commit. Если
есть conflict — остановиться, разрешить по текущему коду и повторить все целевые тесты. Не force-push
и не amend опубликованных коммитов.

- [ ] **Step 2: Прогнать все целевые PostgreSQL и unit suites**

```bash
run_ci src/meeting src/voice-call src/account-deletion/account-deletion.synthetic.pg.spec.ts
```

Ожидание: PASS; `meet-webhook-inbox.pg.spec.ts` и account-deletion suite не skipped.

- [ ] **Step 3: Прогнать полный backend suite и build на тестовой ноде**

```bash
SHA=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD)
git -C /d/Project/linkeon/spirits_back push origin HEAD:docs/meet-webhook-inbox
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $SHA && source ~/.nvm/nvm.sh && npx jest --maxWorkers=2 && npm run build"
```

Ожидание: полный Jest PASS; без `PROVISIONING_PG_URL` специализированные PG suites могут быть
skipped, но их обязательные зелёные прогоны уже выполнены в Step 2. `nest build` завершается 0.

- [ ] **Step 4: Проверить diff и отсутствие незапланированных файлов**

```bash
git -C /d/Project/linkeon/spirits_back diff --check origin/main...HEAD
git -C /d/Project/linkeon/spirits_back diff --stat origin/main...HEAD
git -C /d/Project/linkeon/spirits_back status --short --branch
```

Ожидание: diff ограничен meeting inbox/controller/delivery/module, новой миграцией, тестами и
account-deletion synthetic suite. Секретов и `.env` в diff нет.

- [ ] **Step 5: Влить main без force-push**

```bash
git -C /d/Project/linkeon/spirits_back switch main
git -C /d/Project/linkeon/spirits_back pull --ff-only origin main
git -C /d/Project/linkeon/spirits_back merge --no-ff docs/meet-webhook-inbox -m "Merge branch 'docs/meet-webhook-inbox': durable Attendee webhook" -m "$ATTRIB"
```

Не push сразу: повторить Step 2–4 на получившемся main merge SHA. `run_ci` отправляет именно текущий
`HEAD` в CI-ветку, поэтому проверка выполнится на merge результате. После зелёных проверок:

```bash
git -C /d/Project/linkeon/spirits_back push origin main
```

Если `origin/main` снова ушёл вперёд, не force-push: повторить merge и полный цикл проверки нового SHA.

- [ ] **Step 6: Выкатить только официальным pipeline**

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Ожидание: PHASE 1 test → smoke зелёный, затем PHASE 2 prod → smoke зелёный. Не использовать
`PROD_ONLY=1`, ручной `git pull` на серверах или прямой `pm2 restart`. Исторический PHASE 4 SSH
сбой продуктовых хостов сам по себе не является причиной отката уже зелёных test/prod phases.

- [ ] **Step 7: Проверить миграцию и runtime после выката**

На test и prod read-only SQL через существующий PostgreSQL-доступ, без печати `DATABASE_URL`:

```sql
SELECT filename, applied_at
  FROM schema_migrations
 WHERE filename = 'meeting/006_meeting_webhook_events.sql';

SELECT status, count(*)
  FROM meeting_webhook_events
 GROUP BY status
 ORDER BY status;
```

Ожидание: одна запись миграции на каждом контуре; запрос counts выполняется без ошибки. Проверить
логи API на отсутствие `meeting webhook migration failed`, `[meet] inbox pump failed` и новых
`status=dead`. Не печатать payload, имена участников или текст чата. При красном test/prod smoke —
исправлять через git и повторный официальный deploy, не править серверные файлы вручную.
