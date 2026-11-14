import { Injectable } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { ChatUploadsService, ChatUploadRecord } from '../chat-uploads/chat-uploads.service';
import { ChatFileKind, ExtractEnv, ExtractedFile, extractChatFiles } from './extract';
import {
  FindFilesInput, assistantPart, extractHumanLinks, kindByMime,
  normalizeForSearch, plainNote, queryWords, scoreFile,
} from './find-files';
import { safeFileName } from './file-meta';
import { thumbPathFor } from './thumbnails';

/**
 * Что отдаёт эндпоинт панели (GET /webhook/chat/files). У stored=false адреса
 * нет: файл пропал вместе с /tmp релея, и скачивать его панель не предлагает.
 */
export interface ChatFileItem {
  key: string;
  kind: ChatFileKind;
  url?: string;
  thumbUrl?: string;
  /** Только у картинок из наших бакетов: путь ручки миниатюры (thumbnails.ts), фронт достраивает его от своего бэкенда. */
  thumbPath?: string;
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
 * Защитный потолок разбора человеческого сообщения со ссылками: контент
 * режется до extractHumanLinks. Сообщение любой длины лежит в истории
 * легально, но разбор мегабайтов на каждый find_files — блокировка общего
 * процесса; 64 КБ с запасом покрывают реальное сообщение со ссылками.
 */
export const LINK_CONTENT_MAX_CHARS = 65_536;

/**
 * Часть сообщения, которую link-кандидат несёт в скоринг и note: note всё
 * равно режется до 200 знаков (plainNote), а слова запроса ищутся в начале.
 */
export const LINK_TEXT_MAX_CHARS = 4_096;

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

/**
 * Внешние ссылки из человеческих сообщений (origin=link). Область сессий и
 * фильтр дней — те же, что у USER_FILES_SQL: чужие переписки исключены
 * префиксом session_id, содержимое по ссылкам не скачивается.
 */
export const USER_LINKS_SQL = `SELECT id, session_id, content, created_at FROM custom_chat_history
 WHERE session_id LIKE $1 || '\\_%' ESCAPE '\\' AND sender_type = 'human'
   AND content ~ 'https?://'
   AND ($2::int IS NULL OR created_at >= now() - make_interval(days => $2::int))
 ORDER BY created_at DESC
 LIMIT ${SEARCH_ROWS_LIMIT}`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Что отдаёт find_files модели. Адреса у stored=false нет.
 *
 * origin: 'assistant' — файл создал ассистент (как раньше); 'upload' — исходник,
 * который пользователь загружал сам; 'link' — внешняя ссылка из его сообщения.
 */
export interface FoundForTool {
  name: string;
  kind: ChatFileKind | 'link';
  origin: 'upload' | 'assistant' | 'link';
  date: string;
  assistant: string;
  url?: string;
  /**
   * Подписанный короткоживущий адрес для чтения исходника САМОЙ моделью
   * (chat-uploads assistantUrl): capability-ссылка на байты без входа.
   * Пользователю не показывается; в наши логи и телеметрию не пишется.
   * Вывод модели серверно не фильтруется — защита промптовая, как у
   * assistantBlock в chat-uploads.service.ts.
   */
  assistantUrl?: string;
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

/** Миниатюра — только картинкам из наших разрешённых бакетов. */
function withThumb(item: ChatFileItem, publicBaseUrl: string): ChatFileItem {
  if (item.kind !== 'image') return item;
  const thumbPath = thumbPathFor(item.url, publicBaseUrl);
  return thumbPath ? { ...item, thumbPath } : item;
}

@Injectable()
export class ChatFilesService {
  constructor(
    private readonly pg: PgService,
    /** Реестр исходных загрузок — источник origin=upload в find_files. */
    private readonly uploads: ChatUploadsService,
  ) {}

  /** Файлы одной переписки, от новых к старым. */
  async listForSession(userId: string, sessionId: string): Promise<ChatFileItem[]> {
    const env = extractEnv();
    const { rows } = await this.pg.query(SESSION_FILES_SQL, [sessionId]);
    const items = await this.resolve(userId, collectFiles(rows, env));
    return items.map(({ item }) => withThumb(item, env.publicBaseUrl));
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
   * Инструмент find_files: три источника одного пользователя — файлы, которые
   * создавали ассистенты; исходники, которые пользователь загружал сам
   * (chat_uploads); внешние ссылки из его сообщений. Все три сливаются в один
   * список от новых к старым, затем фильтры (вид, ассистент) и очки по словам
   * запроса; при равных очках свежие выше (сортировка устойчива). `days` и
   * `limit` действуют на все источники сразу.
   *
   * Исходники и ссылки гейтятся CHAT_UPLOADS_ENABLED: флаг выключен — реестр
   * не опрашивается, USER_LINKS_SQL не выполняется, assistantUrl не чеканится,
   * и find_files возвращает только файлы ассистентов, как до фичи. Флаг
   * читается тем же способом, что в chat.service.ts (uploadContextBlock),
   * chat.controller.ts и chat-uploads.service.ts (assistantBlock).
   */
  async searchForUser(
    userId: string,
    input: FindFilesInput,
  ): Promise<{ ok: true; total: number; files: FoundForTool[] }> {
    const uploadsOn = process.env.CHAT_UPLOADS_ENABLED === 'true';
    const [filesRes, uploadRecords, linksRes] = await Promise.all([
      this.pg.query(USER_FILES_SQL, [userId, input.days]),
      uploadsOn
        ? this.uploads.searchOriginals(userId, input.days ?? undefined)
        : Promise.resolve<ChatUploadRecord[]>([]),
      uploadsOn
        ? this.pg.query(USER_LINKS_SQL, [userId, input.days])
        : Promise.resolve<{ rows: any[] }>({ rows: [] }),
    ]);
    const found = collectFiles(filesRes.rows, extractEnv());

    /** Кандидат любого источника; assistant хранит FoundFile для resolve(). */
    interface Candidate {
      origin: 'upload' | 'assistant' | 'link';
      kind: ChatFileKind | 'link';
      name: string;
      createdAt: string;
      sessionId: string;
      /** Текст, в котором ищут слова запроса и из которого делается note. */
      text: string;
      url?: string;
      /** Только для origin=upload: id исходника, assistantUrl чеканится после limit. */
      uploadId?: string;
      stored: boolean;
      found?: FoundFile;
    }

    const candidates: Candidate[] = found.map((f) => ({
      origin: 'assistant',
      kind: f.file.kind,
      name: f.file.name,
      createdAt: f.createdAt,
      sessionId: f.sessionId ?? '',
      text: f.text,
      stored: f.file.stored,
      found: f,
    }));
    for (const rec of uploadRecords) {
      candidates.push({
        origin: 'upload',
        kind: kindByMime(rec.mime, rec.originalName),
        // Имя из multipart враждебно так же, как остальной пользовательский
        // ввод: safeFileName снимает управляющие, невидимые (RLO) и служебные
        // символы — как в storageKey при сохранении исходника.
        name: safeFileName(rec.originalName),
        createdAt: rec.createdAt,
        sessionId: rec.sessionId,
        text: '',
        url: this.uploads.ownerUrl(rec.id),
        uploadId: rec.id,
        stored: true,
      });
    }
    const seenLinks = new Set<string>();
    for (const row of linksRes.rows) {
      const createdAt = new Date(row.created_at).toISOString();
      const sessionId = String(row.session_id ?? '');
      // Потолок разбора — до extractHumanLinks; в кандидатах ещё короче:
      // скоринг и note не нуждаются в мегабайтах.
      const content = String(row.content ?? '').slice(0, LINK_CONTENT_MAX_CHARS);
      for (const link of extractHumanLinks(content)) {
        // Повтор адреса в разных сообщениях — одна запись, самая свежая
        // (строки уже отсортированы от новых к старым).
        if (seenLinks.has(link.url)) continue;
        seenLinks.add(link.url);
        candidates.push({
          origin: 'link',
          kind: 'link',
          name: link.text || link.url,
          createdAt,
          sessionId,
          text: content.slice(0, LINK_TEXT_MAX_CHARS),
          url: link.url,
          stored: true,
        });
      }
    }

    // Единая свежесть до скоринга: при равных очках порядок — от новых к старым.
    candidates.sort((a, b) => (a.createdAt === b.createdAt ? 0 : a.createdAt < b.createdAt ? 1 : -1));

    const partOf = (sessionId: string) => assistantPart(sessionId, userId);
    const names = await this.assistantNames(userId, candidates.map((c) => partOf(c.sessionId)));

    const want = normalizeForSearch(input.assistant);
    const words = queryWords(input.query);
    const scored = candidates
      .filter((c) => input.kind === 'any' || c.kind === input.kind)
      .filter((c) => {
        if (!want) return true;
        const n = names.get(partOf(c.sessionId));
        return !!n && [n.display, ...n.aliases].some((a) => normalizeForSearch(a).includes(want));
      })
      .map((c) => ({ c, score: words.length > 0 ? scoreFile(words, c.name, c.text) : 0 }))
      .filter((x) => words.length === 0 || x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.c);

    // resolve() — только файлам ассистентов: подставляет адреса видео и озвучки
    // и роняет неготовые или чужие. Исходники и ссылки уже готовы.
    const resolved = await this.resolve(
      userId,
      scored.filter((c) => c.origin === 'assistant').map((c) => c.found as FoundFile),
    );
    const itemByFound = new Map<FoundFile, ChatFileItem>(
      resolved.map(({ found, item }) => [found, item] as [FoundFile, ChatFileItem]),
    );

    const out: { c: Candidate; tool: FoundForTool }[] = [];
    for (const c of scored) {
      const assistant = names.get(partOf(c.sessionId))?.display ?? '';
      const date = c.createdAt.slice(0, 10);
      if (c.origin === 'assistant') {
        const item = itemByFound.get(c.found as FoundFile);
        if (!item) continue;
        out.push({
          c,
          tool: {
            name: item.name,
            kind: item.kind,
            origin: 'assistant',
            date,
            assistant,
            ...(item.url ? { url: item.url } : {}),
            stored: item.stored,
            note: plainNote(c.text),
          },
        });
      } else {
        out.push({
          c,
          tool: {
            name: c.name,
            kind: c.kind,
            origin: c.origin,
            date,
            assistant,
            ...(c.url ? { url: c.url } : {}),
            stored: c.stored,
            note: c.origin === 'link' ? plainNote(c.text) : '',
          },
        });
      }
    }

    const page = out.slice(0, input.limit);
    // Подписанный assistantUrl — capability на байты исходника: чеканится
    // только для страницы, которая реально уйдёт модели, не для всех 200.
    for (const { c, tool } of page) {
      if (c.origin === 'upload' && c.uploadId) tool.assistantUrl = this.uploads.assistantUrl(c.uploadId);
    }
    return { ok: true, total: out.length, files: page.map((x) => x.tool) };
  }
}
