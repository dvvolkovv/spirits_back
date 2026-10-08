// src/chat/chat-files/chat-file-store.ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { safeGet } from '../../common/net/safe-fetch';
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
/**
 * Срок на один файл: на скачивание целиком (DNS, заголовки, тело) и
 * отдельно — на загрузку в бакет.
 */
export const PERSIST_FILE_TIMEOUT_MS = 30_000;
/** Больше — не копируем, ссылка остаётся на релей. Тот же потолок, что у загрузок (chat.controller.ts). */
export const PERSIST_MAX_FILE_BYTES = 100 * 1024 * 1024;
/**
 * Бюджет на все файлы одного хода. Жёсткий: после него новые скачивания не
 * начинаются, загрузка в бакет обрывается, а persist возвращает то, что успел.
 */
export const PERSIST_TURN_BUDGET_MS = 60_000;

export interface PersistOptions {
  /** Бюджет хода, мс. По умолчанию PERSIST_TURN_BUDGET_MS. */
  budgetMs?: number;
  /** Срок на файл, мс. По умолчанию PERSIST_FILE_TIMEOUT_MS. */
  fileTimeoutMs?: number;
}

export interface PersistOneOptions {
  /** Срок на файл, мс. По умолчанию PERSIST_FILE_TIMEOUT_MS. */
  fileTimeoutMs?: number;
  /** Конец бюджета хода (по Date.now()): скачивание не дольше остатка, после него в бакет не кладём. */
  deadline?: number;
  /** Сигнал конца бюджета хода: обрывает загрузку в бакет. */
  signal?: AbortSignal;
}

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
 * PERSIST_MAX_FILE_BYTES, сбой MinIO, не успел до конца бюджета хода), просто
 * не попадает в карту, и вызывающий оставит ссылку на релей — ровно как было
 * до этой фичи.
 */
@Injectable()
export class ChatFileStore {
  private readonly logger = new Logger(ChatFileStore.name);

  constructor(private readonly storage: StorageService) {}

  /**
   * Адрес релея → наш адрес. Повторы склеиваются. Возвращается не позже
   * budgetMs, что бы ни повисло: ход ждёт эти ссылки, прежде чем отдать
   * клиенту конец ответа.
   */
  async persist(relayUrls: string[], opts: PersistOptions = {}): Promise<Map<string, string>> {
    const unique = [...new Set(relayUrls.filter(Boolean))];
    const out = new Map<string, string>();
    if (unique.length === 0) return out;
    const budgetMs = opts.budgetMs ?? PERSIST_TURN_BUDGET_MS;
    const fileTimeoutMs = opts.fileTimeoutMs ?? PERSIST_FILE_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    const turn = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // Внешняя граница: даже скачивание, повисшее вопреки своему сроку, не
    // задержит конец хода. Брошенное обещание дорабатывает вхолостую: после
    // бюджета в бакет не кладём и в карту не пишем.
    const budgetOver = new Promise<void>((resolve) => {
      if (!Number.isFinite(budgetMs)) return;
      timer = setTimeout(() => {
        turn.abort(new Error(`бюджет хода ${budgetMs} мс исчерпан`));
        resolve();
      }, Math.max(0, budgetMs));
    });
    let next = 0;
    const worker = async () => {
      while (next < unique.length && !turn.signal.aborted && Date.now() < deadline) {
        const url = unique[next++];
        try {
          const stored = await this.persistOne(url, { fileTimeoutMs, deadline, signal: turn.signal });
          if (!turn.signal.aborted) out.set(url, stored);
        } catch (e: any) {
          this.logger.warn(`chat-files: не скопирован ${url}: ${e?.message || e}`);
        }
      }
    };
    try {
      await Promise.race([
        Promise.all(Array.from({ length: Math.min(PERSIST_CONCURRENCY, unique.length) }, () => worker())),
        budgetOver,
      ]);
    } finally {
      clearTimeout(timer);
    }
    return out;
  }

  /** Один файл: скачать с релея и положить в бакет. Бросает при любой неудаче. */
  async persistOne(relayUrl: string, opts: PersistOneOptions = {}): Promise<string> {
    const fileTimeoutMs = opts.fileTimeoutMs ?? PERSIST_FILE_TIMEOUT_MS;
    const deadline = opts.deadline ?? Infinity;
    const name = safeFileName(lastPathSegment(relayUrl));
    // Срок у safeGet общий — на всё скачивание вместе с телом. axios.timeout в
    // Node считает простой, и медленно капающий ответ не обрывался никогда.
    const timeoutMs = Math.min(fileTimeoutMs, deadline - Date.now());
    if (!(timeoutMs > 0)) throw new Error('бюджет хода исчерпан');
    const res = await safeGet(relayRequestUrl(relayUrl), {
      responseType: 'arraybuffer',
      timeoutMs,
      maxBytes: PERSIST_MAX_FILE_BYTES,
      maxRedirects: 0,
      validateStatus: (s: number) => s === 200,
    });
    if (opts.signal?.aborted || Date.now() >= deadline) {
      throw new Error('бюджет хода исчерпан — в бакет не кладём');
    }
    const bucket = chatFilesBucket();
    const id = randomUUID();
    const fileSignal = AbortSignal.timeout(fileTimeoutMs);
    await this.storage.upload({
      bucket,
      key: `${id}/${name}`,
      body: res.data,
      contentType: contentTypeFor(name),
      contentDisposition: contentDispositionFor(name),
      cacheControl: 'public, max-age=31536000, immutable',
      abortSignal: opts.signal ? AbortSignal.any([opts.signal, fileSignal]) : fileSignal,
    });
    // Ключ в MinIO — сырое имя в UTF-8, а в адресе имя закодировано: пробел или
    // скобка в имени иначе сломали бы markdown-ссылку `[Скачать …](…)`.
    // encodeURIComponent скобки не кодирует — поэтому encodeStrict.
    return this.storage.publicUrl(bucket, `${id}/${encodeStrict(name)}`);
  }
}
