import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ChatFileKind, ExtractEnv, ExtractedFile, extractChatFiles } from './extract';

/**
 * Что отдаёт эндпоинт панели (GET /webhook/chat/files). У stored=false адреса
 * нет: файл пропал вместе с /tmp релея, и скачивать его панель не предлагает.
 */
export interface ChatFileItem {
  key: string;
  kind: ChatFileKind;
  url?: string;
  thumbUrl?: string;
  name: string;
  ext: string;
  createdAt: string;
  messageId: number;
  stored: boolean;
}

/** Файл из истории до подстановки адресов видео и озвучки. */
export interface FoundFile {
  file: ExtractedFile;
  createdAt: string;
  messageId: number;
  /** Текст ответа целиком — по нему ищет инструмент find_files. */
  text: string;
}

/**
 * Сколько ответов читаем на одно открытие панели. С запасом: самая длинная
 * переписка на проде — 7534 строки всего, из них с вложениями — доли.
 */
export const PANEL_ROWS_LIMIT = 2000;

export const SESSION_FILES_SQL = `SELECT id, content, created_at FROM custom_chat_history
 WHERE session_id = $1 AND sender_type = 'ai'
   AND content ~ '(https?://|\\[VIDEO_JOB:|\\{\\{audio:id=)'
 ORDER BY created_at DESC
 LIMIT ${PANEL_ROWS_LIMIT}`;

export function extractEnv(): ExtractEnv {
  const trim = (s: string) => s.replace(/\/$/, '');
  return {
    publicBaseUrl: trim(process.env.MINIO_PUBLIC_URL || ''),
    agentUrl: trim(process.env.AGENT_URL || 'https://r.linkeon.io'),
    backendUrl: trim(process.env.BACKEND_URL || 'https://my.linkeon.io'),
  };
}

/** Разбор строк, идущих от новых к старым. Повтор адреса — остаётся самое свежее упоминание. */
export function collectFiles(rows: any[], env: ExtractEnv): FoundFile[] {
  const seen = new Set<string>();
  const out: FoundFile[] = [];
  for (const r of rows) {
    const text = String(r.content ?? '');
    const createdAt = new Date(r.created_at).toISOString();
    for (const file of extractChatFiles(text, env)) {
      const key = file.url ?? `${file.source}:${file.refId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file, createdAt, messageId: Number(r.id), text });
    }
  }
  return out;
}

@Injectable()
export class ChatFilesService {
  constructor(private readonly pg: PgService) {}

  /** Файлы одной переписки, от новых к старым. */
  async listForSession(userId: string, sessionId: string): Promise<ChatFileItem[]> {
    const { rows } = await this.pg.query(SESSION_FILES_SQL, [sessionId]);
    const items = await this.resolve(userId, collectFiles(rows, extractEnv()));
    return items.map(({ item }) => item);
  }

  /**
   * Подставляет адреса видео и озвучки по маркерам. Только свои (user_id):
   * маркер в тексте могла выдумать модель. Неготовые и не найденные видео выпадают.
   */
  async resolve(userId: string, found: FoundFile[]): Promise<{ item: ChatFileItem; found: FoundFile }[]> {
    const ids = (source: ExtractedFile['source']) =>
      found.filter((f) => f.file.source === source).map((f) => f.file.refId as string);
    const videoIds = ids('video_job');
    const audioIds = ids('audio_clip');

    const videos = new Map<string, { url: string; thumb?: string }>();
    if (videoIds.length > 0) {
      const { rows } = await this.pg.query(
        `SELECT id, status, video_url, thumbnail_url FROM video_jobs WHERE id = ANY($1::uuid[]) AND user_id = $2`,
        [videoIds, userId],
      );
      for (const r of rows) {
        if (r.status === 'ready' && r.video_url) {
          videos.set(String(r.id), { url: r.video_url, thumb: r.thumbnail_url || undefined });
        }
      }
    }
    const clips = new Map<string, string>();
    if (audioIds.length > 0) {
      const { rows } = await this.pg.query(
        `SELECT id, url FROM speech_clips WHERE id = ANY($1::uuid[]) AND user_id = $2`,
        [audioIds, userId],
      );
      for (const r of rows) if (r.url) clips.set(String(r.id), r.url);
    }

    const out: { item: ChatFileItem; found: FoundFile }[] = [];
    for (const f of found) {
      const base = { kind: f.file.kind, name: f.file.name, ext: f.file.ext, createdAt: f.createdAt, messageId: f.messageId };
      if (f.file.source === 'video_job') {
        const v = videos.get(f.file.refId as string);
        if (v) out.push({ found: f, item: { ...base, key: `video_job:${f.file.refId}`, url: v.url, thumbUrl: v.thumb, stored: true } });
      } else if (f.file.source === 'audio_clip') {
        const url = clips.get(f.file.refId as string);
        if (url) out.push({ found: f, item: { ...base, key: `audio_clip:${f.file.refId}`, url, stored: true } });
      } else {
        out.push({
          found: f,
          item: { ...base, key: f.file.url as string, url: f.file.stored ? f.file.url : undefined, stored: f.file.stored },
        });
      }
    }
    return out;
  }
}
