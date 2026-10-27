import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, googleReason } from './youtube-http';

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

const short = (e: any): string => String(e?.message ?? e).slice(0, 200);

/** Начать resumable-загрузку: метаданные → адрес сессии. Ролика ещё нет: любой сбой безопасен для повтора. */
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
  if (r.status === 401) throw new YoutubeAuthError(`начало загрузки: ${googleReason(r)}`);
  const location = r.headers?.location;
  if (r.status === 200 && typeof location === 'string' && location) return location;
  throw new YoutubeNotUploaded(`начало загрузки: ${googleReason(r)}`, r.status);
}

/** Ответ с загруженным роликом — id из тела, иначе null. */
function uploadedId(r: HttpResponse): string | null {
  return (r.status === 200 || r.status === 201) && typeof r.data?.id === 'string' && r.data.id ? r.data.id : null;
}

/**
 * Отправить файл одним запросом. 200/201 — загружен. Обрыв, таймаут, 408, 5xx и
 * 308 — исход неизвестен (YoutubeMaybeUploaded): решает вопрос о сессии. Прочие
 * 4xx — YouTube файл не принял, ролика нет.
 */
export async function sendFile(http: Http, sessionUrl: string, body: Buffer): Promise<string> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(body.length) },
      data: body,
      timeout: SEND_TIMEOUT_MS,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`отправка файла оборвалась: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return id;
  if (r.status === 308 || r.status === 408 || r.status >= 500) throw new YoutubeMaybeUploaded(`отправка файла: ${googleReason(r)}`);
  throw new YoutubeNotUploaded(`отправка файла: ${googleReason(r)}`, r.status);
}

export type UploadState = { state: 'complete'; videoId: string } | { state: 'incomplete' } | { state: 'gone' };

/**
 * Спросить YouTube о сессии: PUT без тела, Content-Range со звёздочкой и размером
 * файла. 200/201 — загружено (в теле ролик), 308 — не догружено, 404/410 — сессии
 * нет. Обрыв и прочие ответы — YoutubeMaybeUploaded: ответа нет, решать нельзя.
 */
export async function checkUpload(http: Http, sessionUrl: string, size: number): Promise<UploadState> {
  let r: HttpResponse;
  try {
    r = await http({
      method: 'PUT',
      url: sessionUrl,
      headers: { 'Content-Range': `bytes */${size}`, 'Content-Length': '0' },
      timeout: 30_000,
    });
  } catch (e: any) {
    throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${short(e)}`);
  }
  const id = uploadedId(r);
  if (id) return { state: 'complete', videoId: id };
  if (r.status === 308) return { state: 'incomplete' };
  if (r.status === 404 || r.status === 410) return { state: 'gone' };
  throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`);
}
