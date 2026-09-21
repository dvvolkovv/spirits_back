import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { BlogTopicService, normalizeTopicKey } from './blog-topic.service';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogSettingsService } from './blog-settings.service';
import { BlogGitSource } from './blog-git.source';
import { ALLOWED_TRANSITIONS, BlogStatus, canTransition, rowToPost } from './blog.types';
import { nextSlotAfter, STALE_NEWS_DAYS } from './blog-slots';

const MAX_PUBLISH_ATTEMPTS = 3;

/** Напоминание уходит, когда до слота осталось меньше этого. */
const REMIND_WINDOW_MINUTES = 60;

/**
 * Статусы, из которых переход в `target` легален — по той же машине
 * состояний, что и все остальные записи статуса. Перечислять их литералом
 * в SQL значило бы завести вторую, молча расходящуюся копию правил.
 */
function sourcesFor(target: BlogStatus): BlogStatus[] {
  return (Object.keys(ALLOWED_TRANSITIONS) as BlogStatus[]).filter((from) => canTransition(from, target));
}

@Injectable()
export class BlogCron {
  private readonly logger = new Logger(BlogCron.name);

  constructor(
    private readonly pg: PgService,
    private readonly topics: BlogTopicService,
    private readonly editor: BlogEditorService,
    private readonly images: BlogImageService,
    private readonly publisher: BlogPublisherService,
    private readonly approval: BlogApprovalService,
    private readonly settings: BlogSettingsService,
    private readonly git: BlogGitSource,
  ) {}

  /**
   * Рубильник уровня деплоя. Намеренно в env, а не в админке: если модуль
   * начнёт чудить, гасить его через ту же админку — плохая идея.
   */
  private enabled(): boolean {
    return String(process.env.BLOG_ENABLED || '').toLowerCase() === 'true';
  }

  private approverChatId(): number | null {
    const raw = process.env.BLOG_APPROVER_TG_ID;
    return raw ? Number(raw) : null;
  }

  /** Воскресенье 09:00 МСК. Порядок важен: сначала темы, потом черновик к понедельнику. */
  @Cron('0 6 * * 0')
  async refillTopics(): Promise<void> {
    if (!this.enabled()) return;
    try {
      for (const c of await this.git.weeklyCommits()) {
        await this.topics.addTopic({
          rubric: 'news', source: 'git', sourceRef: `commit:${c.sha}`,
          topicKey: normalizeTopicKey(c.subject), topicHint: c.subject,
        });
      }
      for (const a of await this.topics.topAssistants(3)) {
        await this.topics.addTopic({
          rubric: 'case', source: 'stats', sourceRef: `stats:${a.agentId}`,
          topicKey: normalizeTopicKey(`кейс ${a.agentName} ${new Date().toISOString().slice(0, 10)}`),
          topicHint: `На этой неделе чаще всего обращались к ассистенту «${a.agentName}» (${a.turns} обращений). Придумай кейс по его профилю.`,
        });
      }
    } catch (e: any) {
      this.logger.error(`пополнение тем сорвалось: ${e.message}`);
    }
  }

  /** Каждый час: если ближайший слот ничем не обеспечен — готовим черновик. */
  @Cron('0 * * * *')
  async prepareDrafts(): Promise<void> {
    if (!this.enabled()) return;

    const pending = await this.pg.query(
      `SELECT count(*)::int AS n FROM blog_post WHERE status IN ('pending_review','approved')`,
    );
    if (Number(pending.rows[0]?.n || 0) > 0) return;

    const idea = await this.topics.takeNextIdea();
    if (!idea) return;

    // Между выборкой идеи и этой записью статус могли увести из админки или
    // кнопкой в личке. Решает машина состояний, а не то, что запрос выбирал
    // по status = 'idea'.
    if (!canTransition(idea.status, 'drafting')) {
      this.logger.warn(`идея ${idea.id}: переход ${idea.status} → drafting запрещён, пропускаю`);
      return;
    }

    await this.pg.query(
      `UPDATE blog_post SET status = 'drafting', updated_at = now()
        WHERE id = $1 AND status = ANY($2::text[])`,
      [idea.id, sourcesFor('drafting')],
    );

    try {
      const draft = await this.editor.draft(idea);
      const imageUrl = await this.images.render(draft.title, draft.imagePrompt);

      await this.pg.query(
        `UPDATE blog_post
            SET title = $2, body = $3, image_prompt = $4, image_url = $5, last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [idea.id, draft.title, draft.body, draft.imagePrompt, imageUrl],
      );

      const chatId = this.approverChatId();
      if (!chatId) {
        this.logger.error('BLOG_APPROVER_TG_ID не задан — черновик готов, но показать его некому');
        return;
      }
      // Пост собираем из того, что только что записали, а не перечитываем
      // строку через RETURNING: лишний round-trip, который вдобавок роняет
      // весь метод в catch, если строку кто-то успел удалить.
      await this.approval.sendForReview(
        { ...idea, status: 'drafting', title: draft.title, body: draft.body, imagePrompt: draft.imagePrompt, imageUrl },
        chatId,
      );
    } catch (e: any) {
      await this.pg.query(
        `UPDATE blog_post SET status = 'failed', last_error = $2, updated_at = now()
          WHERE id = $1 AND status = ANY($3::text[])`,
        [idea.id, String(e.message).slice(0, 500), sourcesFor('failed')],
      );
      this.logger.error(`черновик ${idea.id} не собрался: ${e.message}`);
      const chatId = this.approverChatId();
      if (chatId) {
        await this.approval.notify(chatId, `Блог: черновик не собрался — ${e.message}`);
      }
    }
  }

  /**
   * Каждые 5 минут: публикуем всё, у чего слот наступил.
   *
   * Статус здесь не пишется намеренно: захват `approved → publishing` делает
   * сам паблишер одним UPDATE с условием на статус, иначе два тика крона
   * положили бы в канал два одинаковых поста.
   */
  @Cron('*/5 * * * *')
  async publishDue(): Promise<void> {
    if (!this.enabled()) return;

    const r = await this.pg.query(
      `SELECT * FROM blog_post
        WHERE status = 'approved' AND slot_at IS NOT NULL AND slot_at <= now()
          AND attempts < $1
        ORDER BY slot_at ASC LIMIT 5`,
      [MAX_PUBLISH_ATTEMPTS],
    );
    for (const row of r.rows) {
      await this.publisher.publish(rowToPost(row));
    }
  }

  /** Раз в сутки: протухшие новости в мусор. */
  @Cron('0 4 * * *')
  async dropStaleNews(): Promise<void> {
    if (!this.enabled()) return;
    const r = await this.pg.query(
      `UPDATE blog_post
          SET status = 'rejected', last_error = 'протухла', updated_at = now()
        WHERE rubric = 'news'
          AND status = ANY($1::text[])
          AND created_at < now() - ($2 || ' days')::interval
        RETURNING id`,
      [sourcesFor('rejected'), STALE_NEWS_DAYS],
    );
    if (r.rows.length) this.logger.log(`выброшено протухших новостей: ${r.rows.length}`);
  }

  /** За час до слота — напоминание, если решения нет. Молчание не публикует. */
  @Cron('0 * * * *')
  async remindPending(): Promise<void> {
    if (!this.enabled()) return;
    const chatId = this.approverChatId();
    if (!chatId) return;

    const { slotDays, slotHourMsk } = await this.settings.get();
    const r = await this.pg.query(
      `SELECT id, title FROM blog_post WHERE status = 'pending_review' ORDER BY created_at ASC LIMIT 1`,
    );
    if (!r.rows.length) return;

    const slot = nextSlotAfter(new Date(), slotDays, slotHourMsk);
    const minutesLeft = Math.round((slot.getTime() - Date.now()) / 60000);
    if (minutesLeft > REMIND_WINDOW_MINUTES || minutesLeft < 0) return;

    await this.approval.notify(
      chatId,
      `Блог: через час слот, а пост «${r.rows[0].title}» без решения. Без апрува слот пропустим.`,
    );
  }
}
