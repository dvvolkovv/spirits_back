import { BadRequestException, Body, ConflictException, Controller, NotFoundException, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { inTransaction } from '../blog/blog-slot-claim';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { NoFreeSlotError } from '../blog/blog-slots';
import { LEAVE_FROM, RELEASED_SQL, ReviewRefusal, explainRefusal, leaveReview, noteForReview, versionClause } from './short-review';
import { approveShortIntoSlot, isShortSlotConflict } from './short-slot-claim';
import { ShortSettingsPatch, ShortsSettingsService, validateSettingsPatch } from './shorts-settings.service';
import { ShortOrderError, ShortsTopicService } from './shorts-topic.service';
import {
  MAX_OWNER_NOTE_CHARS, ShortPublication, ShortStatus, ShortVideo, appendOwnerNote, canTransition, retryTarget, rowToPublication, rowToShort,
  shortsBucket,
} from './shorts.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Пост в Telegram-канале, как его строит ShortsPublisherService.toTelegram
 * (через buildPostUrl блога): публичный канал — `t.me/<username>/<n>`,
 * приватный — `t.me/c/<id>/<n>`. Номер поста — последний сегмент, он же
 * `external_id` площадки.
 */
const TG_POST_URL = /^https:\/\/t\.me\/(?:c\/\d+|[A-Za-z0-9_]{3,32})\/(\d+)$/;

function parseTelegramPostUrl(url: string): string | null {
  const m = TG_POST_URL.exec(String(url ?? '').trim());
  return m ? m[1] : null;
}

/** С каких этапов владелец может повторить упавший ролик вместо этапа падения. */
const RETRY_FROM = ['directing', 'writing'] as const;
type RetryFrom = (typeof RETRY_FROM)[number];

/** Тяжёлые поля ролика (около 35 КБ на собранный): в list не отдаём — они приходят в get. */
function light(v: ShortVideo): Partial<ShortVideo> {
  const out: Partial<ShortVideo> = { ...v };
  delete out.capture;
  delete out.script;
  delete out.animation;
  delete out.captions;
  return out;
}

/**
 * Метка версии в ссылке на файл: пересобранный ролик лежит по тому же адресу
 * (`shorts/<id>/video.mp4`), и без метки браузер покажет прежнюю версию из кэша.
 * nginx прода (`/smm-media/`) срезает строку запроса до MinIO.
 */
function withVersion(url: string, version: string | null): string {
  return version ? `${url}?v=${encodeURIComponent(version)}` : url;
}

/** Версия ролика из list/get — `updated_at::text` Postgres, например «2026-10-30 12:34:56.123456+00». */
export const VERSION_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?[+-]\d{2}(:\d{2})?$/;
const NEED_VERSION = 'нужна версия ролика (поле version из list или get)';
const STALE_SHORT = 'Ролик изменился, пока был открыт: на экране устаревшая версия';
const RELEASED_TEXT = 'Ролик уже вышел на площадке — переснять или отклонить нельзя';
/** Коды Postgres для невозможной даты (месяц 13, 30 февраля, смещение +99): форма версии верна, значение — нет. */
export const BAD_TIMESTAMP_CODES = ['22007', '22008', '22009'];

/** Статус ролика словами — для отказов админки, без внутренних имён. */
const STATUS_WORDS: Record<ShortStatus, string> = {
  idea: 'идея',
  directing: 'у режиссёра',
  capture_queued: 'ждёт съёмки',
  capturing: 'снимается',
  writing: 'у сценариста',
  animate_queued: 'ждёт оживления',
  animating: 'оживляется',
  render_queued: 'ждёт сборки',
  rendering: 'собирается',
  pending_review: 'ждёт решения',
  approved: 'одобрен',
  publishing: 'публикуется',
  published: 'опубликован',
  rejected: 'отклонён',
  failed: 'упал',
};

/** Что разрешено решению — первая половина отказа «не тот статус». */
const ALLOWED_WORDS = {
  approve: 'Одобрить можно только ролик, который ждёт решения',
  note: 'Замечание можно только к ролику, который ждёт решения',
  leave: 'Переснять или отклонить можно только ролик, который ждёт решения или запланирован',
} as const;
type ReviewKind = keyof typeof ALLOWED_WORDS;

/**
 * Админка роликов: действия в одном POST, как admin/blog; экран — «Блог» →
 * «Ролики» в кабинете (AdminShortsView). На стенде это единственный способ запустить ролик
 * (`start_now`) и выпустить одобренный, не дожидаясь слота (`publish_now`).
 * `refill_topics` — каталог недели сейчас, а не в воскресенье: после того как
 * слотов в неделе стало больше или автозапуск только что включили.
 *
 * Записи статуса — с условием на статус, как везде в модуле: две вкладки
 * админки и кнопки в личке не перетирают решения друг друга.
 */
@Controller('')
export class ShortsController {
  constructor(
    private readonly pg: PgService,
    private readonly settings: ShortsSettingsService,
    private readonly topics: ShortsTopicService,
    private readonly storage: StorageService,
  ) {}

  @Post('admin/shorts')
  @UseGuards(JwtGuard, AdminGuard)
  async action(@Body() body: any, @Res() res: Response) {
    const { action, ...data } = body || {};
    switch (action) {
      case 'list':
        return res.status(200).json(await this.list());
      case 'get':
        return res.status(200).json(await this.getOne(String(data.id ?? '')));
      case 'order': {
        let v: ShortVideo | null;
        try {
          v = await this.topics.addManual({
            topic: data.topic,
            rubric: data.rubric,
            angle: data.angle ?? null,
            assistantId: data.assistantId ?? null,
          });
        } catch (e: any) {
          // 400 — только на ошибку проверки заказа; сбой базы остаётся 500, а не «плохим запросом».
          if (e instanceof ShortOrderError) throw new BadRequestException(e.message);
          throw e;
        }
        return res.status(200).json(v);
      }
      case 'start_now': {
        if (data.id && !UUID.test(String(data.id))) throw new BadRequestException('id ролика — uuid');
        const v = await this.topics.start({ id: data.id || undefined, force: true });
        if (!v) {
          throw new ConflictException(
            data.id
              ? 'Не запустил: ролик уже не идея или запуск идёт параллельно — обновите список и попробуйте ещё раз'
              : 'Не запустил: в очереди нет идей или запуск идёт параллельно — попробуйте ещё раз',
          );
        }
        return res.status(200).json(v);
      }
      case 'refill_topics':
        return res.status(200).json({ added: await this.topics.refillWeek() });
      case 'approve':
        return res.status(200).json(await this.versioned(data.version, () => this.approve(String(data.id ?? ''), data.version)));
      case 'redo':
        return res.status(200).json(await this.versioned(data.version, () => this.leave(String(data.id ?? ''), 'directing', data.version)));
      case 'note':
        return res.status(200).json(await this.versioned(data.version, () => this.note(String(data.id ?? ''), data.text, data.version)));
      case 'publish_now':
        return res.status(200).json(await this.publishNow(String(data.id ?? '')));
      case 'mark_published':
        return res.status(200).json(await this.markPublished(String(data.id ?? ''), String(data.url ?? '')));
      case 'retry':
        return res.status(200).json(await this.retry(String(data.id ?? ''), data.from, data.note));
      case 'reject':
        return res.status(200).json(await this.versioned(data.version, () => this.reject(String(data.id ?? ''), data.version)));
      case 'get_settings':
        return res.status(200).json(await this.settings.get());
      case 'update_settings': {
        // Текущий режим YouTube: клиент, который шлёт настройки целиком, повторяет и его, и
        // неизменённый режим — не попытка включить загрузку. Читаем вне try: сбой базы — 500, а не 400.
        const currentYoutubeMode = (await this.settings.get()).youtubeMode;
        let patch: ShortSettingsPatch;
        try {
          patch = validateSettingsPatch(data.settings, currentYoutubeMode);
        } catch (e: any) {
          throw new BadRequestException(e.message);
        }
        return res.status(200).json(await this.settings.update(patch));
      }
      default:
        throw new BadRequestException(`неизвестное действие: ${action}`);
    }
  }

  private async list() {
    const r = await this.pg.query(`SELECT *, updated_at::text AS version FROM short_video ORDER BY created_at DESC LIMIT 100`);
    const pubs = r.rows.length
      ? await this.pg.query(`SELECT * FROM short_publication WHERE short_id = ANY($1::uuid[])`, [r.rows.map((row: any) => row.id)])
      : { rows: [] };
    const byVideo = new Map<string, ShortPublication[]>();
    for (const p of pubs.rows.map(rowToPublication)) byVideo.set(p.shortId, [...(byVideo.get(p.shortId) ?? []), p]);
    return r.rows.map((row: any) => ({
      ...light(rowToShort(row)),
      version: row.version ?? null,
      publications: byVideo.get(row.id) ?? [],
    }));
  }

  private async getOne(id: string) {
    const { short: v, version } = await this.loadVersioned(id);
    const pubs = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    const bucket = shortsBucket();
    const url = (key: string | null) => (key ? withVersion(this.storage.publicUrl(bucket, key), version) : null);
    return {
      ...v,
      version,
      publications: pubs.rows.map(rowToPublication),
      videoUrl: url(v.videoKey),
      coverUrl: url(v.coverKey),
    };
  }

  /** Одобренный ролик — в публикацию на ближайшем тике (раз в 5 минут), не дожидаясь слота. */
  private async publishNow(id: string): Promise<ShortVideo> {
    await this.load(id);
    let r: any;
    try {
      r = await this.pg.query(
        `UPDATE short_video SET slot_at = now(), updated_at = now() WHERE id = $1 AND status = 'approved' RETURNING *`,
        [id],
      );
    } catch (e: any) {
      if (isShortSlotConflict(e)) throw new ConflictException({ statusCode: 409, error: 'slot_taken', message: 'Этот момент уже занят другим роликом — попробуйте через минуту' });
      throw e;
    }
    if (!r.rows.length) throw new ConflictException('Опубликовать сейчас можно только запланированный ролик — обновите список');
    return rowToShort(r.rows[0]);
  }

  /**
   * Исход отправки в Telegram неизвестен (обрыв, таймаут, 5xx, рестарт
   * посреди отправки — ShortsPublisherService.toTelegram) — ролик и строка
   * telegram уже в `failed`/`failed_from = 'publishing'`, «Повторить» продублирует
   * пост. Если владелец увидел пост в канале сам — отмечаем строку telegram
   * `published` и возвращаем ролик в `approved` со слотом «сейчас», условием
   * на `failed`/`failed_from = 'publishing'`, как у `retry`.
   *
   * Дальше решает публикатор сам: на ближайшем тике `publish()` захватит
   * approved-ролик, у площадки telegram статус уже `published` —
   * `platform()` её не заберёт (захват только pending/failed), telegramDone
   * увидит вышедший пост и продолжит набором YouTube, если он в настройках;
   * когда все площадки отработали — `settle()` ставит `published`.
   *
   * Одна транзакция: строка площадки и статус ролика не разойдутся, если
   * один из двух запросов упадёт.
   */
  private async markPublished(id: string, url: string): Promise<any> {
    const v = await this.load(id);
    const externalId = parseTelegramPostUrl(url);
    if (!externalId) {
      throw new BadRequestException(
        'url — ссылка на пост вида https://t.me/<канал>/<номер> (приватный канал — https://t.me/c/<id>/<номер>)',
      );
    }
    if (v.status !== 'failed' || v.failedFrom !== 'publishing' || !v.approvedAt) {
      throw new ConflictException('Отметить «Пост вышел» можно только у ролика, упавшего на публикации, — обновите список');
    }
    try {
      await inTransaction(this.pg, async (tx) => {
        await tx.query(
          `INSERT INTO short_publication (short_id, platform, status, url, external_id, published_at, last_error, updated_at)
                VALUES ($1, 'telegram', 'published', $2, $3, now(), NULL, now())
              ON CONFLICT (short_id, platform) DO UPDATE
                SET status = 'published', url = $2, external_id = $3,
                    published_at = COALESCE(short_publication.published_at, now()),
                    last_error = NULL, updated_at = now()`,
          [id, url, externalId],
        );
        const r = await tx.query(
          `UPDATE short_video
              SET status = 'approved', failed_from = NULL, last_error = NULL, failure_notified = false,
                  attempts = 0, slot_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'failed' AND failed_from = 'publishing'`,
          [id],
        );
        if (!r.rowCount) throw new ConflictException('Ролик успел уйти из упавших — обновите список');
      });
    } catch (e: any) {
      if (isShortSlotConflict(e)) throw new ConflictException({ statusCode: 409, error: 'slot_taken', message: 'Этот момент уже занят другим роликом — попробуйте через минуту' });
      throw e;
    }
    return this.getOne(id);
  }

  /**
   * «Повторить» упавший ролик. Без `from` — с этапа, на котором он упал
   * (`retryTarget`). `from` — с режиссёра (новая сцена) или со сценариста
   * (новый текст по той же съёмке): детерминированный сбой — сценарист уже
   * дважды просил другую сцену, открыт не тот ассистент, кадр не того
   * размера — повтором с того же этапа не лечится. Упавшую публикацию так не
   * повторить: ролик одобрен, а пост мог выйти — только своим путём
   * (`retryTarget` или `mark_published`).
   *
   * `note` дописывается к замечаниям владельца (`appendOwnerNote`) — их читают
   * режиссёр и сценарист. Заодно оно обнуляет счёт просьб сценариста о новой
   * сцене: тот считает только хвост «Сценарист: …» после последнего замечания
   * владельца (shorts-writer.service.ts).
   *
   * Замечание сбрасывает и отзыв студии о прошлой озвучке: новый круг идёт по
   * замечанию, а сценарист в круге по отзыву студии сценок не меняет.
   *
   * С `from` ролик берёт и формат из настроек: после «модель Omni недоступна»
   * владелец переключает формат на «Только чат» и повторяет с писателя — ролик
   * собирается без сценок. Без `from` формат прежний: этап повторяется как был.
   *
   * Повтор публикации — только у ролика, который владелец одобрял, сразу (слот —
   * «сейчас») и только по упавшим площадкам: вышедшие не трогаются. Запись — с
   * условием на `failed_from`: цель выбрана по прочитанной неудаче, и путь
   * «failed → approved» не должен открыться ролику, упавшему на другом этапе.
   */
  private async retry(id: string, from: unknown, note: unknown): Promise<ShortVideo> {
    if (from != null && !RETRY_FROM.includes(from as RetryFrom)) {
      throw new BadRequestException(`from — ${RETRY_FROM.join(' или ')}`);
    }
    if (note != null && typeof note !== 'string') throw new BadRequestException('note — строка');
    const v = await this.load(id);
    const target = from != null ? this.retryFrom(v, from as RetryFrom) : retryTarget(v);
    if (!target) {
      throw new ConflictException(`Повторять нечего: ролик ${STATUS_WORDS[v.status] ?? v.status} — обновите список`);
    }
    const ownerNote = typeof note === 'string' && note.trim() ? appendOwnerNote(v.ownerNote, note) : null;
    const format = from != null ? (await this.settings.get()).format : null;
    if (target === 'approved') {
      // Счётчик строки не обнуляем: это жетон попытки (platform() публикатора) — обнулённый, он
      // совпал бы с жетоном зависшей прежней попытки. Бюджет попыток — счётчик ролика.
      await this.pg.query(
        `UPDATE short_publication SET status = 'pending', last_error = NULL, updated_at = now()
          WHERE short_id = $1 AND status = 'failed'`,
        [id],
      );
    }
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = $2, attempts = 0, lease_until = NULL, last_error = NULL, failed_from = NULL,
              failure_notified = false, writer_rounds = 0, owner_note = COALESCE($4::text, owner_note),
              format = COALESCE($5::text, format),
              writer_feedback = CASE WHEN $4::text IS NULL THEN writer_feedback ELSE NULL END,
              slot_at = CASE WHEN $2 = 'approved' THEN now() ELSE slot_at END, updated_at = now()
        WHERE id = $1 AND status = 'failed' AND failed_from = $3
        RETURNING *`,
      [id, target, v.failedFrom, ownerNote, format],
    );
    if (!r.rows.length) throw new ConflictException('Ролик успел уйти из упавших — обновите список');
    return rowToShort(r.rows[0]);
  }

  /** Цель повтора, выбранная владельцем. null — повторять нечего (ролик не упал). */
  private retryFrom(v: ShortVideo, from: RetryFrom): ShortStatus | null {
    if (v.status !== 'failed' || !v.failedFrom || !canTransition(v.status, from)) return null;
    if (v.failedFrom === 'publishing') {
      throw new ConflictException(
        'Упавшую публикацию не переснять с этапа: «Повторить» повторит отправку, «Пост вышел» отметит вышедший пост',
      );
    }
    if (from === 'writing' && !v.capture) throw new ConflictException('Нового текста не будет: съёмки нет — нажмите «Новая сцена»');
    return from;
  }

  /** Версия решения: без неё — 400, если она обязательна; кривая — 400, а не 500 от Postgres. */
  private version(raw: unknown, required: boolean): string | null {
    if (raw === undefined || raw === null || raw === '') {
      if (required) throw new BadRequestException(NEED_VERSION);
      return null;
    }
    if (typeof raw !== 'string' || !VERSION_RE.test(raw)) {
      throw new BadRequestException(`version — метка версии из list или get, получено «${String(raw).slice(0, 60)}»`);
    }
    return raw;
  }

  /**
   * Регулярка версии проверяет только форму: «2026-13-45 12:34:56+00» она
   * пропустит, а Postgres ответит 22008. Это ошибка запроса (400), а не сервера.
   */
  private async versioned<T>(rawVersion: unknown, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e: any) {
      const hasVersion = rawVersion !== undefined && rawVersion !== null && rawVersion !== '';
      if (hasVersion && BAD_TIMESTAMP_CODES.includes(e?.code)) {
        throw new BadRequestException('version — метка версии из list или get');
      }
      throw e;
    }
  }

  /** Отказ общего модуля решений — 409 со словами для человека (404 — строки нет). */
  private refused(kind: ReviewKind, out: { reason: ReviewRefusal; status: ShortStatus | null }): never {
    if (out.reason === 'not_found') throw new NotFoundException('ролик не найден');
    if (out.reason === 'stale') {
      throw new ConflictException({ statusCode: 409, error: 'version_conflict', message: STALE_SHORT });
    }
    if (out.reason === 'released') {
      // Одобрение и замечание «вышел» в записи не проверяют, но сюда приводит устаревшая
      // карточка: ролик тем временем одобрили в личке и опубликовали.
      throw new ConflictException(kind === 'leave' ? RELEASED_TEXT : 'Ролик уже вышел на площадке — решение по нему не принять');
    }
    const now = out.status ? STATUS_WORDS[out.status] : 'в неизвестном статусе';
    throw new ConflictException(`${ALLOWED_WORDS[kind]}; этот — ${now}. Обновите список.`);
  }

  /**
   * «Одобрить» из админки — та же запись, что у кнопки в личке
   * (approveShortIntoSlot), с версией: файл пересобранного ролика лежит по
   * тому же адресу, и одобрить можно только ту версию, что владелец видел.
   */
  private async approve(id: string, rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    const v = await this.load(id);
    let approved: unknown;
    try {
      approved = await approveShortIntoSlot(this.pg, v.id, v.slotAt, await this.settings.get(), undefined, version);
    } catch (e: any) {
      if (e instanceof NoFreeSlotError) throw new ConflictException(`Не одобрил: ${e.message}`);
      throw e;
    }
    if (!approved) return this.refused('approve', await explainRefusal(this.pg, v.id, ['pending_review']));
    return this.load(v.id);
  }

  /** «Переснять» и «Отклонить» ждущего решения или запланированного — общей записью, с версией. */
  private async leave(id: string, target: 'directing' | 'rejected', rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const out = await leaveReview(this.pg, id, target, version);
    if (out.ok === false) return this.refused('leave', out);
    return out.short;
  }

  /** Замечание к ролику, который ждёт решения: дописывается к прежним, ролик — к сценаристу. */
  private async note(id: string, rawText: unknown, rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, true);
    // Тело запроса — до 50 МБ: срезаем до разбора на символы; appendOwnerNote всё равно оставит MAX_OWNER_NOTE_CHARS.
    const text = typeof rawText === 'string' ? rawText.slice(0, MAX_OWNER_NOTE_CHARS * 2).trim() : '';
    if (!text) throw new BadRequestException('text — замечание строкой');
    const v = await this.load(id);
    const out = await noteForReview(this.pg, v, text, version);
    if (out.ok === false) return this.refused('note', out);
    return out.short;
  }

  /**
   * «Отклонить». Ждущий решения и запланированный — общей записью, как кнопка
   * в личке, с обязательной версией. Упавший — как раньше: нельзя, если он уже
   * вышел хоть на одной площадке (пост в канале, набор YouTube у владельца),
   * иначе rejected оказался бы ролик с живым постом; версия здесь
   * необязательна, а если пришла — проверяется. Условие — в самом UPDATE, а не
   * чтением перед ним.
   */
  private async reject(id: string, rawVersion: unknown): Promise<ShortVideo> {
    const v = await this.load(id);
    if (LEAVE_FROM.includes(v.status)) return this.leave(id, 'rejected', rawVersion);
    const version = this.version(rawVersion, false);
    if (v.status !== 'failed' || !canTransition(v.status, 'rejected')) {
      throw new ConflictException(
        `Отклонить можно упавший, ждущий решения или запланированный ролик; этот — ${STATUS_WORDS[v.status] ?? v.status}. Обновите список.`,
      );
    }
    const params: any[] = [id];
    const clause = versionClause(params, version);
    const r = await this.pg.query(
      `UPDATE short_video SET status = 'rejected', approved_at = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed'
          AND NOT ${RELEASED_SQL}${clause}
        RETURNING *`,
      params,
    );
    if (r.rows.length) return rowToShort(r.rows[0]);
    // Почему не записалось — тем же чтением, что у решений по готовому ролику.
    const why = await explainRefusal(this.pg, id, ['failed']);
    if (why.reason === 'released') {
      throw new ConflictException('Ролик уже вышел на площадке — отклонить нельзя; оставшиеся площадки повторит «Повторить»');
    }
    if (why.reason === 'not_found') throw new NotFoundException('ролик не найден');
    // «stale» без версии — гонка (ролик ушёл из failed и вернулся), а не устаревшая карточка.
    if (why.reason === 'stale' && version) {
      throw new ConflictException({ statusCode: 409, error: 'version_conflict', message: STALE_SHORT });
    }
    throw new ConflictException('Ролик успел уйти из упавших — обновите список');
  }

  /** Ролик и его версия (`updated_at::text`) — для get: ею админка подписывает решения. */
  private async loadVersioned(id: string): Promise<{ short: ShortVideo; version: string | null }> {
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const r = await this.pg.query(`SELECT *, updated_at::text AS version FROM short_video WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException('ролик не найден');
    return { short: rowToShort(r.rows[0]), version: r.rows[0].version ?? null };
  }

  private async load(id: string): Promise<ShortVideo> {
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const r = await this.pg.query(`SELECT * FROM short_video WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException('ролик не найден');
    return rowToShort(r.rows[0]);
  }
}
