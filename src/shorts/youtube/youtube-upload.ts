import { YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, clip, googleReason } from './youtube-http';

const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
/** Файл ролика — 10–50 МБ: выгрузка с запасом укладывается в срок живости публикации (10 мин). */
export const SEND_TIMEOUT_MS = 8 * 60 * 1000;

export interface UploadMeta {
  title: string;
  description: string;
  tags: string[];
  categoryId: string;
  language: string;
  privacy: 'unlisted' | 'public';
}

const short = (e: any): string => clip(String(e?.message ?? e), 200);

/** Адрес сессии — только https на *.googleapis.com: дальше на него уходят файл и Bearer. */
function isSessionUrl(location: unknown): location is string {
  if (typeof location !== 'string' || !location) return false;
  try {
    const u = new URL(location);
    return u.protocol === 'https:' && (u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'));
  } catch {
    return false;
  }
}

/**
 * Начать resumable-загрузку: метаданные → адрес сессии. Начало сессии ролика не создаёт:
 * любой отказ, в том числе 401, — YoutubeNotUploaded, повтор безопасен. Отозванный доступ
 * поймает следующее обновление токена (invalid_grant).
 */
export async function startUpload(http: Http, accessToken: string, meta: UploadMeta, size: number): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'POST',
      url: UPLOAD_URL,
      params: { uploadType: 'resumable', part: 'snippet,status' },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': 'video/mp4',
        'X-Upload-Content-Length': String(size),
      },
      data: {
        snippet: {
          title: meta.title,
          description: meta.description,
          tags: meta.tags,
          categoryId: meta.categoryId,
          defaultLanguage: meta.language,
          defaultAudioLanguage: meta.language,
        },
        status: {
          privacyStatus: meta.privacy,
          selfDeclaredMadeForKids: false,
          // Анимацию YouTube отмечать не требует — только реалистичные сцены и настоящих людей.
          containsSyntheticMedia: false,
        },
      },
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new YoutubeNotUploaded(`начало загрузки: ${short(e)}`);
  }
  if (r.status !== 200) throw new YoutubeNotUploaded(`начало загрузки: ${googleReason(r)}`, r.status);
  const location = r.headers?.location;
  if (!isSessionUrl(location)) throw new YoutubeNotUploaded('начало загрузки: адреса сессии нет или он не на googleapis.com', 200);
  return location;
}

/** Ответ с загруженным роликом — id из тела, иначе null. */
function uploadedId(r: HttpResponse): string | null {
  return (r.status === 200 || r.status === 201) && typeof r.data?.id === 'string' && r.data.id ? r.data.id : null;
}

/** «Ролика нет» — только явный отказ 4xx; 408 и 429 — сбой в пути, исход неизвестен. */
const refused = (status: number): boolean => status >= 400 && status < 500 && status !== 408 && status !== 429;

/**
 * Отправить файл одним запросом. 200/201 с id — загружен. Явный отказ 4xx — ролика нет
 * (YoutubeNotUploaded). Всё остальное — обрыв, 2xx без id, 3xx (в том числе 308), 408,
 * 429, 5xx — исход неизвестен (YoutubeMaybeUploaded): решает вопрос о сессии.
 */
export async function sendFile(http: Http, sessionUrl: string, accessToken: string, body: Buffer): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
      data: body,
      timeout: SEND_TIMEOUT_MS,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`отправка файла оборвалась: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return id;
  if (refused(r.status)) throw new YoutubeNotUploaded(`отправка файла: ${googleReason(r)}`, r.status);
  throw new YoutubeMaybeUploaded(`отправка файла: ${googleReason(r)}`, r.status);
}

export type UploadState =
  | { state: 'complete'; videoId: string }
  | { state: 'incomplete' }
  | { state: 'failed'; status: number; reason: string }
  | { state: 'gone' };

/**
 * Спросить YouTube о сессии: PUT без тела, Content-Range со звёздочкой и размером файла.
 * - 200/201 с роликом — загружено (complete);
 * - 308 — не догружено (incomplete); но если Range уже покрывает весь файл, YouTube
 *   собирает ролик — исход неизвестен (YoutubeMaybeUploaded);
 * - 4xx, кроме 401, 404, 408, 410, 429, — завершённая сессия повторяет свой итоговый
 *   отказ: загрузка кончилась отказом, ролика нет (failed);
 * - 404/410 — сессии больше нет (истекла): спросить не у кого, дошла ли (gone);
 * - прочее и обрыв — YoutubeMaybeUploaded: ответа нет, решать нельзя.
 */
export async function checkUpload(http: Http, sessionUrl: string, accessToken: string, size: number): Promise<UploadState> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return { state: 'complete', videoId: id };
  if (r.status === 308) {
    const m = /^bytes=0-(\d+)$/.exec(String(r.headers?.range ?? '').trim());
    if (m && Number(m[1]) + 1 >= size) throw new YoutubeMaybeUploaded('YouTube получил файл целиком, ролика в ответе ещё нет', 308);
    return { state: 'incomplete' };
  }
  if (r.status === 404 || r.status === 410) return { state: 'gone' };
  if (refused(r.status) && r.status !== 401) return { state: 'failed', status: r.status, reason: googleReason(r) };
  throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`, r.status);
}
