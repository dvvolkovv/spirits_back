import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { PgService } from '../common/services/pg.service';
import { StageFatalError } from './short-jobs';
import { parseDirectorReply } from './short-parse';
import { DIRECTOR_SYSTEM, buildDirectorMessage, toAgents } from './short-prompts';
import { shortSlug } from './short-slug';
import { ShortScene, ShortVideo } from './shorts.types';

/** Сколько прошлых вопросов показываем режиссёру, чтобы он не повторялся (спека, «Правила очереди»). */
const RECENT_QUESTIONS = 20;

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

    const recent = await this.pg.query(
      `SELECT scene->>'question' AS q FROM short_video
        WHERE id <> $1 AND scene IS NOT NULL
        ORDER BY created_at DESC LIMIT ${RECENT_QUESTIONS}`,
      [v.id],
    );
    const message = buildDirectorMessage({
      rubric: v.rubric,
      angle: v.angle,
      topicHint: v.topicHint,
      fixedAssistant: fixed,
      assistants,
      recentQuestions: recent.rows.map((r: any) => r.q).filter(Boolean),
      ownerNote: v.ownerNote,
      previousQuestion: v.scene?.question ?? null,
    });

    // Новая сессия на каждый вызов: совпавший sessionId стенда и прода 18.10.2026
    // увёл новости блога не в тот канал.
    const sessionId = `short-direct-${v.id}-${randomUUID()}`;
    this.logger.log(`ролик ${v.id}: режиссёр, sessionId ${sessionId}`);
    const raw = await this.relay.ask(DIRECTOR_SYSTEM, message, sessionId);
    const reply = parseDirectorReply(raw, {
      assistantIds: new Set(assistants.map((a) => a.id)),
      fixedAssistantId: fixed?.id ?? null,
    });

    const assistant = assistants.find((a) => a.id === reply.assistantId);
    const scene: ShortScene = {
      kind: 'chat',
      assistantId: reply.assistantId,
      assistantName: assistant.name,
      question: reply.question,
      followups: reply.followups,
    };
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'capture_queued', scene = $2::jsonb, assistant_id = $3, slug = $4, title = $5,
              attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'directing' AND attempts = $6`,
      [v.id, JSON.stringify(scene), reply.assistantId, v.slug ?? shortSlug(reply.title, v.id), reply.title, v.attempts],
    );
    // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из directing или его забрал другой процесс — сцену не записал`);
  }
}
