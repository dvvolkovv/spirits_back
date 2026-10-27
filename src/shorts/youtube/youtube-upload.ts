import { YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { Http, HttpResponse, clip, googleReason, googleReasonCode } from './youtube-http';

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
export function isSessionUrl(location: unknown): location is string {
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

/** Явные лимиты: единственные причины 403, которые на вопросе о сессии считаем итоговым отказом. */
const FINAL_403_REASONS = new Set(['quotaExceeded', 'uploadLimitExceeded']);

/**
 * Отправить файл одним запросом. 200/201 с id — загружен. Явный отказ 4xx — ролика нет
 * (YoutubeNotUploaded). Всё остальное — обрыв, 2xx без id, 3xx (в том числе 308), 408,
 * 429, 5xx — исход неизвестен (YoutubeMaybeUploaded): решает вопрос о сессии.
 */
export async function sendFile(http: Http, sessionUrl: string, accessToken: string, body: Buffer): Promise<string> {
  if (!isSessionUrl(sessionUrl)) throw new YoutubeNotUploaded('адрес сессии не на googleapis.com — файл не отправляю');
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
 * - 308 без Range или с Range, не покрывающим файл, — не догружено (incomplete); Range не
 *   по протоколу (не `bytes=0-N`) или покрывающий файл целиком — исход неизвестен
 *   (YoutubeMaybeUploaded): непонятному ответу верить нельзя, а полный Range значит, что
 *   YouTube собирает ролик;
 * - 403 без причины из FINAL_403_REASONS — тоже исход неизвестен: бывает «сессия не этого
 *   аккаунта» (канал переподключил другой менеджер бренд-канала), и тогда прошлая загрузка
 *   могла дойти;
 * - прочие 4xx, кроме 401, 404, 408, 410, 429, — завершённая сессия повторяет свой итоговый
 *   отказ: загрузка кончилась отказом, ролика нет (failed);
 * - 404/410 — сессии больше нет (истекла): спросить не у кого, дошла ли (gone);
 * - прочее и обрыв — YoutubeMaybeUploaded: ответа нет, решать нельзя.
 */
export async function checkUpload(http: Http, sessionUrl: string, accessToken: string, size: number): Promise<UploadState> {
  // негодный адрес — спросить не у кого: дальше набор с предупреждением
  if (!isSessionUrl(sessionUrl)) return { state: 'gone' };
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
    const range = String(r.headers?.range ?? '').trim();
    // Байтов не получено — не догружено.
    if (!range) return { state: 'incomplete' };
    const m = /^bytes=0-(\d+)$/.exec(range);
    // Ответ не по протоколу — решать по нему нельзя.
    if (!m) throw new YoutubeMaybeUploaded(`YouTube ответил о загрузке непонятным Range: ${clip(range, 60)}`, 308);
    if (Number(m[1]) + 1 >= size) throw new YoutubeMaybeUploaded('YouTube получил файл целиком, ролика в ответе ещё нет', 308);
    return { state: 'incomplete' };
  }
  if (r.status === 404 || r.status === 410) return { state: 'gone' };
  // 403 бывает и «сессия не этого аккаунта» (канал переподключил другой менеджер бренд-канала):
  // итоговым отказом считаем только явные лимиты, остальное — исход неизвестен.
  if (r.status === 403 && !FINAL_403_REASONS.has(googleReasonCode(r) ?? '')) {
    throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`, 403);
  }
  if (refused(r.status) && r.status !== 401) return { state: 'failed', status: r.status, reason: googleReason(r) };
  throw new YoutubeMaybeUploaded(`YouTube не ответил о загрузке: ${googleReason(r)}`, r.status);
}
