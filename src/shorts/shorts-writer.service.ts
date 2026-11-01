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
import { WRITER_SKIT_SYSTEM, WRITER_SYSTEM, buildWriterMessage, toAgents } from './short-prompts';
import { SKIT_LABELS, WriterCaptions, checkScriptRules, checkSkitRules } from './short-rules';
import { CASE_BADGE, buildScript } from './short-script';
import { SKIT_KINDS, Skit, SkitKind, SkitPlan, planSkits } from './short-skit-prompts';
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

/**
 * Принятые сценки с новыми репликами и действием одной из них — по отзыву студии.
 * Место, начало, герои и роли — принятые: отпечаток кадра сценки не меняется, кадр
 * не перерисуется. В ответе сценки нет — принятые как есть (нарушение назовёт
 * studioRewriteViolation).
 */
function withNewLines(accepted: Record<SkitKind, Skit>, kind: SkitKind, fresh: Skit | null): Record<SkitKind, Skit> {
  if (!fresh) return accepted;
  return { ...accepted, [kind]: { ...accepted[kind], action: fresh.action, lines: fresh.lines } };
}

/**
 * Сценка по отзыву студии не переписана: её нет в ответе, или клип вышел бы тем же —
 * отпечаток клипа совпал с тем, что студия не смогла снять (пробел или точка в конце
 * действия отпечаток не меняют, а лишний клип Omni стоит денег).
 */
function studioRewriteViolation(kind: SkitKind, fresh: Skit | null, sameClip: boolean): string | null {
  if (fresh && !sameClip) return null;
  return `${SKIT_LABELS[kind]}: отзыв студии — перепиши реплики и действие этой сценки (${fresh ? 'клип вышел бы тем же, что студия не смогла снять' : 'в ответе её нет'})`;
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
   *
   * Ролик со сценками: сценарист пишет ещё развязку и, по замечанию, переписывает
   * конфликт; код собирает промпты обеих сценок (planSkits) и отдаёт ролик на
   * оживление, а не на сборку. Сценка с прежним отпечатком не переснимется.
   *
   * Отзыв студии о сценке (skitFeedback) — переписываются реплики и действие только
   * названной сценки (withNewLines), остальное — принятое.
   */
  async write(v: ShortVideo): Promise<void> {
    if (!v.scene || !v.capture) throw new StageFatalError('no_scene', 'сценарист: у ролика нет сцены или съёмки');
    const skitFormat = v.format === 'skit';
    // Конфликт — последний принятый: переписанный по замечанию лежит в сценарии, исходный — в сцене режиссёра.
    let conflict: Skit | null = skitFormat ? v.script?.skits?.conflict?.skit ?? v.scene.skit ?? null : null;
    if (skitFormat && !conflict) {
      throw new StageFatalError('no_conflict', 'сценарист: у ролика со сценками нет сценки 1 — повторите с этапа режиссёра');
    }
    // Принятая развязка — из прошлого сценария: её клип мог быть уже снят. Сценарист
    // её не повторяет, пока замечания её не касаются, — и она не переснимается
    // при каждом «Замечании» или отзыве студии о длине озвучки.
    const acceptedPunchline: Skit | null = skitFormat ? v.script?.skits?.punchline?.skit ?? null : null;
    let rejectedPunchline: Skit | null = null;
    // По отзыву студии — прошлый вариант названной сценки (круг с нарушениями): модель видит, что исправлять.
    let rejectedFix: Skit | null = null;
    // Круг по отзыву студии — о длине озвучки: принятые сценки остаются, даже если
    // модель их вернула, — эхо с правкой одной буквы сменило бы отпечаток и стоило
    // бы клипа Omni. writer_feedback пишет только студия; новое замечание владельца
    // начинает круг без него (ответ сценариста, «Повторить» с замечанием).
    const keepSkits = skitFormat && !!v.writerFeedback && !v.skitFeedback && !!v.script?.skits?.conflict && !!acceptedPunchline;
    // Отзыв студии о сценке: Omni её не снять с этими репликами. Переписываются только
    // реплики и действие названной сценки, база — принятые сценки, а не варианты кругов
    // переписки: сравнивать «то же или нет» надо с тем, что Omni не озвучил.
    // Вид сценки из базы проверяется: испорченное значение — обычная переписка, а не TypeError.
    const fixKind: SkitKind | null =
      skitFormat && v.skitFeedback && SKIT_KINDS.includes(v.skitFeedback.kind) && v.script?.skits?.[v.skitFeedback.kind] && conflict && acceptedPunchline
        ? v.skitFeedback.kind
        : null;
    const fixBase: Record<SkitKind, Skit> | null = fixKind ? { conflict: conflict!, punchline: acceptedPunchline! } : null;
    if (fixKind) this.logger.log(`ролик ${v.id}: отзыв студии о сценке ${fixKind} — переписываю её реплики и действие`);
    else if (skitFormat && v.skitFeedback) this.logger.warn(`ролик ${v.id}: отзыв студии о сценке не применить (${JSON.stringify(v.skitFeedback).slice(0, 200)}) — обычная переписка`);
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
        // Отзыв студии о сценке в формате «Только чат» не к месту: сценок нет, а «перепиши реплики» урезал бы озвучку.
        writerFeedback: !skitFormat && v.skitFeedback ? null : v.writerFeedback,
        previousScript: previous,
        previousCaptions,
        violations,
        ...(skitFormat
          ? { skit: { conflict, acceptedPunchline, rejectedPunchline, ...(fixKind ? { fix: { kind: fixKind, rejected: rejectedFix } } : {}) } }
          : {}),
      });
      const raw = await this.relay.ask(skitFormat ? WRITER_SKIT_SYSTEM : WRITER_SYSTEM, message, `short-write-${v.id}-${randomUUID()}`);
      const reply = parseWriterReply(raw, { skit: skitFormat, acceptedPunchline: !!acceptedPunchline });
      if (reply.needsRecapture) {
        if (recapturesInRow(v.ownerNote) >= MAX_RECAPTURES) {
          throw new StageFatalError('recapture', `сценарист: уже дважды просил другую сцену — нужен взгляд владельца; последняя причина: ${reply.reason}`);
        }
        await this.backToDirector(v, reply.reason);
        return;
      }
      const paragraphs = v.capture.paragraphs ?? [];
      const skits = !skitFormat
        ? null
        : fixKind
          ? withNewLines(fixBase!, fixKind, reply.skits[fixKind])
          : keepSkits
            ? { conflict, punchline: acceptedPunchline }
            : { conflict: reply.skits.conflict ?? conflict, punchline: reply.skits.punchline ?? acceptedPunchline };
      // Промпты сценок — только из сценок без нарушений: planSkits на кривой
      // сценке бросает первую же ошибку, а правила называют все разом.
      let planned: Record<SkitKind, SkitPlan> | undefined;
      let planError: string | null = null;
      if (skits && !checkSkitRules(skits.conflict, 'conflict', paragraphs).length && !checkSkitRules(skits.punchline, 'punchline', paragraphs).length) {
        try {
          planned = planSkits(skits);
        } catch (e: any) {
          planError = String(e?.message ?? e);
        }
      }
      const script = buildScript(reply, { ...options, format: v.format, skits: planned });
      violations = checkScriptRules({
        angle: v.angle,
        assistantName: name,
        script,
        captions: reply.captions,
        paragraphs,
        answerText: v.capture.answerText ?? '',
        sceneQuestion: v.scene.question,
        assistantsCount,
        format: v.format,
        ...(skits ? { skits } : {}),
      });
      if (planError) violations.push(planError);
      if (fixKind) {
        const sameClip = !!planned && planned[fixKind].fingerprint === v.script?.skits?.[fixKind]?.fingerprint;
        const notRewritten = studioRewriteViolation(fixKind, reply.skits[fixKind], sameClip);
        if (notRewritten) violations.push(notRewritten);
      }
      if (violations.length) {
        this.logger.warn(`ролик ${v.id}: сценарий не прошёл правила (круг ${round + 1}): ${violations.join('; ')}`);
        previous = script;
        previousCaptions = reply.captions;
        // По отзыву студии база — принятые сценки: следующий круг снова видит то, что Omni не озвучил.
        if (skits && !fixKind) {
          conflict = skits.conflict;
          rejectedPunchline = reply.skits.punchline;
        }
        if (skits && fixKind && reply.skits[fixKind]) rejectedFix = skits[fixKind];
        continue;
      }
      const r = await this.pg.query(
        `UPDATE short_video
            SET status = $6, script = $2::jsonb, captions = $3::jsonb, slug = $4,
                writer_feedback = NULL, skit_feedback = NULL, writer_rounds = writer_rounds + 1,
                attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'writing' AND attempts = $5`,
        [v.id, JSON.stringify(script), JSON.stringify(buildCaptions(reply.captions, links)), slug, v.attempts, skitFormat ? 'animate_queued' : 'render_queued'],
      );
      // attempts = номер захвата: опоздавший процесс не пишет поверх того, кто забрал этап после него.
      if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — сценарий не записал`);
      return;
    }
    throw new StageFatalError('rules', `сценарист: правила текста не прошли и после ${MAX_REWRITES} переписок — ${violations.join('; ')}`);
  }

  /**
   * Нужна другая сцена: причина ложится к замечаниям — их прочтёт режиссёр.
   * Новая съёмка — новый круг: отзыв студии о прошлой озвучке и сценке и счёт их
   * переписок обнуляются, как при замечании владельца и повторе из failed.
   */
  private async backToDirector(v: ShortVideo, reason: string): Promise<void> {
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = 'directing', owner_note = $2, writer_feedback = NULL, skit_feedback = NULL, writer_rounds = 0,
              attempts = 0, lease_until = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'writing' AND attempts = $3`,
      [v.id, appendOwnerNote(v.ownerNote, `${RECAPTURE_NOTE} ${reason}`), v.attempts],
    );
    if (r.rowCount === 0) this.logger.warn(`ролик ${v.id} ушёл из writing или его забрал другой процесс — к режиссёру не вернул`);
    else this.logger.log(`ролик ${v.id}: сценарист просит новую сцену — ${reason}`);
  }
}
