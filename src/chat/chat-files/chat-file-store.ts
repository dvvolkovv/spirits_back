// src/chat/chat-files/chat-file-store.ts
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { StorageService } from '../../common/services/storage.service';
import {
  contentDispositionFor,
  contentTypeFor,
  encodeStrict,
  lastPathSegment,
  relayRequestUrl,
  safeFileName,
} from './file-meta';

/** Не больше стольких скачиваний с релея одновременно. */
export const PERSIST_CONCURRENCY = 3;
/** Таймаут на один файл. */
export const PERSIST_FILE_TIMEOUT_MS = 30_000;
/** Больше — не копируем, ссылка остаётся на релей. Тот же потолок, что у загрузок (chat.controller.ts). */
export const PERSIST_MAX_FILE_BYTES = 100 * 1024 * 1024;
/** Бюджет на все файлы одного хода: после него новые скачивания не начинаются. */
export const PERSIST_TURN_BUDGET_MS = 60_000;

export function chatFilesBucket(): string {
  return process.env.MINIO_BUCKET_CHAT_FILES || 'linkeon-chat-files';
}

/**
 * Копирует файлы, которые ассистент создал на релее, в наш MinIO.
 *
 * Зачем. Релей держит их в /tmp/agent-output, а /tmp там чистится при
 * перезагрузке и через 30 дней без обращений. 16.09.2026 релей перезагрузился,
 * и к 08.10 89% ссылок «Скачать» в истории вели в пустоту.
 *
 * Ключ — `<uuid>/<имя>`: угадать нельзя, телефона в адресе нет. Анонимно
 * бакет отдаёт только s3:GetObject, перечня ключей нет.
 *
 * Не бросает. Файл, который не удалось скопировать (404, таймаут, больше
 * PERSIST_MAX_FILE_BYTES, сбой MinIO), просто не попадает в карту, и
 * вызывающий оставит ссылку на релей — ровно как было до этой фичи.
 */
@Injectable()
export class ChatFileStore {
  private readonly logger = new Logger(ChatFileStore.name);

  constructor(private readonly storage: StorageService) {}

  /** Адрес релея → наш адрес. Повторы склеиваются. */
  async persist(relayUrls: string[], opts: { budgetMs?: number } = {}): Promise<Map<string, string>> {
    const unique = [...new Set(relayUrls.filter(Boolean))];
    const out = new Map<string, string>();
    const deadline = Date.now() + (opts.budgetMs ?? PERSIST_TURN_BUDGET_MS);
    let next = 0;
    const worker = async () => {
      while (next < unique.length) {
        if (Date.now() >= deadline) return;
        const url = unique[next++];
        try {
          out.set(url, await this.persistOne(url));
        } catch (e: any) {
          this.logger.warn(`chat-files: не скопирован ${url}: ${e?.message || e}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PERSIST_CONCURRENCY, unique.length) }, () => worker()));
    return out;
  }

  /** Один файл: скачать с релея и положить в бакет. Бросает при любой неудаче. */
  async persistOne(relayUrl: string): Promise<string> {
    const name = safeFileName(lastPathSegment(relayUrl));
    const res = await axios.get(relayRequestUrl(relayUrl), {
      responseType: 'arraybuffer',
      timeout: PERSIST_FILE_TIMEOUT_MS,
      maxContentLength: PERSIST_MAX_FILE_BYTES,
      maxBodyLength: PERSIST_MAX_FILE_BYTES,
      validateStatus: (s: number) => s === 200,
    });
    const bucket = chatFilesBucket();
    const id = randomUUID();
    await this.storage.upload({
      bucket,
      key: `${id}/${name}`,
      body: Buffer.from(res.data),
      contentType: contentTypeFor(name),
      contentDisposition: contentDispositionFor(name),
      cacheControl: 'public, max-age=31536000, immutable',
    });
    // Ключ в MinIO — сырое имя в UTF-8, а в адресе имя закодировано: пробел или
    // скобка в имени иначе сломали бы markdown-ссылку `[Скачать …](…)`.
    // encodeURIComponent скобки не кодирует — поэтому encodeStrict.
    return this.storage.publicUrl(bucket, `${id}/${encodeStrict(name)}`);
  }
}
