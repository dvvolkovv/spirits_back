import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import {
  BlogTopicService, caseTopicHint, hasClearProfile, normalizeTopicKey, STALE_DRAFTING_MINUTES,
} from './blog-topic.service';
import { BlogEditorService } from './blog-editor.service';
import { BlogImageService } from './blog-image.service';
import { BlogPublisherService, MAX_PUBLISH_ATTEMPTS } from './blog-publisher.service';
import { BlogApprovalService } from './blog-approval.service';
import { BlogSettingsService } from './blog-settings.service';
import { BlogNewsService } from './blog-news.service';
import { ALLOWED_TRANSITIONS, BlogStatus, canTransition, rowToPost } from './blog.types';
import { NoFreeSlotError, nextFreeSlotAfter, STALE_NEWS_DAYS } from './blog-slots';
import { slotHolders } from './blog-slot-claim';

/** Напоминание уходит, когда до слота осталось меньше этого. */
const REMIND_WINDOW_MINUTES = 60;

/**
 * Через сколько минут пост в `publishing` считается зависшим.
 *
 * Захват `approved → publishing` и ответ Telegram разделяет одна отправка
 * фото — это секунды, в худшем случае десятки секунд на медленном аплоаде.
 * Десять минут заведомо больше любого живого аплоада, поэтому пост, который
 * столько висит в `publishing`, — не медленный, а осиротевший: процесс умер
 * между захватом и ответом. Порог намеренно вдвое больше тика публикации
 * (5 минут), чтобы сторож не отобрал пост у ещё работающей отправки.
 */
export const STUCK_PUBLISHING_MINUTES = 10;

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
    private readonly news: BlogNewsService,
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

  /**
   * Воскресенье 09:00 МСК. Порядок важен: сначала темы, потом черновик к
   * понедельнику.
   *
   * Новость заводится на ТЕМУ недели, а не на коммит: коммит новостью быть
   * не может — фича размазана по десяткам коммитов, и «тема на коммит»
   * давала на проде ~30 тем в неделю, ни одна из которых не годилась для
   * канала. Отбор живёт в `BlogNewsService`; нормальный исход недели —
   * пустой список.
   *
   * Новости и кейсы разведены по разным try намеренно: отбор новостей ходит
   * в релей, а тот отваливается регулярно. Общий catch унёс бы вместе с
   * новостями и кейсы, которым релей не нужен, и канал остался бы вообще без
   * тем на неделю.
   */
  @Cron('0 6 * * 0')
  async refillTopics(): Promise<void> {
    if (!this.enabled()) return;

    try {
      for (const topic of await this.news.weeklyTopics()) {
        await this.topics.addTopic(topic);
      }
    } catch (e: any) {
      this.logger.error(`отбор новостей недели сорвался: ${e.message}`);
    }

    try {
      for (const a of await this.topics.topAssistants(3)) {
        // Запрос уже отсекает ассистентов без профиля; здесь — последний
        // рубеж: подсказка без профиля и есть тот кейс о выдуманном
        // ассистенте, ради которого всё затевалось.
        if (!hasClearProfile(a.description)) {
          this.logger.warn(`кейс про «${a.agentName}» не заведён: нет внятного профиля в agents.description`);
          continue;
        }
        await this.topics.addTopic({
          rubric: 'case', source: 'stats', sourceRef: `stats:${a.agentId}`,
          topicKey: normalizeTopicKey(`кейс ${a.agentName} ${new Date().toISOString().slice(0, 10)}`),
          topicHint: caseTopicHint(a),
        });
      }
    } catch (e: any) {
      this.logger.error(`пополнение кейсов сорвалось: ${e.message}`);
    }
  }

  /**
   * Каждые 5 минут: если владельцу нечего решать и никто не пишет черновик —
   * готовим следующий.
   *
   * Пять минут, а не час, потому что это же расписание обслуживает
   * переработку: владелец прислал замечание реплаем, бот ответил «перепишу» —
   * и на часовом тике это обещание наступало бы в среднем через полчаса, а в
   * худшем случае через час. За это время проще отправить пост в мусор, чем
   * дождаться исправленного.
   *
   * Очередь держат двое:
   *
   *  - пост в `pending_review` — владелец ещё не решил, и второй черновик
   *    только завалил бы его;
   *  - черновик, который пишется ПРЯМО СЕЙЧАС: `drafting` со свежей отметкой
   *    `drafting_started_at`. Без него тик, пришедший, пока релей думает
   *    дольше пяти минут, начинал бы следующую тему параллельно.
   *
   * `approved` очередь НЕ держит. Одобренный пост уже решён и просто ждёт
   * слота; раньше он держал всё: кейс, одобренный в пятницу на понедельник,
   * не давал начать срочную новость до понедельника. Два одобренных сразу
   * теперь норма — поэтому слот при одобрении считается ближайшим свободным
   * (см. `approveIntoFreeSlot`), а не ближайшим вообще.
   *
   * Условие на `drafting` — ровно отрицание того, по которому пост берут в
   * работу (`takeNextIdea` и захват ниже: «отметки нет ИЛИ она протухла»),
   * с тем же порогом `STALE_DRAFTING_MINUTES`. Поэтому любой пост в
   * `drafting` либо держит очередь, либо сам может быть взят — третьего нет,
   * и дедлока тоже:
   *
   *  - пустая отметка — запрошенная переработка («Переписать», замечание),
   *    она ждёт, чтобы её взяли. Сочти её охрана занятой — переработка
   *    заблокировала бы сама себя навсегда;
   *  - протухшая отметка — черновик взяли и бросили; его подбирает
   *    `takeNextIdea`, держать очередь ему незачем;
   *  - свежая отметка — живая подготовка, и она сама кончится: черновик уйдёт
   *    на проверку, в `failed`, или отметка протухнет, если процесс умер.
   *
   * Лишней работы учащение тика не даёт: в устойчивом состоянии пост стоит
   * на проверке, и охрана выходит первым же запросом.
   */
  @Cron('*/5 * * * *')
  async prepareDrafts(): Promise<void> {
    if (!this.enabled()) return;

    const busy = await this.pg.query(
      `SELECT count(*)::int AS n FROM blog_post
        WHERE status = 'pending_review'
           OR (status = 'drafting'
               AND drafting_started_at IS NOT NULL
               AND drafting_started_at >= now() - ($1 || ' minutes')::interval)`,
      [STALE_DRAFTING_MINUTES],
    );
    if (Number(busy.rows[0]?.n || 0) > 0) return;

    const idea = await this.topics.takeNextIdea();
    if (!idea) return;

    // Между выборкой идеи и этой записью статус могли увести из админки или
    // кнопкой в личке. Решает машина состояний, а не то, что запрос выбирал
    // по status = 'idea'.
    if (!canTransition(idea.status, 'drafting')) {
      this.logger.warn(`идея ${idea.id}: переход ${idea.status} → drafting запрещён, пропускаю`);
      return;
    }

    // Атомарный захват — тем же приёмом, что и у паблишера: UPDATE с условием
    // и RETURNING, выигрывает ровно один вызов.
    //
    // Статуса для захвата не хватает: у переработки его смены нет вовсе (пост
    // после замечания уже в `drafting`), поэтому захват идёт по отметке
    // `drafting_started_at`. Условие «пусто ИЛИ протухло» — это ровно та же
    // пара случаев, по которой отбирал `takeNextIdea`, но здесь она решает
    // спор двух тиков, а не отбирает кандидата.
    //
    // Замок в памяти процесса здесь не годится: `linkeon-api` поднят в
    // cluster_mode, и первый же `pm2 scale linkeon-api 2` развёл бы тики по
    // процессам, ничего не сообщив; крон вдобавок иногда дёргают отдельным
    // процессом руками.
    const claim = await this.pg.query(
      `UPDATE blog_post
          SET status = 'drafting', drafting_started_at = now(), updated_at = now()
        WHERE id = $1
          AND status = ANY($2::text[])
          AND (drafting_started_at IS NULL
               OR drafting_started_at < now() - ($3 || ' minutes')::interval)
        RETURNING id`,
      [idea.id, sourcesFor('drafting'), STALE_DRAFTING_MINUTES],
    );
    // Пусто — пост забрал другой тик. Это штатная гонка, а не сбой: ни ошибки
    // в лог, ни сообщения владельцу, иначе каждый второй тик писал бы панику.
    if (!claim.rows.length) return;

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

  /**
   * Каждые 5 минут: сторож зависших. Пост, захваченный под публикацию и
   * осиротевший (процесс умер между захватом и ответом Telegram), сам собой
   * из `publishing` не выйдет — его не выберет ни один запрос.
   *
   * Источник перехода здесь жёстко один — `publishing`, и это не лень:
   * взять список статусов «откуда можно в approved» значило бы подхватить
   * заодно и `pending_review`, то есть одобрить пост за владельца.
   */
  @Cron('*/5 * * * *')
  async rearmStuck(): Promise<void> {
    if (!this.enabled()) return;
    if (!canTransition('publishing', 'approved')) {
      this.logger.error('машина состояний запрещает publishing → approved — сторож зависших выключен');
      return;
    }

    const r = await this.pg.query(
      `UPDATE blog_post
          SET status = 'approved', updated_at = now()
        WHERE status = 'publishing'
          AND updated_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [STUCK_PUBLISHING_MINUTES],
    );
    if (r.rows.length) {
      this.logger.warn(`перевзведено зависших в publishing: ${r.rows.length} (${r.rows.map((x: any) => x.id).join(', ')})`);
    }
  }

  /** Раз в сутки: протухшие новости в мусор. */
  @Cron('0 4 * * *')
  async dropStaleNews(): Promise<void> {
    if (!this.enabled()) return;
    const r = await this.pg.query(
      `UPDATE blog_post
          SET status = 'rejected', last_error = 'протухла',
              editor_notes = '{}'::text[], updated_at = now()
        WHERE rubric = 'news'
          AND status = ANY($1::text[])
          AND created_at < now() - ($2 || ' days')::interval
        RETURNING id`,
      [sourcesFor('rejected'), STALE_NEWS_DAYS],
    );
    if (r.rows.length) this.logger.log(`выброшено протухших новостей: ${r.rows.length}`);
  }

  /**
   * За час до слота — напоминание, если решения нет. Молчание не публикует.
   *
   * Слот — тот, который пост получит, если одобрить его сейчас, то есть
   * ближайший СВОБОДНЫЙ. Раньше он совпадал с ближайшим вообще: одобренный
   * пост держал очередь, и поста на проверке рядом с ним не было. Теперь
   * напоминание про слот, уже занятый одобренным постом, врало бы — «без
   * апрува слот пропустим», а он не пропадёт.
   */
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

    const now = new Date();
    let slot: Date;
    try {
      slot = nextFreeSlotAfter(now, slotDays, slotHourMsk, (await slotHolders(this.pg, now)).map((h) => h.slotAt));
    } catch (e: any) {
      if (e instanceof NoFreeSlotError) return;   // напоминать не о чем — свободного слота нет
      throw e;
    }
    const minutesLeft = Math.round((slot.getTime() - now.getTime()) / 60000);
    if (minutesLeft > REMIND_WINDOW_MINUTES || minutesLeft < 0) return;

    await this.approval.notify(
      chatId,
      `Блог: через час слот, а пост «${r.rows[0].title}» без решения. Без апрува слот пропустим.`,
    );
  }
}
