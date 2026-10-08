import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ChatFileKind, ExtractEnv, ExtractedFile, extractChatFiles } from './extract';
import { FindFilesInput, assistantPart, normalizeForSearch, plainNote, queryWords, scoreFile } from './find-files';

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
  /** session_id строки истории — по нему поиск узнаёт ассистента. */
  sessionId?: string;
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

/** Сколько ответов читает один поиск по всем перепискам пользователя. */
export const SEARCH_ROWS_LIMIT = 5000;

/**
 * Все переписки пользователя, включая «Чистый лист». `_` в LIKE экранирован:
 * без этого `7903016918_%` захватил бы и переписку номера 79030169187.
 */
export const USER_FILES_SQL = `SELECT id, session_id, content, created_at FROM custom_chat_history
 WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\' AND sender_type = 'ai'
   AND content ~ '(https?://|\\[VIDEO_JOB:|\\{\\{audio:id=)'
   AND ($2::int IS NULL OR created_at >= now() - make_interval(days => $2::int))
 ORDER BY created_at DESC
 LIMIT ${SEARCH_ROWS_LIMIT}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Что отдаёт find_files модели. Адреса у stored=false нет. */
export interface FoundForTool {
  name: string;
  kind: ChatFileKind;
  date: string;
  assistant: string;
  url?: string;
  stored: boolean;
  note: string;
}

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
      out.push({
        file,
        createdAt,
        messageId: Number(r.id),
        text,
        ...(r.session_id ? { sessionId: String(r.session_id) } : {}),
      });
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

  /**
   * Имена ассистентов по частям session_id. Для сравнения с запросом модели
   * берутся все имена: служебное, отображаемое и переводы. Кастомные — только свои.
   */
  async assistantNames(userId: string, parts: string[]): Promise<Map<string, { display: string; aliases: string[] }>> {
    const out = new Map<string, { display: string; aliases: string[] }>();
    const ids = [...new Set(parts.filter((p) => /^\d+$/.test(p)).map(Number))];
    const customs = [...new Set(parts.filter((p) => p.startsWith('custom:') && UUID_RE.test(p.slice(7))).map((p) => p.slice(7)))];
    if (ids.length > 0) {
      const { rows } = await this.pg.query(
        `SELECT a.id, COALESCE(a.display_name, a.name) AS display, a.name,
                ARRAY(SELECT t.display_name FROM agent_translations t
                       WHERE t.entity_type = 'agent' AND t.entity_id = a.id::text AND t.display_name IS NOT NULL) AS aliases
           FROM agents a WHERE a.id = ANY($1::int[])`,
        [ids],
      );
      for (const r of rows) {
        out.set(String(r.id), { display: String(r.display), aliases: [r.name, ...(r.aliases || [])].filter(Boolean).map(String) });
      }
    }
    if (customs.length > 0) {
      const { rows } = await this.pg.query(
        `SELECT id, name FROM custom_agents WHERE id = ANY($1::uuid[]) AND owner_user_id = $2`,
        [customs, userId],
      );
      for (const r of rows) out.set(`custom:${r.id}`, { display: String(r.name), aliases: [] });
    }
    return out;
  }

  /**
   * Инструмент find_files: файлы всех переписок пользователя с ассистентами.
   * Сначала фильтры (вид, ассистент), потом очки по словам запроса; при равных
   * очках — свежие выше (сортировка устойчива, строки уже от новых к старым).
   */
  async searchForUser(
    userId: string,
    input: FindFilesInput,
  ): Promise<{ ok: true; total: number; files: FoundForTool[] }> {
    const { rows } = await this.pg.query(USER_FILES_SQL, [userId, input.days]);
    const found = collectFiles(rows, extractEnv());
    const partOf = (f: FoundFile) => assistantPart(f.sessionId ?? '', userId);
    const names = await this.assistantNames(userId, found.map(partOf));

    const want = normalizeForSearch(input.assistant);
    const words = queryWords(input.query);
    const candidates = found
      .filter((f) => input.kind === 'any' || f.file.kind === input.kind)
      .filter((f) => {
        if (!want) return true;
        const n = names.get(partOf(f));
        return !!n && [n.display, ...n.aliases].some((a) => normalizeForSearch(a).includes(want));
      })
      .map((f) => ({ f, score: words.length > 0 ? scoreFile(words, f.file.name, f.text) : 0 }))
      .filter((x) => words.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.f);

    const resolved = await this.resolve(userId, candidates);
    return {
      ok: true,
      total: resolved.length,
      files: resolved.slice(0, input.limit).map(({ item, found: f }) => ({
        name: item.name,
        kind: item.kind,
        date: item.createdAt.slice(0, 10),
        assistant: names.get(partOf(f))?.display ?? '',
        ...(item.url ? { url: item.url } : {}),
        stored: item.stored,
        note: plainNote(f.text),
      })),
    };
  }
}
