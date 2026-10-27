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

/**
 * Явные лимиты: при них на вопросе о сессии считаем загрузку окончательно отказанной. По
 * таблице ошибок videos.insert uploadLimitExceeded документирован как 400, а не 403 — здесь
 * он просто страховка на случай, если Google всё же пришлёт такую причину в теле 403.
 */
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
 * - 308 без заголовка Range вовсе — байтов не получено, не догружено (incomplete); Range с
 *   неполным диапазоном (`bytes=0-N` меньше size) — тоже не догружено; Range присланный, но
 *   пустой, не по протоколу (не `bytes=0-N`) или покрывающий файл целиком — исход неизвестен
 *   (YoutubeMaybeUploaded): такому ответу верить нельзя, а полный Range значит, что YouTube
 *   уже собирает ролик;
 * - 403 без причины из FINAL_403_REASONS — тоже исход неизвестен: бывает «сессия не этого
 *   аккаунта» (канал переподключил другой менеджер бренд-канала), и тогда прошлая загрузка
 *   могла дойти — сообщение так и говорит, с подсказкой переподключить прежним аккаунтом;
 * - прочие 4xx, кроме 401, 404, 408, 410, 429, — завершённая сессия повторяет свой итоговый
 *   отказ: загрузка кончилась отказом, ролика нет (failed);
 * - 404/410 — сессии больше нет (истекла): спросить не у кого, дошла ли (gone);
 * - прочее и обрыв — YoutubeMaybeUploaded: ответа нет или он неоднозначен, решать нельзя.
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
    const rawRange = r.headers?.range;
    // Заголовка нет вовсе — обычный ответ на вопрос о свежей сессии, байтов пока нет.
    // Это не то же самое, что присланный, но пустой, — тому верить нельзя (см. ниже).
    if (rawRange === undefined || rawRange === null) return { state: 'incomplete' };
    const range = String(rawRange).trim();
    const m = range ? /^bytes=0-(\d+)$/.exec(range) : null;
    // Пустой или не по протоколу — решать по такому ответу нельзя.
    if (!m) {
      throw new YoutubeMaybeUploaded(
        range ? `YouTube ответил о загрузке непонятным Range: ${clip(range, 60)}` : 'YouTube ответил о загрузке пустым Range',
        308,
      );
    }
    if (Number(m[1]) + 1 >= size) throw new YoutubeMaybeUploaded('YouTube получил файл целиком, ролика в ответе ещё нет', 308);
    return { state: 'incomplete' };
  }
  if (r.status === 404 || r.status === 410) return { state: 'gone' };
  // 403 итоговым отказом считаем только при явном лимите (FINAL_403_REASONS) — остальные 403
  // бывают и «сессия не этого аккаунта» (канал переподключил другой менеджер бренд-канала),
  // и тогда прошлая загрузка могла дойти: это тоже исход неизвестен, см. throw ниже.
  if (refused(r.status) && r.status !== 401 && (r.status !== 403 || FINAL_403_REASONS.has(googleReasonCode(r) ?? ''))) {
    return { state: 'failed', status: r.status, reason: googleReason(r) };
  }
  throw new YoutubeMaybeUploaded(
    r.status === 403
      ? `YouTube отказал в ответе о прошлой загрузке (${googleReason(r)}) — так бывает, если канал переподключили другим аккаунтом; тогда переподключите прежним`
      : `YouTube не ответил о загрузке: ${googleReason(r)}`,
    r.status,
  );
}
