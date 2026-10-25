import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AgentsService } from '../agents/agents.service';
import { BlogRelayClient } from '../blog/blog-relay.client';
import { PgService } from '../common/services/pg.service';
import { assistantVoice, disclaimerFor } from './short-assistants';
import { buildCaptions } from './short-captions';
import { StageFatalError } from './short-jobs';
import { linkBase, shortLinks, shortTarget } from './short-links';
import { parseWriterReply } from './short-parse';
import { WRITER_SYSTEM, buildWriterMessage, toAgents } from './short-prompts';
import { WriterCaptions, checkScriptRules } from './short-rules';
import { CASE_BADGE, buildScript } from './short-script';
import { shortSlug } from './short-slug';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortScript, ShortVideo, appendOwnerNote } from './shorts.types';

/** Сколько раз сценарий переписывается по нарушениям правил (спека, «Обработка отказов»). */
export const MAX_REWRITES = 2;

/**
 * Сколько раз подряд сценарист может вернуть ролик режиссёру за новой сценой.
 * Дальше круги не помогут — нужен взгляд владельца. Счёт — с последнего
 * замечания владельца: его новое замечание — новый круг.
 */
export const MAX_RECAPTURES = 2;
const RECAPTURE_NOTE = 'Сценарист:';

/** Просьбы «Сценарист: …» в хвосте замечаний — после последнего замечания владельца. */
function recapturesInRow(ownerNote: string | null): number {
  const lines = String(ownerNote ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  let n = 0;
  while (n < lines.length && lines[lines.length - 1 - n].startsWith(RECAPTURE_NOTE)) n++;
  return n;
}

@Injectable()
export class ShortsWriterService {
  private readonly logger = new Logger(ShortsWriterService.name);

  constructor(
    private readonly pg: PgService,
    private readonly relay: BlogRelayClient,
    private readonly agents: AgentsService,
    private readonly settings: ShortsSettingsService,
  ) {}

  /**
   * Снятый ответ → сценарий студии и подписи площадок, затем проверка правил.
   * Не прошёл — переписка с перечнем нарушений, до MAX_REWRITES раз; не
   * помогло — StageFatalError (повтор тем же ответом бессмыслен).
   */
  async write(v: ShortVideo): Promise<void> {
    if (!v.scene || !v.capture) throw new StageFatalError('сценарист: у ролика нет сцены или съёмки');
    const [rows, settings] = await Promise.all([this.agents.getAgents('ru'), this.settings.get()]);
    const assistants = toAgents(rows);
    const name = v.scene.assistantName;
    const description = assistants.find((a) => a.id === v.scene.assistantId)?.description ?? '';
    const assistantsCount = assistants.length;
    const slug = v.slug ?? shortSlug(v.title ?? v.topicKey, v.id);
    const links = shortLinks(linkBase(), shortTarget(v.scene.assistantId), slug);
    const options = {
      voice: assistantVoice(name),
      narratorVoice: settings.narratorVoice,
      assistantsCount,
      disclaimer: disclaimerFor(name),
      badge: v.rubric === 'case' ? CASE_BADGE : undefined,
    };

    let violations: string[] = [];
    // Со второго круга сценарист видит отвергнутый вариант, а не прежний
    // сценарий из базы: иначе нарушение названо, а текста, где оно, перед ним нет.
    let previous: ShortScript | null = v.script;
    // Подписи — только отвергнутого круга: у сценария из базы они уже с хвостом ссылок.
    let previousCaptions: WriterCaptions | null = null;
    for (let round = 0; round <= MAX_REWRITES; round++) {
      const message = buildWriterMessage({
        rubric: v.rubric,
        angle: v.angle,
        assistantName: name,
        assistantDescription: description,
        question: v.scene.question,
        paragraphs: v.capture.paragraphs ?? [],
        ownerNote: v.ownerNote,
        writerFeedback: v.writerFeedback,
        previousScript: previous,
        previousCaptions,
        violations,
      });
      const raw = await this.relay.ask(WRITER_SYSTEM, message, `short-write-${v.id}-${randomUUID()}`);
      const reply = parseWriterReply(raw);
      if (reply.needsRecapture) {
        if (recapturesInRow(v.ownerNote) >= MAX_RECAPTURES) {
          throw new StageFatalError(`сценарист: уже дважды просил другую сцену — нужен взгляд владельца; последняя причина: ${reply.reason}`);
        }
        await this.backToDirector(v, reply.reason);
        return;
      }
      const script = buildScript(reply, options);
      violations = checkScriptRules({
        angle: v.angle,
        assistantName: name,
        script,
        captions: reply.captions,
        paragraphs: v.capture.paragraphs ?? [],
        answerText: v.capture.answerText ?? '',
        sceneQuestion: v.scene.question,
        assistantsCount,
      });
      if (violations.length) {
        this.logger.warn(`ролик ${v.id}: сценарий не прошёл правила (круг ${round + 1}): ${violations.join('; ')}`);
        previous = script;
        previousCaptions = reply.captions;
        continue;
      }
      const r = await this.pg.query(
        `UPDATE short_video
            SET status = 'render_queued', script = $2::jsonb, captions = $3::jsonb, slug = $4,
                writer_feedback = NULL, writer_rounds = writer_rounds + 1,
                attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'writing' AND attempts = $5`,
        [v.id, JSON.stringify(script), JSON.stringify(buildCaptions(reply.captions, links)), slug, v.attempts],
      );
      // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
      if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — сценарий не записал`);
      return;
    }
    throw new StageFatalError(`сценарист: правила текста не прошли и после ${MAX_REWRITES} переписок — ${violations.join('; ')}`);
  }

  /**
   * Нужна другая сцена: причина ложится к замечаниям — их прочтёт режиссёр.
   * Новая съёмка — новый круг: отзыв студии о прошлой озвучке и счёт её
   * переписок обнуляются, как при замечании владельца и повторе из failed.
   */
  private async backToDirector(v: ShortVideo, reason: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'directing', owner_note = $2, writer_feedback = NULL, writer_rounds = 0,
              attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'writing' AND attempts = $3`,
      [v.id, appendOwnerNote(v.ownerNote, `${RECAPTURE_NOTE} ${reason}`), v.attempts],
    );
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — к режиссёру не вернул`);
    else this.logger.log(`ролик ${v.id}: сценарист просит новую сцену — ${reason}`);
  }
}
