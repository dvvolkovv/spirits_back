import { Injectable } from '@nestjs/common';
import { StorageService } from '../../common/services/storage.service';
import {
  THUMB_BUCKET,
  THUMB_CONCURRENCY,
  THUMB_MAX_SOURCE_BYTES,
  THUMB_QUEUE_WAIT_MS,
  THUMB_WORK_TIMEOUT_MS,
  ThumbSource,
  renderThumb,
  thumbKeyFor,
} from './thumbnails';

/** Сколько ключей «миниатюра уже есть» помнить; дальше память начинается заново. */
const KNOWN_LIMIT = 5000;

/** Места под уменьшение: в очереди не дольше waitMs, потом отказ. */
class Slots {
  private busy = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  acquire(waitMs: number): Promise<() => void> {
    if (this.busy < this.limit) {
      this.busy++;
      return Promise.resolve(this.releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        clearTimeout(timer);
        resolve(this.releaser());
      };
      const timer = setTimeout(() => {
        const i = this.waiting.indexOf(grant);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new Error(`очередь на миниатюру дольше ${waitMs} мс`));
      }, waitMs);
      this.waiting.push(grant);
    });
  }

  private releaser(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      // Место переходит следующему как есть: busy не меняется.
      const next = this.waiting.shift();
      if (next) next();
      else this.busy--;
    };
  }
}

/**
 * Миниатюры по запросу: первая — уменьшение и загрузка в бакет, дальше —
 * готовый адрес. Бросает при любой неудаче; ручка тогда отдаёт оригинал.
 */
@Injectable()
export class ThumbnailService {
  private readonly slots = new Slots(THUMB_CONCURRENCY);
  private readonly known = new Set<string>();
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly storage: StorageService) {}

  async resolve(
    src: ThumbSource,
    waitMs: number = THUMB_QUEUE_WAIT_MS,
    workMs: number = THUMB_WORK_TIMEOUT_MS,
  ): Promise<string> {
    const key = thumbKeyFor(src);
    const url = this.storage.publicUrl(THUMB_BUCKET, key);
    if (this.known.has(key)) return url;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const work = this.make(src, key, url, waitMs, workMs).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, work);
    return work;
  }

  private async make(src: ThumbSource, key: string, url: string, waitMs: number, workMs: number): Promise<string> {
    if (await this.storage.head(THUMB_BUCKET, key)) {
      this.remember(key);
      return url;
    }
    const release = await this.slots.acquire(waitMs);
    // Место держим не дольше workMs: renderThumb оборвать нельзя, поэтому
    // гоним работу на обгон с таймером и освобождаем слот по таймеру, а не
    // по завершению работы — иначе зависший MinIO или sharp держат оба
    // места до перезапуска.
    let timer!: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`миниатюра не уложилась в ${workMs} мс`)), workMs);
    });
    try {
      return await Promise.race([this.render(src, key, url, workMs), timeout]);
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  private async render(src: ThumbSource, key: string, url: string, workMs: number): Promise<string> {
    const signal = AbortSignal.timeout(workMs);
    const meta = await this.storage.head(src.bucket, src.key, signal);
    if (!meta) throw new Error('исходника нет');
    if (meta.size > THUMB_MAX_SOURCE_BYTES) throw new Error(`исходник больше ${THUMB_MAX_SOURCE_BYTES} байт`);
    const body = await this.storage.download({ bucket: src.bucket, key: src.key, abortSignal: signal });
    const thumb = await renderThumb(body);
    await this.storage.upload({
      bucket: THUMB_BUCKET,
      key,
      body: thumb,
      contentType: 'image/webp',
      cacheControl: 'public, max-age=31536000, immutable',
      abortSignal: signal,
    });
    this.remember(key);
    return url;
  }

  private remember(key: string): void {
    if (this.known.size >= KNOWN_LIMIT) this.known.clear();
    this.known.add(key);
  }
}
