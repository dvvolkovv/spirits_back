import { ownBaseUrl, ownOrigins } from '../../common/net/own-media';
import { ChatUploadTooLargeError } from './chat-uploads.service';
import type { ChatUploadsService } from './chat-uploads.service';

/**
 * Загрузка пользователя как исходник инструментов картинок и видео (spec
 * 2026-11-16-chat-uploads-media-notes, «Загрузки как исходник»): edit_image,
 * upscale_image, compose_image (misc.service.ts) и generate_video в режиме
 * image2video (video.service.ts).
 *
 * Адрес загрузки распознаётся в любом виде, который модель берёт из find_files
 * или из блока загрузок: относительный /webhook/chat-uploads/<id> или
 * абсолютный на нашем origin, с подписью ?exp&sig или без. Байты читаются
 * прямо из приватного бакета, а не по HTTP. Подпись здесь не нужна и не
 * проверяется: доступ решает владелец хода (findOwnedOriginal).
 */

/** Путь загрузки целиком: /thumb и прочие хвосты исходником не считаются. */
const CHAT_UPLOAD_PATH_RE = /^\/webhook\/chat-uploads\/([0-9a-f-]{36})\/?$/i;

/** id загрузки, если ссылка ведёт на /webhook/chat-uploads/<id> нашего сайта; иначе null. */
export function chatUploadIdFromUrl(raw: string): string | null {
  const s = String(raw ?? '').trim();
  let u: URL;
  try {
    u = s.startsWith('/') && !s.startsWith('//') ? new URL(s, `${ownBaseUrl()}/`) : new URL(s);
  } catch {
    return null;
  }
  // Сначала путь, потом origin: любая другая ссылка отсекается без разбора
  // окружения (так же дёшево и в маркерах Telegram, tg-bot.service.ts).
  const m = CHAT_UPLOAD_PATH_RE.exec(u.pathname);
  if (!m) return null;
  // Тот же список своих origin, что у own-media (BACKEND_URL, PUBLIC_BASE_URL,
  // my.linkeon.io): чужой домен с таким же путём — обычная внешняя ссылка.
  if (!ownOrigins().has(u.origin)) return null;
  return m[1].toLowerCase();
}

/**
 * То же, но только при включённой «Памяти загрузок». Флаг выключен — адрес
 * загрузки идёт прежним путём, как до фичи: без флага реестр пуст.
 */
export function chatUploadSourceId(raw: string): string | null {
  if (process.env.CHAT_UPLOADS_ENABLED !== 'true') return null;
  return chatUploadIdFromUrl(raw);
}

/** Адрес загрузки без подписи — его можно хранить (video_jobs): читается по владельцу, а не по подписи. */
export function canonicalChatUploadUrl(id: string): string {
  return `${ownBaseUrl()}/webhook/chat-uploads/${id}`;
}

export type ChatUploadSourceErrorCode = 'not_found' | 'not_image' | 'too_large' | 'unavailable';

/**
 * Отказ взять загрузку исходником. Текст уходит модели (chat-tools отдаёт его
 * полем error) — по-русски и без подробностей о чужих файлах.
 */
export class ChatUploadSourceError extends Error {
  constructor(readonly code: ChatUploadSourceErrorCode, message: string) {
    super(message);
    this.name = 'ChatUploadSourceError';
  }
}

/**
 * Картинка из загрузки пользователя. null — ссылка не на загрузку (или флаг
 * выключен): вызывающий идёт прежним путём fetchMediaBytes. Чужая или
 * удалённая загрузка, не image/* и больше maxBytes — ChatUploadSourceError.
 * Сбой хранилища пробрасывается как есть.
 */
export async function readChatUploadImage(
  uploads: Pick<ChatUploadsService, 'findOwnedOriginal'> | null | undefined,
  input: { url: string; userId: string; maxBytes: number },
): Promise<{ b64: string; mime: string } | null> {
  const id = chatUploadSourceId(input.url);
  if (!id) return null;
  if (!uploads) {
    throw new ChatUploadSourceError('unavailable', 'загрузки пользователя сейчас недоступны как исходник');
  }
  let found: Awaited<ReturnType<ChatUploadsService['findOwnedOriginal']>>;
  try {
    found = await uploads.findOwnedOriginal({ id, userId: input.userId, maxBytes: input.maxBytes });
  } catch (e) {
    if (e instanceof ChatUploadTooLargeError) {
      const mb = Math.round(input.maxBytes / (1024 * 1024));
      throw new ChatUploadSourceError('too_large', `загрузка пользователя больше ${mb} МБ — такой исходник не принимается`);
    }
    throw e;
  }
  if (!found) {
    throw new ChatUploadSourceError('not_found', 'загрузка пользователя не найдена: её удалили или она недоступна');
  }
  const mime = found.record.mime.split(';')[0].trim().toLowerCase();
  if (!mime.startsWith('image/')) {
    throw new ChatUploadSourceError('not_image', 'загрузка пользователя — не картинка: исходником могут быть только изображения');
  }
  return { b64: found.body.toString('base64'), mime };
}
