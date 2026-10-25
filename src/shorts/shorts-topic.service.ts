import { Injectable, Logger } from '@nestjs/common';
import { AgentsService } from '../agents/agents.service';
import { isoWeekKey } from '../blog/blog-news.themes';
import { inTransaction } from '../blog/blog-slot-claim';
import { nextFreeSlotAfter } from '../blog/blog-slots';
import { hasClearProfile, normalizeTopicKey } from '../blog/blog-topic.service';
import { PgService } from '../common/services/pg.service';
import { isHealthAssistant } from './short-assistants';
import { toAgents } from './short-prompts';
import { pickAssistants, planNext } from './short-rhythm';
import { ShortsSettingsService } from './shorts-settings.service';
import {
  ANGLES, IN_WORK_STATUSES, MAX_IN_WORK, PROVOCATIVE_ANGLES, RUBRICS, SLOT_HOLDING_STATUSES,
  ShortAngle, ShortRubric, ShortSource, ShortVideo, rowToShort,
} from './shorts.types';

export const WEEKLY_TOPICS = 3;
export const MIN_ORDER_CHARS = 10;
export const MAX_ORDER_CHARS = 4000;

/** Москва круглый год UTC+3 (как в blog-slots.ts) — неделя каталога считается по ней, как и слоты. */
const MSK_OFFSET_MS = 3 * 3600_000;

/** `start({ id })` — страховка от PG 22P02: не-uuid не долетает до запроса. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ошибка проверки заказа (длина темы, рубрика, подача, ассистент не найден,
 * здоровье + провокация): отдельный класс, чтобы контроллер отличал её от
 * сбоя базы и прочего неожиданного и отвечал на неё 400, а не 500.
 */
export class ShortOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShortOrderError';
  }
}

export interface OrderInput {
  topic: string;
  rubric?: ShortRubric;
  /** Задана — фиксируется (`angle_locked`); нет — подачу поставит ритм недели при запуске. */
  angle?: ShortAngle | null;
  assistantId?: number | null;
  /** Ключ повторной доставки: `tg:<чат>:<сообщение>` у /short. */
  sourceRef?: string | null;
}

interface IdeaInsert {
  rubric: ShortRubric;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string;
  title: string;
  assistantId: number | null;
}

@Injectable()
export class ShortsTopicService {
  private readonly logger = new Logger(ShortsTopicService.name);

  constructor(
    private readonly pg: PgService,
    private readonly agents: AgentsService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /**
   * Заказ владельца. Без рубрики — `case`: так приходит история через /short.
   * @returns null — по этому sourceRef (или, без него, по тому же topic_key среди
   *   открытых ручных идей) ролик уже заказан
   * @throws ShortOrderError — ошибка проверки входа
   */
  async addManual(o: OrderInput): Promise<ShortVideo | null> {
    const topic = String(o.topic ?? '').trim();
    const n = Array.from(topic).length;
    if (n < MIN_ORDER_CHARS || n > MAX_ORDER_CHARS) {
      throw new ShortOrderError(`тема — от ${MIN_ORDER_CHARS} до ${MAX_ORDER_CHARS} знаков, сейчас ${n}`);
    }
    const rubric = o.rubric ?? 'case';
    if (!RUBRICS.includes(rubric)) throw new ShortOrderError(`неизвестная рубрика: ${rubric}`);
    if (o.angle != null && !ANGLES.includes(o.angle)) throw new ShortOrderError(`неизвестная подача: ${o.angle}`);
    let assistantId: number | null = null;
    if (o.assistantId != null) {
      const active = toAgents(await this.agents.getAgents('ru'));
      const agent = active.find((a) => a.id === Number(o.assistantId));
      if (!agent) throw new ShortOrderError(`ассистента ${o.assistantId} нет среди активных`);
      if (o.angle != null && isHealthAssistant(agent.name) && PROVOCATIVE_ANGLES.includes(o.angle)) {
        throw new ShortOrderError(`«${agent.name}» — тема здоровья: только спокойная подача (calm)`);
      }
      assistantId = agent.id;
    }
    const topicKey = normalizeTopicKey(topic.slice(0, 80)) || 'short';
    // sourceRef защищает от дубля уникальным индексом; без него — от двойного
    // нажатия «Заказать» в админке страхует сам topic_key среди открытых заказов.
    // Тема после публикации или отказа (idea-статус снят) заказывается повторно.
    if (!o.sourceRef) {
      const dup = await this.pg.query(
        `SELECT id FROM short_video WHERE source = 'manual' AND status = 'idea' AND topic_key = $1 LIMIT 1`,
        [topicKey],
      );
      if (dup.rows.length) return null;
    }
    return this.insertIdea({
      rubric,
      angle: o.angle ?? 'calm',
      angleLocked: o.angle != null,
      source: 'manual',
      sourceRef: o.sourceRef ?? null,
      topicKey,
      topicHint: topic,
      title: Array.from(topic.replace(/\s+/g, ' ')).slice(0, 60).join(''),
      assistantId,
    });
  }

  /**
   * Каталог недели: доводит число ОТКРЫТЫХ идей каталога (source = 'catalog',
   * status = 'idea') до WEEKLY_TOPICS, а не добавляет к ним ещё WEEKLY_TOPICS —
   * иначе повторный вызов в тот же день заводил бы новую тройку поверх старой
   * (ключ `catalog:assistant:<id>:<день>` от этого не защищал: второй вызов в
   * тот же день видел уже заведённые A, B, C, пропускал их в pickAssistants и
   * заводил D, E, F).
   *
   * Ключ идеи — неделя (по МСК, как слоты) и позиция в ней внутри недели,
   * `catalog:<ISO-неделя>:<1..3>`: повторный или параллельный вызов той же
   * недели целится в те же позиции и упирается в тот же source_ref через
   * uq_short_video_source_ref, даже если выбрал другого ассистента.
   *
   * Ассистентов без внятного профиля (как в блоге, `hasClearProfile`) в
   * каталог не ставим: без него редактор/режиссёр сочиняют ассистенту
   * возможности, которых у него нет.
   */
  async refillWeek(now: Date = new Date()): Promise<number> {
    const openCount = await this.pg.query(
      `SELECT count(*)::int AS n FROM short_video WHERE status = 'idea' AND source = 'catalog'`,
    );
    const need = WEEKLY_TOPICS - Number(openCount.rows[0]?.n ?? 0);
    if (need <= 0) return 0;

    const assistants = toAgents(await this.agents.getAgents('ru')).filter((a) => hasClearProfile(a.description));
    // «Когда показывали» — по слоту, если он был, иначе по созданию: идея может
    // неделями ждать в очереди, и max(created_at) сдвигал бы её «показ» в прошлое.
    // Отклонённые считаются показанными (их не обязано вставать первыми каждую
    // неделю), упавшие — не считаются (их стоит повторить).
    const shown = await this.pg.query(
      `SELECT assistant_id, max(coalesce(slot_at, created_at)) AS last FROM short_video
        WHERE assistant_id IS NOT NULL AND status <> 'failed'
        GROUP BY assistant_id`,
    );
    const open = await this.pg.query(
      `SELECT DISTINCT assistant_id FROM short_video WHERE status = 'idea' AND assistant_id IS NOT NULL`,
    );
    const lastShown = new Map<number, Date>(shown.rows.map((r: any) => [Number(r.assistant_id), new Date(r.last)]));
    const openIds = new Set<number>(open.rows.map((r: any) => Number(r.assistant_id)));
    const week = isoWeekKey(new Date(now.getTime() + MSK_OFFSET_MS));
    const already = WEEKLY_TOPICS - need;
    const picks = pickAssistants(assistants, lastShown, openIds, need);
    let added = 0;
    for (let idx = 0; idx < picks.length; idx++) {
      const a = picks[idx];
      const v = await this.insertIdea({
        rubric: 'assistant',
        angle: 'calm',
        angleLocked: false,
        source: 'catalog',
        sourceRef: `catalog:${week}:${already + idx + 1}`,
        topicKey: `assistant-${a.id}`,
        topicHint: `Ассистент «${a.name}»: ${a.description}. Жизненная задача из его профиля.`,
        title: a.name,
        assistantId: a.id,
      });
      if (v) added += 1;
    }
    this.logger.log(`каталог недели: заведено ${added} тем`);
    return added;
  }

  /**
   * Запустить ролик под ближайший слот, которому ещё не предназначен ни один
   * ролик. Крон (`force: false`) — только когда до слота не больше
   * prepare_lead_hours и в работе меньше MAX_IN_WORK роликов. `start_now`
   * из админки (`force: true`) — сразу; `id` — конкретная идея (не-uuid —
   * null без обращения к базе: контроллер сам ответит 400, здесь — страховка
   * от PG 22P02).
   *
   * Всё решение — в одной транзакции под pg_try_advisory_xact_lock: два
   * процесса API не запустят два ролика под один слот. Занят — null, следующий
   * тик попробует снова.
   */
  async start(o: { id?: string; force: boolean }, clock: () => Date = () => new Date()): Promise<ShortVideo | null> {
    if (o.id !== undefined && !UUID_RE.test(o.id)) return null;
    const [settings, agentRows] = await Promise.all([this.settings.get(), this.agents.getAgents('ru')]);
    const names = new Map(toAgents(agentRows).map((a) => [a.id, a.name]));
    return inTransaction(this.pg, async (tx) => {
      const lock = await tx.query(`SELECT pg_try_advisory_xact_lock(hashtext('shorts/start')) AS ok`);
      if (!lock.rows[0]?.ok) return null;
      const now = clock();

      const assigned = await tx.query(
        `SELECT slot_at FROM short_video WHERE status = ANY($1::text[]) AND slot_at > $2`,
        [[...IN_WORK_STATUSES, ...SLOT_HOLDING_STATUSES], now.toISOString()],
      );
      const slot = nextFreeSlotAfter(now, settings.slotDays, settings.slotHourMsk, assigned.rows.map((r: any) => r.slot_at));
      if (!o.force) {
        const inWork = await tx.query(
          `SELECT count(*)::int AS n FROM short_video WHERE status = ANY($1::text[])`,
          [IN_WORK_STATUSES],
        );
        if (Number(inWork.rows[0]?.n ?? 0) >= MAX_IN_WORK) return null;
        if (slot.getTime() - now.getTime() > settings.prepareLeadHours * 3600_000) return null;
      }

      // Заказ владельца не должен срезаться лимитом: свежая ручная идея может
      // оказаться младше полусотни каталожных по created_at.
      const ideas = o.id
        ? await tx.query(`SELECT * FROM short_video WHERE status = 'idea' AND id = $1`, [o.id])
        : await tx.query(`SELECT * FROM short_video WHERE status = 'idea' ORDER BY (source = 'manual') DESC, created_at LIMIT 50`);
      if (!ideas.rows.length) return null;
      const recent = await tx.query(
        `SELECT rubric, angle FROM short_video
          WHERE status <> ALL($1::text[]) AND slot_at IS NOT NULL
          ORDER BY slot_at DESC LIMIT 6`,
        [['idea', 'rejected', 'failed']],
      );
      const plan = planNext(
        ideas.rows.map((row: any) => {
          const v = rowToShort(row);
          return {
            id: v.id,
            rubric: v.rubric,
            assistantName: v.assistantId ? names.get(v.assistantId) ?? null : null,
            angle: v.angle,
            angleLocked: v.angleLocked,
            source: v.source,
            createdAt: v.createdAt ?? now,
          };
        }),
        recent.rows.map((r: any) => ({ rubric: r.rubric, angle: r.angle })),
      );
      if (!plan) return null;

      const r = await tx.query(
        `UPDATE short_video
            SET status = 'directing', slot_at = $2, angle = $3, attempts = 0, lease_until = NULL,
                last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'idea'
          RETURNING *`,
        [plan.ideaId, slot.toISOString(), plan.angle],
      );
      return r.rows[0] ? rowToShort(r.rows[0]) : null;
    });
  }

  private async insertIdea(i: IdeaInsert): Promise<ShortVideo | null> {
    const r = await this.pg.query(
      `INSERT INTO short_video
         (rubric, angle, angle_locked, source, source_ref, topic_key, topic_hint, title, assistant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (source_ref) WHERE source_ref IS NOT NULL DO NOTHING
       RETURNING *`,
      [i.rubric, i.angle, i.angleLocked, i.source, i.sourceRef, i.topicKey, i.topicHint, i.title, i.assistantId],
    );
    return r.rows[0] ? rowToShort(r.rows[0]) : null;
  }
}
