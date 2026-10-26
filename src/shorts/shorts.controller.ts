import { BadRequestException, Body, ConflictException, Controller, NotFoundException, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { inTransaction } from '../blog/blog-slot-claim';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { PgService } from '../common/services/pg.service';
import { StorageService } from '../common/services/storage.service';
import { isShortSlotConflict } from './short-slot-claim';
import { RELEASED_SQL } from './shorts-approval.service';
import { ShortSettingsPatch, ShortsSettingsService, validateSettingsPatch } from './shorts-settings.service';
import { ShortOrderError, ShortsTopicService } from './shorts-topic.service';
import {
  ShortPublication, ShortStatus, ShortVideo, appendOwnerNote, canTransition, retryTarget, rowToPublication, rowToShort, shortsBucket,
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

/**
 * Админка роликов: действия в одном POST, как admin/blog. Вкладка кабинета
 * появится в плане 3. На стенде это единственный способ запустить ролик
 * (`start_now`) и выпустить одобренный, не дожидаясь слота (`publish_now`).
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
              ? 'не запустил: ролик не в статусе idea или запуск идёт параллельно — попробуйте ещё раз'
              : 'не запустил: в очереди нет идей или запуск идёт параллельно — попробуйте ещё раз',
          );
        }
        return res.status(200).json(v);
      }
      case 'publish_now':
        return res.status(200).json(await this.publishNow(String(data.id ?? '')));
      case 'mark_published':
        return res.status(200).json(await this.markPublished(String(data.id ?? ''), String(data.url ?? '')));
      case 'retry':
        return res.status(200).json(await this.retry(String(data.id ?? ''), data.from, data.note));
      case 'reject':
        return res.status(200).json(await this.reject(String(data.id ?? '')));
      case 'get_settings':
        return res.status(200).json(await this.settings.get());
      case 'update_settings': {
        let patch: ShortSettingsPatch;
        try {
          patch = validateSettingsPatch(data.settings);
        } catch (e: any) {
          throw new BadRequestException(e.message);
        }
        return res.status(200).json(await this.settings.update(patch));
      }
      default:
        throw new BadRequestException(`неизвестное действие: ${action}`);
    }
  }

  private async list(): Promise<Array<ShortVideo & { publications: ShortPublication[] }>> {
    const r = await this.pg.query(`SELECT * FROM short_video ORDER BY created_at DESC LIMIT 100`);
    const videos = r.rows.map(rowToShort);
    const pubs = videos.length
      ? await this.pg.query(`SELECT * FROM short_publication WHERE short_id = ANY($1::uuid[])`, [videos.map((v) => v.id)])
      : { rows: [] };
    const byVideo = new Map<string, ShortPublication[]>();
    for (const p of pubs.rows.map(rowToPublication)) byVideo.set(p.shortId, [...(byVideo.get(p.shortId) ?? []), p]);
    return videos.map((v) => ({ ...v, publications: byVideo.get(v.id) ?? [] }));
  }

  private async getOne(id: string) {
    const v = await this.load(id);
    const pubs = await this.pg.query(`SELECT * FROM short_publication WHERE short_id = $1`, [id]);
    const bucket = shortsBucket();
    return {
      ...v,
      publications: pubs.rows.map(rowToPublication),
      videoUrl: v.videoKey ? this.storage.publicUrl(bucket, v.videoKey) : null,
      coverUrl: v.coverKey ? this.storage.publicUrl(bucket, v.coverKey) : null,
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
      if (isShortSlotConflict(e)) throw new ConflictException('slot_taken');
      throw e;
    }
    if (!r.rows.length) throw new ConflictException('опубликовать сейчас можно только одобренный ролик');
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
      throw new ConflictException('пометить вышедшим можно только ролик, упавший на публикации');
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
        if (!r.rowCount) throw new ConflictException('ролик успел уйти из failed — обновите список');
      });
    } catch (e: any) {
      if (isShortSlotConflict(e)) throw new ConflictException('slot_taken');
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
      throw new ConflictException(`повторять нечего: ролик в статусе ${v.status}${v.failedFrom ? `, упал на этапе ${v.failedFrom}` : ''}`);
    }
    const ownerNote = typeof note === 'string' && note.trim() ? appendOwnerNote(v.ownerNote, note) : null;
    const format = from != null ? (await this.settings.get()).format : null;
    if (target === 'approved') {
      await this.pg.query(
        `UPDATE short_publication SET status = 'pending', attempts = 0, last_error = NULL, updated_at = now()
          WHERE short_id = $1 AND status = 'failed'`,
        [id],
      );
    }
    const r = await this.pg.query(
      `UPDATE short_video
          SET status = $2, attempts = 0, lease_until = NULL, last_error = NULL, failed_from = NULL,
              failure_notified = false, writer_rounds = 0, owner_note = COALESCE($4::text, owner_note),
              format = COALESCE($5::text, format),
              slot_at = CASE WHEN $2 = 'approved' THEN now() ELSE slot_at END, updated_at = now()
        WHERE id = $1 AND status = 'failed' AND failed_from = $3
        RETURNING *`,
      [id, target, v.failedFrom, ownerNote, format],
    );
    if (!r.rows.length) throw new ConflictException('ролик успел уйти из failed — обновите список');
    return rowToShort(r.rows[0]);
  }

  /** Цель повтора, выбранная владельцем. null — повторять нечего (ролик не упал). */
  private retryFrom(v: ShortVideo, from: RetryFrom): ShortStatus | null {
    if (v.status !== 'failed' || !v.failedFrom || !canTransition(v.status, from)) return null;
    if (v.failedFrom === 'publishing') {
      throw new ConflictException(
        'упавшую публикацию с этапа не переснять: retry без from повторит отправку, mark_published отметит вышедший пост',
      );
    }
    if (from === 'writing' && !v.capture) throw new ConflictException('нечего писать — нет съёмки');
    return from;
  }

  /**
   * «Отклонить» упавший ролик: повтор не поможет или ролик больше не нужен.
   * Нельзя, если он уже вышел хоть на одной площадке (пост в канале, набор
   * YouTube у владельца) — как у «Отклонить» в личке, иначе rejected оказался бы
   * ролик с живым постом. Условие — в самом UPDATE, а не чтением перед ним.
   */
  private async reject(id: string): Promise<ShortVideo> {
    const v = await this.load(id);
    if (v.status !== 'failed' || !canTransition(v.status, 'rejected')) {
      throw new ConflictException(`отклонить здесь можно только упавший ролик, а он в статусе ${v.status}`);
    }
    const r = await this.pg.query(
      `UPDATE short_video SET status = 'rejected', approved_at = NULL, lease_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'failed'
          AND NOT ${RELEASED_SQL}
        RETURNING *`,
      [id],
    );
    if (r.rows.length) return rowToShort(r.rows[0]);
    // Отличаем «уже вышел» от «уже не failed» чтением после неудачной записи.
    const after = await this.pg.query(`SELECT status, ${RELEASED_SQL} AS released FROM short_video WHERE id = $1`, [id]);
    if (after.rows[0]?.released) {
      throw new ConflictException('ролик уже вышел на площадке — отклонить нельзя; оставшиеся площадки повторит retry');
    }
    throw new ConflictException('ролик успел уйти из failed — обновите список');
  }

  private async load(id: string): Promise<ShortVideo> {
    if (!UUID.test(id)) throw new BadRequestException('id ролика — uuid');
    const r = await this.pg.query(`SELECT * FROM short_video WHERE id = $1`, [id]);
    if (!r.rows.length) throw new NotFoundException('ролик не найден');
    return rowToShort(r.rows[0]);
  }
}
