import { StorageService } from '../common/services/storage.service';
import { shortsBucket } from './shorts.types';

/**
 * Срок скачивания файла ролика из MinIO. Потребителей двое, и оба — внутри шага публикации,
 * который должен уложиться в порог сторожа (STUCK_PUBLISHING_MINUTES, 10 мин): иначе зависшая
 * попытка пережила бы возврат ролика в очередь.
 * - Загрузка на YouTube (ShortsYoutubeService.upload): скачивание вместе с обновлением токена
 *   (15 с), вопросом о прошлой сессии и началом новой (по 30 с) — до продления живости перед
 *   отправкой файла, с запасом меньше порога.
 * - Публикатор (канал — видео и обложка, набор YouTube — видео): скачивание идёт до продления
 *   живости перед отправкой, на ветках после ошибки загрузки — второй раз.
 */
export const DOWNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

/** Файл ролика из бакета роликов — со сроком DOWNLOAD_TIMEOUT_MS: зависшее скачивание прерывается. */
export async function downloadShortFile(storage: Pick<StorageService, 'download'>, key: string): Promise<Buffer> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    return await storage.download({ bucket: shortsBucket(), key, abortSignal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}
