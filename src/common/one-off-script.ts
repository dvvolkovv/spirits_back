import * as fs from 'fs';

/**
 * Общее для разовых скриптов (scripts/*) спеки
 * 2026-11-02-pii-out-of-prompts-design.md: переименование голосов ElevenLabs,
 * перенос голосовых документов, перенос ссылок релея.
 *
 * Их журналы и списки содержат ключи и адреса с номерами — файлы только
 * владельцу (600). Скрипты к тому же ставят umask 077 сами; права здесь —
 * вторая линия: файл мог остаться от прежнего запуска с другими правами.
 */

/** Записать файл целиком; права 600, даже если файл уже был. */
export function writePrivateFile(file: string, data: string): void {
  fs.writeFileSync(file, data, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const privateJournals = new Set<string>();

/** Строка в журнал JSONL; права 600 — и у нового файла, и у дописываемого. */
export function appendPrivateLine(file: string, line: string): void {
  fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`, { mode: 0o600 });
  if (!privateJournals.has(file)) {
    fs.chmodSync(file, 0o600);
    privateJournals.add(file);
  }
}

/**
 * Соль солёного хэша — только RELAY_FS_SALT. Приложение без неё считает хэш
 * на JWT_SECRET, но его меняют (смена 12.10.2026), и папки, посчитанные
 * разовым скриптом, разошлись бы с новыми. Нет соли — отказ до первого запроса.
 */
export function requireRelayFsSalt(): void {
  if (!(process.env.RELAY_FS_SALT || '').trim()) {
    throw new Error(
      'нет RELAY_FS_SALT в окружении (.env) — без соли солёный хэш не посчитать; JWT_SECRET как запасная соль здесь не годится',
    );
  }
}

/**
 * Ошибка для консоли: сообщение и код. Объект целиком не печатаем: у ошибок
 * S3 в нём метаданные запроса, у axios — заголовки с ключом.
 */
export function scriptErrorText(e: any): string {
  if (!(e instanceof Error) && (typeof e !== 'object' || e === null)) return String(e);
  const msg = String(e?.message ?? 'ошибка');
  const code = e?.code ?? e?.Code ?? (e?.name && e.name !== 'Error' ? e.name : undefined);
  return code && !msg.includes(String(code)) ? `${msg} (${code})` : msg;
}
