import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { EventsService } from '../events/events.service';
import { putGuestCarry, renderGuestCarry } from './guest-carry';
import { hashClaimer, hashGuestToken, isGuestTokenShape } from './guest-token';
import { GUEST_REDIS_TIMEOUT_MS, GUEST_TRIAL_TTL_DAYS, GuestHistoryMessage, MASHA_AGENT_ID } from './guest-trial.types';
import { withTimeout } from '../common/with-timeout';

export interface ClaimResult {
  status: number;
  body: Record<string, unknown>;
}

/** Сколько последних пар разбирает профиль после переноса — не весь разговор. */
const CONSOLIDATE_LAST_PAIRS = 5;

@Injectable()
export class GuestClaimService {
  private readonly log = new Logger('GuestClaim');

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly events?: EventsService,
  ) {}

  /**
   * Перенести пробу в аккаунт userId. Одна транзакция с FOR UPDATE: одновременные
   * переносы той же пробы не задвоят историю. Повтор тем же человеком безвреден.
   *
   * «Уже перенесена» определяется по claimed_at, а не по claimed_by_hash (ревью A3):
   * хеш переносившего обнуляется уборкой через 7 дней после переноса (Задача A6),
   * и к этому моменту сверить личность уже не с чем — поэтому при обнулённом
   * хеше любой повтор получает 409, а не тихие 200.
   */
  async claim(userId: string, token: string): Promise<ClaimResult> {
    if (!userId || !isGuestTokenShape(token)) return { status: 404, body: { error: 'trial' } };
    const claimer = hashClaimer(userId);
    const client = await this.pg.getClient();
    // Сломанное соединение (ROLLBACK в catch не прошёл) в пул не возвращаем —
    // по образцу src/blog/blog-slot-claim.ts (inTransaction).
    let broken = false;
    let assistantId = 0;
    let answers = 0;
    let moved: GuestHistoryMessage[] = [];
    let hadHistory = false;
    let trialId = '';
    let source: string | null = null;
    try {
      await client.query('BEGIN');
      const r = await client.query(
        // Срок пробы сверяем по часам БАЗЫ (now() в make_interval), а не
        // Node: процесс и Postgres могут расходиться по времени, а это
        // граница «проба жива/просрочена».
        `SELECT id::text AS id, assistant_id, answers, claimed_by_hash, claimed_at, source,
                (last_message_at > now() - make_interval(days => $2)) AS live
           FROM guest_trial_sessions WHERE token_hash = $1 FOR UPDATE`,
        [hashGuestToken(token), GUEST_TRIAL_TTL_DAYS],
      );
      const row = r.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'trial' } };
      }
      if (row.claimed_at) {
        await client.query('ROLLBACK');
        return row.claimed_by_hash === claimer
          ? { status: 200, body: { assistantId: String(row.assistant_id), moved: 0 } }
          : { status: 409, body: { error: 'claimed' } };
      }
      if (row.answers < 1 || !row.live) {
        await client.query('ROLLBACK');
        return { status: 404, body: { error: 'trial' } };
      }
      assistantId = Number(row.assistant_id);
      answers = Number(row.answers);
      trialId = row.id;
      source = row.source ?? null;
      const sessionKey = `${userId}_${assistantId}`;
      const h = await client.query(`SELECT 1 FROM custom_chat_history WHERE session_id = $1 LIMIT 1`, [sessionKey]);
      hadHistory = h.rows.length > 0;
      const m = await client.query(
        `SELECT sender_type, content FROM guest_trial_messages WHERE session_id = $1::uuid ORDER BY id`,
        [row.id],
      );
      moved = m.rows;
      // Исходное время сообщений: в ленте проба встанет туда, где она была.
      await client.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used, created_at)
         SELECT $1, sender_type, $2, content, 'text', 0, created_at
           FROM guest_trial_messages WHERE session_id = $3::uuid ORDER BY id`,
        [sessionKey, assistantId, row.id],
      );
      await client.query(`UPDATE guest_trial_sessions SET claimed_by_hash = $2, claimed_at = now() WHERE id = $1::uuid`, [row.id, claimer]);
      await client.query(`DELETE FROM guest_trial_messages WHERE session_id = $1::uuid`, [row.id]);
      await client.query('COMMIT');
    } catch (e) {
      // ROLLBACK сам может не пройти (например, соединение уже оборвано) —
      // тогда состояние его сессии неизвестно, и такое соединение в пул не
      // возвращаем, а разрываем (release(true)).
      broken = await client.query('ROLLBACK').then(() => false, () => true);
      throw e;
    } finally {
      client.release(broken);
    }
    await this.afterClaim({ userId, assistantId, moved, hadHistory, answers, trialId, source });
    return { status: 200, body: { assistantId: String(assistantId), moved: moved.length } };
  }

  private async afterClaim(ctx: {
    userId: string;
    assistantId: number;
    moved: GuestHistoryMessage[];
    hadHistory: boolean;
    answers: number;
    trialId: string;
    source: string | null;
  }): Promise<void> {
    const { userId, assistantId, moved, hadHistory, answers, trialId, source } = ctx;
    // Приписка — всем ассистентам, кроме Маши, независимо от hadHistory:
    // claim() видит только custom_chat_history, а не сессии релея. Если
    // релей уже вёл сессию с этим ассистентом (её не стёрли вместе с
    // историей кабинета), она возобновится по --resume без всякого следа
    // пробы — приписка нужна именно на этот случай. Новому аккаунту лишняя
    // приписка не вредит: это просто безвредный дубль хвоста истории, который
    // релей и так вставляет сам. hadHistory остаётся только для события —
    // полю existing ниже.
    if (assistantId !== MASHA_AGENT_ID && moved.length > 0) {
      try {
        await withTimeout(putGuestCarry(this.redis, userId, String(assistantId), renderGuestCarry(moved)), GUEST_REDIS_TIMEOUT_MS);
      } catch (e: any) {
        this.log.warn(`guest carry not stored (assistant ${assistantId}): ${e?.message}`);
      }
    }
    this.events?.track('guest_trial_claimed', {
      userId,
      props: { assistant_id: String(assistantId), answers, existing: hadHistory, trial: trialId, source },
    });
    const neo4j = this.neo4j;
    if (!neo4j) return;
    // Профиль — тем же разбором, что после обычных ходов; сбоку, ответ ручки
    // не ждёт. Не больше CONSOLIDATE_LAST_PAIRS последних пар — длинную пробу
    // не разбираем целиком.
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i + 1 < moved.length; i++) {
      if (moved[i].sender_type === 'human' && moved[i + 1].sender_type === 'ai') pairs.push([moved[i].content, moved[i + 1].content]);
    }
    const recent = pairs.slice(-CONSOLIDATE_LAST_PAIRS);
    setImmediate(async () => {
      // «Предыдущая реплика ассистента» нужна consolidateFromChat, чтобы
      // понять согласие («да»/«точно») в вопросе пары. По умолчанию сервис
      // сам достаёт её запросом к custom_chat_history — это верно для
      // обычного хода, но здесь все пары уже вставлены одним махом ДО этого
      // цикла, и такой запрос отдал бы одну и ту же (последнюю) реплику
      // каждой паре. Передаём её явно, по ходу перебора: для первой пары —
      // '' («начало диалога», в т.ч. если это не истинное начало — более
      // старые пары мы не разбираем), для следующих — ответ предыдущей.
      // Сбой на одной паре не останавливает следующие: try/catch — внутри
      // цикла, а не вокруг него.
      let prevAssistantMessage = '';
      for (const [q, a] of recent) {
        try {
          await neo4j.consolidateFromChat(userId, String(assistantId), q, a, prevAssistantMessage);
        } catch (e: any) {
          this.log.warn(`guest claim consolidate failed: ${e?.message}`);
        }
        prevAssistantMessage = a;
      }
    });
  }
}
