import { Injectable, OnModuleInit } from '@nestjs/common';
import { AccountDeletionRegistry } from '../account-deletion/account-deletion.registry';
import {
  DeletionCancelledError,
  DeletionRetryError,
  deletionErrorKind,
} from '../account-deletion/account-deletion.safe';
import type {
  AccountDeletionAdapter,
  DeletionDiscovery,
  DeletionExecution,
  DeletionJobRow,
  DeletionJobSpec,
  DeletionPlan,
  DeletionResourceType,
  DeletionSkip,
} from '../account-deletion/account-deletion.types';
import { inTransaction } from '../blog/blog-slot-claim';
import { PgService } from '../common/services/pg.service';

/**
 * Task 17E — legacy SMM (короткие ролики) при удалении аккаунта.
 *
 * SMM-код из репозитория удалён (publishers сняты в 7f99a9a^), доменных
 * сервисов нет — адаптер является чистым SQL. Внешних вызовов к соцсетям
 * не существует и не выдумывается: опубликованный внешний пост (external_post_id)
 * недостижим для удаления, поэтому discovery фиксирует один безопасный skip
 * legacy-smm.purge/unsupported_external на план (прецедент video.provider),
 * а purge стирает наши ссылки и идентификаторы поста.
 *
 * Цепочка владения собирается руками через joins — FOREIGN KEYS у smm_*
 * НЕТ (001_core_schema.sql), никакого cascade не существует:
 *   smm_campaign(user_id, is_linkeon_official=false)
 *     → smm_scenario(campaign_id) → smm_video(scenario_id)
 *     → smm_publication(video_id) → smm_event_log(video_id/publication_id).
 *
 * Discovery выбирает только собственные НЕ official-кампании (keyset-
 * пагинация, generation predicate) и создаёт пару job'ов на каждую:
 * legacy-smm.stop (immediate) и legacy-smm.purge (purge), payload — один
 * технический campaignId (uuid, прецедент video payload {videoJobId}).
 * Общие таблицы smm_music_track/smm_pricing и official-кампании не
 * выбираются никогда.
 *
 * Fix-раунд (design-спек 2026-11-11, строка 44: «секреты соединения
 * удаляются по действующим правилам» — БЕЗ условия наличия кампаний):
 * дополнительно создаётся user-scoped пара job'ов со статическим
 * resourceKey 'legacy-smm' (образец tasks/support/peer/referral) и пустым
 * payload — но только когда у пользователя есть хотя бы одна user-scoped
 * строка (smm_social_account / smm_oauth_state / smm_billing_ledger /
 * smm_premium_generation). Условность обоснована: SMM — legacy-ниша,
 * большинство аккаунтов не имеет в этих таблицах ничего, и плодить на
 * каждое удаление два пустых jobа (записи в очереди, lease-циклы) незачем.
 * Пользователь с живыми access-токенами и billing-строками, но БЕЗ
 * собственных кампаний, теперь получает полный stop+purge.
 *
 * stop (порядок по доменной логике — статусы гасятся до стирания):
 *  per-campaign job (resourceKey=campaignId):
 *  1. собственная кампания: drafting/approved → 'cancelled';
 *  2. её видео в активных статусах → 'cancelled';
 *  3. её публикации scheduled/publishing → 'cancelled' (published —
 *     внешний терминальный факт, статус не переписывается).
 *  user-scoped job (resourceKey='legacy-smm', payload {}):
 *  4. smm_social_account пользователя: status='revoked', credentials='{}'
 *     (access-токены платформ уничтожаются ДО purge);
 *  5. DELETE smm_oauth_state пользователя.
 *
 * purge — ОДНА транзакция (inTransaction) с generation check внутри:
 *  per-campaign job:
 *  1. DELETE собственных smm_event_log (через video/publication цепочки) —
 *     до scrub: payload событий содержит личный контент;
 *  2. scrub smm_creator_campaign (cta/logo/slogan/caption/bg-URL),
 *     smm_scenario (title/dialog/broll_prompts/scenes_json),
 *     smm_publication (caption/external_url/external_post_id/error_message),
 *     smm_video (render_state/mp4_url/error_message),
 *     smm_campaign (topic/conversation_id).
 *  user-scoped job:
 *  3. smm_billing_ledger.user_id и smm_premium_generation.user_id получают
 *     deletion-scoped alias 'deleted:<deletionId>' (44 символа, text-колонки).
 *
 * Правило purge-after-stop (catalog: sameResourceKey) работает для обеих
 * форм: и для статического ключа 'legacy-smm', и для campaignId — user-
 * scoped purge так же ждёт своего user-scoped stop.
 *
 * Billing evidence НЕ удаляется: строки ledger/premium_generation и все суммы
 * (amount, tokens_charged, tokens_refunded, internal_cost_cents), video-ссылки
 * и технические метрики сохраняются — поэтому destructive cascade не нужен и
 * не используется. Строки и суммы smm_music_track/smm_pricing/official общие —
 * не трогаются.
 *
 * Каждое мутирующее выражение несёт generation predicate EXISTS; scrub-
 * выражения дополнительно защищены «уже очищено»-условиями, поэтому повторный
 * прогон идемпотентен байт-в-байт (updated_at не дрейфует). campaignId из
 * payload перепроверяется fail-closed (uuid) — purge исполняется через 30
 * дней после планирования.
 */

/** Сколько кампаний читать за один запрос discovery. */
export const LEGACY_SMM_PAGE_SIZE = 500;

/**
 * Статический resourceKey user-scoped пары job'ов (образец
 * tasks/support/peer/referral). Одновременно маркер формы job'а в execute.
 */
export const LEGACY_SMM_USER_RESOURCE_KEY = 'legacy-smm';

/** Нулевой uuid — нижняя граница keyset-пагинации первой страницы. */
const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LegacySmmDiscovery extends DeletionDiscovery {
  /** Размер keyset-страницы (тесты); по умолчанию LEGACY_SMM_PAGE_SIZE. */
  pageSize?: number;
}

export async function discoverLegacySmmDeletion(ctx: LegacySmmDiscovery): Promise<DeletionPlan> {
  const { db, account } = ctx;
  const pageSize = ctx.pageSize ?? LEGACY_SMM_PAGE_SIZE;

  // Generation gate: до проверки поколения таблицы не читаются.
  const gen = await db.query(
    `SELECT 1 FROM user_id u
      WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2`,
    [account.userId, account.deletionId],
  );
  if ((gen.rowCount ?? 0) === 0) return { jobs: [], skips: [] };

  const jobs: DeletionJobSpec[] = [];
  let lastId: string | null = null;
  for (;;) {
    const res = await db.query(
      `SELECT c.id FROM smm_campaign c
        WHERE c.user_id = $1
          AND c.is_linkeon_official = false
          AND c.id > coalesce($2::uuid, '${ZERO_UUID}'::uuid)
          AND EXISTS (
            SELECT 1 FROM user_id u
            WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $3
          )
        ORDER BY c.id
        LIMIT $4`,
      [account.userId, lastId, account.deletionId, pageSize],
    );
    const rows = res.rows ?? [];
    if (rows.length === 0) break;
    for (const row of rows) {
      const campaignId = String(row.id);
      lastId = campaignId;
      jobs.push({
        resourceType: 'legacy-smm.stop',
        resourceKey: campaignId,
        phase: 'immediate',
        payload: { campaignId },
      });
      jobs.push({
        resourceType: 'legacy-smm.purge',
        resourceKey: campaignId,
        phase: 'purge',
        payload: { campaignId },
      });
    }
  }

  // User-scoped след (секреты соединений и billing-строки) существует
  // независимо от кампаний — design-спек, строка 44. Пара job'ов со
  // статическим ключом создаётся только при наличии таких строк: у
  // аккаунта без SMM-следа план остаётся пустым.
  const userScoped = await db.query(
    `SELECT 1
      WHERE EXISTS (SELECT 1 FROM user_id u
             WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2)
        AND (EXISTS (SELECT 1 FROM smm_social_account a WHERE a.user_id = $1)
          OR EXISTS (SELECT 1 FROM smm_oauth_state o WHERE o.user_id = $1)
          OR EXISTS (SELECT 1 FROM smm_billing_ledger l WHERE l.user_id = $1)
          OR EXISTS (SELECT 1 FROM smm_premium_generation g WHERE g.user_id = $1))`,
    [account.userId, account.deletionId],
  );
  if ((userScoped.rowCount ?? 0) > 0) {
    jobs.push({
      resourceType: 'legacy-smm.stop',
      resourceKey: LEGACY_SMM_USER_RESOURCE_KEY,
      phase: 'immediate',
      payload: {},
    });
    jobs.push({
      resourceType: 'legacy-smm.purge',
      resourceKey: LEGACY_SMM_USER_RESOURCE_KEY,
      phase: 'purge',
      payload: {},
    });
  }

  // Внешний пост (external_post_id) удалить у соцсети нечем: adapter для
  // провайдерских вызовов не существует, API/SSH вызовы план запрещает —
  // один skip на план (форма video.provider), без идентификаторов постов.
  const external = await db.query(
    `SELECT 1 FROM smm_publication p
       JOIN smm_video v ON v.id = p.video_id
       JOIN smm_scenario s ON s.id = v.scenario_id
       JOIN smm_campaign c ON c.id = s.campaign_id
      WHERE c.user_id = $1
        AND c.is_linkeon_official = false
        AND p.external_post_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM user_id u
          WHERE u.internal_id = $1 AND u.state = 'deleted' AND u.deletion_id = $2
        )
      LIMIT 1`,
    [account.userId, account.deletionId],
  );
  const skips: DeletionSkip[] = (external.rowCount ?? 0) > 0
    ? [{ resourceType: 'legacy-smm.purge', reason: 'unsupported_external' }]
    : [];
  return { jobs, skips };
}

/**
 * Параметры выражений: $1=userId, $2=deletionId; campaign-scoped выражения
 * дополнительно $3=campaignId; user-scoped alias-UPDATE — $3=deletionAlias.
 * Каждому выражению передаётся ровно его набор (PG отвергает лишние
 * bind-параметры — 08P01).
 */
const GEN_PREDICATE = `EXISTS (SELECT 1 FROM user_id u
     WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2)`;

/** Кампания из payload действительно собственная и не official. */
const OWN_CAMPAIGN_PREDICATE = `EXISTS (SELECT 1 FROM smm_campaign c
     WHERE c.id=$3::uuid AND c.user_id=$1 AND c.is_linkeon_official=false)`;

const GEN_CHECK_SQL = `SELECT 1 FROM user_id u
 WHERE u.internal_id=$1 AND u.state='deleted' AND u.deletion_id=$2`;

const CAMPAIGN_STOP_SQL = `UPDATE smm_campaign SET status='cancelled', updated_at=now()
 WHERE id=$3::uuid AND user_id=$1 AND is_linkeon_official=false
   AND status IN ('drafting','approved')
   AND ${GEN_PREDICATE}`;

const VIDEO_STOP_SQL = `UPDATE smm_video SET status='cancelled', updated_at=now()
 WHERE status IN ('queued','rendering','ready','approved','escape_hatch_offered')
   AND scenario_id IN (SELECT s.id FROM smm_scenario s WHERE s.campaign_id=$3::uuid)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const PUBLICATION_STOP_SQL = `UPDATE smm_publication SET status='cancelled', updated_at=now()
 WHERE status IN ('scheduled','publishing')
   AND video_id IN (
     SELECT v.id FROM smm_video v
       JOIN smm_scenario s ON s.id = v.scenario_id
      WHERE s.campaign_id=$3::uuid)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const SOCIAL_REVOKE_SQL = `UPDATE smm_social_account
   SET status='revoked', credentials='{}'::jsonb, updated_at=now()
 WHERE user_id=$1 AND status <> 'revoked'
   AND ${GEN_PREDICATE}`;

const OAUTH_DELETE_SQL = `DELETE FROM smm_oauth_state
 WHERE user_id=$1
   AND ${GEN_PREDICATE}`;

// Собственные события — через цепочки video/publication (в smm_event_log
// нет колонки user_id). Непринадлежащие события (обе ссылки NULL) и чужие
// не трогаются: владельца доказать нельзя.
const EVENT_LOG_PURGE_SQL = `DELETE FROM smm_event_log
 WHERE (video_id IN (SELECT v.id FROM smm_video v
                      JOIN smm_scenario s ON s.id = v.scenario_id
                     WHERE s.campaign_id=$3::uuid)
     OR publication_id IN (SELECT p.id FROM smm_publication p
                            JOIN smm_video v2 ON v2.id = p.video_id
                            JOIN smm_scenario s2 ON s2.id = v2.scenario_id
                           WHERE s2.campaign_id=$3::uuid))
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const CREATOR_SCRUB_SQL = `UPDATE smm_creator_campaign SET
   cta_handle='', cta_label='', logo_url=NULL, cta_slogan=NULL,
   publish_caption=NULL, bg_image_url=NULL, updated_at=now()
 WHERE campaign_id=$3::uuid
   AND (cta_handle<>'' OR cta_label<>'' OR logo_url IS NOT NULL
        OR cta_slogan IS NOT NULL OR publish_caption IS NOT NULL
        OR bg_image_url IS NOT NULL)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const SCENARIO_SCRUB_SQL = `UPDATE smm_scenario SET
   title='', dialog='[]'::jsonb, broll_prompts='[]'::jsonb, scenes_json=NULL,
   updated_at=now()
 WHERE campaign_id=$3::uuid
   AND (title<>'' OR dialog<>'[]'::jsonb OR broll_prompts<>'[]'::jsonb
        OR scenes_json IS NOT NULL)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const PUBLICATION_SCRUB_SQL = `UPDATE smm_publication SET
   caption=NULL, external_url=NULL, external_post_id=NULL, error_message=NULL,
   updated_at=now()
 WHERE video_id IN (SELECT v.id FROM smm_video v
                     JOIN smm_scenario s ON s.id = v.scenario_id
                    WHERE s.campaign_id=$3::uuid)
   AND (caption IS NOT NULL OR external_url IS NOT NULL
        OR external_post_id IS NOT NULL OR error_message IS NOT NULL)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const VIDEO_SCRUB_SQL = `UPDATE smm_video SET
   render_state='{}'::jsonb, mp4_url=NULL, error_message=NULL, updated_at=now()
 WHERE scenario_id IN (SELECT s.id FROM smm_scenario s WHERE s.campaign_id=$3::uuid)
   AND (render_state<>'{}'::jsonb OR mp4_url IS NOT NULL OR error_message IS NOT NULL)
   AND ${OWN_CAMPAIGN_PREDICATE}
   AND ${GEN_PREDICATE}`;

const CAMPAIGN_SCRUB_SQL = `UPDATE smm_campaign SET
   topic=NULL, conversation_id=NULL, updated_at=now()
 WHERE id=$3::uuid AND user_id=$1 AND is_linkeon_official=false
   AND (topic IS NOT NULL OR conversation_id IS NOT NULL)
   AND ${GEN_PREDICATE}`;

// Billing evidence: строки и суммы сохраняются, меняется только идентичность
// (deletion-scoped alias 'deleted:<deletionId>' в $3). Алиасинг — user-scoped
// операция: ledger/premium принадлежат пользователю, а не кампании, и должны
// обрабатываться даже когда собственных кампаний нет. Генерация ($1/$2) —
// единственная защита: после первого прогона WHERE user_id=$1 матчит 0 строк,
// повторный alias идемпотентен байт-в-байт.
const LEDGER_ALIAS_SQL = `UPDATE smm_billing_ledger SET user_id=$3
 WHERE user_id=$1
   AND ${GEN_PREDICATE}`;

const PREMIUM_ALIAS_SQL = `UPDATE smm_premium_generation SET user_id=$3
 WHERE user_id=$1
   AND ${GEN_PREDICATE}`;

@Injectable()
export class LegacySmmAccountDeletionAdapter implements OnModuleInit, AccountDeletionAdapter {
  readonly resourceTypes: readonly DeletionResourceType[] = ['legacy-smm.stop', 'legacy-smm.purge'];

  constructor(
    private readonly pg: PgService,
    private readonly registry: AccountDeletionRegistry,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async execute(job: DeletionJobRow, ctx: DeletionExecution): Promise<void> {
    if (job.resourceType !== 'legacy-smm.stop' && job.resourceType !== 'legacy-smm.purge') {
      throw new Error('unsupported_deletion_resource');
    }
    // Две формы job'ов: user-scoped (статический resourceKey 'legacy-smm',
    // пустой payload) и per-campaign (resourceKey=campaignId, payload
    // {campaignId}). Payload мог прийти только из нашего discovery, но purge
    // исполняется через 30 дней: форма перепроверяется fail-closed.
    // Рассогласование — retry db, а не слепая запись.
    const isUserScoped = job.resourceKey === LEGACY_SMM_USER_RESOURCE_KEY;
    let campaignId: string | null = null;
    if (isUserScoped) {
      if (Object.keys(job.payload ?? {}).length !== 0) {
        throw new DeletionRetryError('db');
      }
    } else {
      const raw = job.payload?.campaignId;
      if (typeof raw !== 'string' || !UUID_RE.test(raw)) {
        throw new DeletionRetryError('db');
      }
      campaignId = raw;
    }

    await ctx.assertCurrent(job);
    try {
      const userParams = [job.userId, job.deletionId];
      if (job.resourceType === 'legacy-smm.stop') {
        // Транзакция не обязательна (peer-прецедент): отдельные выражения,
        // каждое с generation predicate.
        if (isUserScoped) {
          // Секреты соединения (design-спек, строка 44): отзыв credentials
          // и DELETE oauth-состояний — независимо от наличия кампаний.
          await ctx.db.query(SOCIAL_REVOKE_SQL, userParams);
          await ctx.db.query(OAUTH_DELETE_SQL, userParams);
        } else {
          // Порядок доменный: статусы кампании/видео/публикаций гасятся
          // до purge-стирания контента.
          const campaignParams = [job.userId, job.deletionId, campaignId];
          await ctx.db.query(CAMPAIGN_STOP_SQL, campaignParams);
          await ctx.db.query(VIDEO_STOP_SQL, campaignParams);
          await ctx.db.query(PUBLICATION_STOP_SQL, campaignParams);
        }
      } else {
        // Purge — одна транзакция с generation check внутри (план Step 3).
        const deletionAlias = `deleted:${job.deletionId}`;
        if (isUserScoped) {
          // Billing-идентичность: alias ledger/premium — user-scoped
          // операция, строки и суммы сохраняются.
          const aliasParams = [job.userId, job.deletionId, deletionAlias];
          await inTransaction(this.pg, async (tx) => {
            const gen = await tx.query(GEN_CHECK_SQL, userParams);
            if ((gen.rowCount ?? 0) === 0) return;
            await tx.query(LEDGER_ALIAS_SQL, aliasParams);
            await tx.query(PREMIUM_ALIAS_SQL, aliasParams);
          });
        } else {
          // Campaign-scoped данные: DELETE event_log → scrub контента.
          const campaignParams = [job.userId, job.deletionId, campaignId];
          await inTransaction(this.pg, async (tx) => {
            const gen = await tx.query(GEN_CHECK_SQL, userParams);
            if ((gen.rowCount ?? 0) === 0) return;
            await tx.query(EVENT_LOG_PURGE_SQL, campaignParams);
            await tx.query(CREATOR_SCRUB_SQL, campaignParams);
            await tx.query(SCENARIO_SCRUB_SQL, campaignParams);
            await tx.query(PUBLICATION_SCRUB_SQL, campaignParams);
            await tx.query(VIDEO_SCRUB_SQL, campaignParams);
            await tx.query(CAMPAIGN_SCRUB_SQL, campaignParams);
          });
        }
      }
    } catch (error) {
      if (error instanceof DeletionCancelledError) throw error;
      if (error instanceof DeletionRetryError) throw error;
      throw new DeletionRetryError(deletionErrorKind(error));
    }
    await ctx.assertCurrent(job);
  }
}
