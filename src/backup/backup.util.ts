/**
 * Проверка загрузки резервной копии профиля (A6, §4.2.1). Вынесено из сервиса как чистая
 * функция, чтобы покрыть тестами без БД и Nest.
 *
 * СЕРВЕР СЛЕП. Мы не расшифровываем блоб и не заглядываем внутрь (в этом весь смысл §4.2.1:
 * у нас только шифротекст, ключ у владельца). Поэтому здесь — только декод base64 и размерные
 * границы: чтобы пустой/битый/раздутый блоб не затёр хорошую копию и не забил хранилище.
 */

export const MAX_BACKUP_BYTES = 8 * 1024 * 1024; // 8 MiB — сжатый конверт профиля много меньше
// версия(1)+соль(16)+IV(12)+тег(16) — минимальная длина конверта AES-GCM из ProfileCrypto.
// Это ПОЛ по длине, а не разбор содержимого: слепоты не нарушает.
export const MIN_BACKUP_BYTES = 1 + 16 + 12 + 16;

export interface ParsedUpload {
  bytes: Buffer;
  size: number;
  format: number;
}

export class BackupValidationError extends Error {}

export function parseBackupUpload(body: any): ParsedUpload {
  if (!body || typeof body.blob !== 'string' || body.blob.length === 0) {
    throw new BackupValidationError('blob (base64) required');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.blob)) {
    throw new BackupValidationError('blob must be standard base64');
  }
  const bytes = Buffer.from(body.blob, 'base64');
  if (bytes.length < MIN_BACKUP_BYTES) {
    throw new BackupValidationError('blob too small to be a profile backup');
  }
  if (bytes.length > MAX_BACKUP_BYTES) {
    throw new BackupValidationError('blob exceeds size limit');
  }
  let format = 1;
  if (body.format !== undefined && body.format !== null) {
    if (!Number.isInteger(body.format) || body.format < 1) {
      throw new BackupValidationError('format must be a positive integer');
    }
    format = body.format;
  }
  return { bytes, size: bytes.length, format };
}
