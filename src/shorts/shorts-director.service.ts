import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { PgService } from '../common/services/pg.service';
import { StageFatalError } from './short-jobs';
import { DirectorReply, parseDirectorReply } from './short-parse';
import { AgentLite, DIRECTOR_SKIT_SYSTEM, DIRECTOR_SYSTEM, buildDirectorMessage, recentSkitLine, toAgents } from './short-prompts';
import { checkSkitRules } from './short-rules';
import { Skit } from './short-skit-prompts';
import { shortSlug } from './short-slug';
import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortScene, ShortVideo } from './shorts.types';

/** Сколько прошлых вопросов показываем режиссёру, чтобы он не повторялся (спека, «Правила очереди»). */
const RECENT_QUESTIONS = 20;
/** Сценки скольких прошлых роликов показываем режиссёру, чтобы шутки не повторялись (спека сценок). */
const RECENT_SKITS = 20;
/** Сколько раз сценка 1 переписывается по нарушениям правил — как сценарий у сценариста. */
export const MAX_SKIT_REWRITES = 2;

@Injectable()
export class ShortsDirectorService {
  private readonly logger = new Logger(ShortsDirectorService.name);

  constructor(
    private readonly pg: PgService,
    private readonly relay: BlogRelayClient,
    private readonly agents: AgentsService,
  ) {}

  /**
   * Тема и подача → сцена чата. Пишет scene, assistant_id, slug и title и
   * переводит ролик в capture_queued. Ошибки релея и разбора бросаются как
   * есть — этап повторится по паузам (short-jobs.ts). Фатально только то,
   * что повтор не исправит.
   */
  async direct(v: ShortVideo): Promise<void> {
    const assistants = toAgents(await this.agents.getAgents('ru'));
    const fixed = v.assistantId ? assistants.find((a) => a.id === v.assistantId) ?? null : null;
    if (v.assistantId && !fixed) throw new StageFatalError(`режиссёр: ассистента ${v.assistantId} нет среди активных`);
    // Ролик со сценками: режиссёр пишет ещё и сценку 1 — она зависит только от вопроса (спека сценок).
    const skitFormat = v.format === 'skit';

    const recent = await this.pg.query(
      `SELECT scene->>'question' AS q FROM short_video
        WHERE id <> $1 AND scene IS NOT NULL
        ORDER BY created_at DESC LIMIT ${RECENT_QUESTIONS}`,
      [v.id],
    );
    const recentSkits = skitFormat
      ? (
          await this.pg.query(
            `SELECT scene->'skit' AS skit FROM short_video
              WHERE id <> $1 AND scene ? 'skit'
              ORDER BY created_at DESC LIMIT ${RECENT_SKITS}`,
            [v.id],
          )
        ).rows
          .map((r: any) => r.skit as Skit)
          .filter((s) => s && typeof s === 'object')
          .map(recentSkitLine)
      : [];

    let previous: Skit | null = null;
    let violations: string[] = [];
    for (let round = 0; round <= MAX_SKIT_REWRITES; round++) {
      const message = buildDirectorMessage({
        rubric: v.rubric,
        angle: v.angle,
        topicHint: v.topicHint,
        fixedAssistant: fixed,
        assistants,
        recentQuestions: recent.rows.map((r: any) => r.q).filter(Boolean),
        ownerNote: v.ownerNote,
        previousQuestion: v.scene?.question ?? null,
        ...(skitFormat ? { skit: { recent: recentSkits, previous, violations } } : {}),
      });

      // Новая сессия на каждый вызов: совпавший sessionId стенда и прода 18.10.2026
      // увёл новости блога не в тот канал.
      const sessionId = `short-direct-${v.id}-${randomUUID()}`;
      this.logger.log(`ролик ${v.id}: режиссёр, sessionId ${sessionId}`);
      const raw = await this.relay.ask(skitFormat ? DIRECTOR_SKIT_SYSTEM : DIRECTOR_SYSTEM, message, sessionId);
      const reply = parseDirectorReply(raw, {
        assistantIds: new Set(assistants.map((a) => a.id)),
        fixedAssistantId: fixed?.id ?? null,
        skit: skitFormat,
      });
      // Правила 16–18 у сценки 1 — до записи: сценка с нарушением дошла бы до
      // денег Omni. Нарушения уходят режиссёру на переписку, как сценаристу.
      violations = skitFormat ? checkSkitRules(reply.skit, 'conflict', null) : [];
      if (violations.length) {
        this.logger.warn(`ролик ${v.id}: сценка 1 не прошла правила (круг ${round + 1}): ${violations.join('; ')}`);
        previous = reply.skit;
        continue;
      }
      await this.save(v, assistants, reply);
      return;
    }
    throw new StageFatalError(`режиссёр: сценка 1 не прошла правила и после ${MAX_SKIT_REWRITES} переписок — ${violations.join('; ')}`);
  }

  private async save(v: ShortVideo, assistants: AgentLite[], reply: DirectorReply): Promise<void> {
    const assistant = assistants.find((a) => a.id === reply.assistantId);
    // Правило 12: здоровье — только в calm. buildDirectorMessage уже не
    // показывает ассистентов здоровья режиссёру при провокационной подаче,
    // но это не страхует разбор ответа — повтор даст другой выбор, поэтому
    // обычная Error, а не StageFatalError.
    if (!v.assistantId && PROVOCATIVE_ANGLES.includes(v.angle) && isHealthAssistant(assistant.name)) {
      throw new Error(`режиссёр: выбрал ассистента здоровья «${assistant.name}» для провокационной подачи — здоровье только в calm`);
    }
    const scene: ShortScene = {
      kind: 'chat',
      assistantId: reply.assistantId,
      assistantName: assistant.name,
      question: reply.question,
      followups: reply.followups,
      ...(reply.skit ? { skit: reply.skit } : {}),
    };
    // Новая сцена — новый круг с нуля («Переснять», просьба сценариста, повтор с
    // этапа режиссёра): съёмка, сценарий и подписи — от прошлой сцены, и
    // сценарист не должен получить их «прошлым вариантом» с номерами абзацев
    // чужого ответа; отзыв студии о прошлой озвучке и счёт её переписок — тоже.
    // animation не трогается: секунды Omni — счёт денег ролика целиком, а клипы
    // прошлой сценки с новыми отпечатками всё равно не совпадут.
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'capture_queued', scene = $2::jsonb, assistant_id = $3, slug = $4, title = $5,
              capture = NULL, script = NULL, captions = NULL, writer_feedback = NULL, writer_rounds = 0,
              attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'directing' AND attempts = $6`,
      [v.id, JSON.stringify(scene), reply.assistantId, v.slug ?? shortSlug(reply.title, v.id), reply.title, v.attempts],
    );
    // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из directing или его забрал другой процесс — сцену не записал`);
  }
}
