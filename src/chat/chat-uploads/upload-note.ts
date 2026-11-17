/**
 * Комментарий ассистента к загрузке пользователя (инструмент note_file):
 * чистые функции чистки. sanitizeUploadNote — строка в том виде, в каком
 * она ляжет в базу (ChatUploadsService.setNote); uploadNoteOneLine — вывод
 * модели одной строкой: блок загрузок (ChatUploadsService.assistantLine) и
 * поле note в find_files (ChatFilesService.searchForUser).
 */

/** C0, кроме TAB и LF, плюс DEL и C1. NUL Postgres в text не примет (22021), прочие — мусор в подсказке. */
const NOTE_CONTROL_RE = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/**
 * Невидимые символы формата — весь \p{Cf}, кроме ZWJ (U+200D): он склеивает
 * эмодзи. Сюда входят bidi-переопределения и изоляты (U+202A–U+202E,
 * U+2066–U+2069) — подменяют видимый порядок символов, та же защита, что в
 * safeFileName; теги U+E0000–U+E007F — прячут текст, который модель прочтёт,
 * а человек не увидит; ZWSP, LRM/RLM, WJ и U+2061–U+2064, BOM, якоря
 * аннотаций U+FFF9–U+FFFB.
 */
const NOTE_FORMAT_RE = /(?!\u200D)\p{Cf}/gu;

/**
 * Комментарий к загрузке в том виде, в каком он ляжет в базу: CRLF и CR
 * сведены к LF (многострочность остаётся — в одну строку его сводит
 * uploadNoteOneLine на выводе модели: в блоке загрузок и в поле note
 * find_files), управляющие символы и символы формата (кроме ZWJ) вырезаны,
 * края обрезаны.
 * Не строка — пустая строка.
 */
export function sanitizeUploadNote(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\r\n?/g, '\n').replace(NOTE_CONTROL_RE, '').replace(NOTE_FORMAT_RE, '').trim();
}

/**
 * Комментарий к загрузке на выводе модели — одной строкой. Сначала ещё раз
 * sanitizeUploadNote (строка могла попасть в базу в обход setNote), затем
 * пробельные символы, включая переводы строк и разделители U+2028/U+2029,
 * схлопываются в пробел: комментарий не допишет «своих» строк. Один вывод
 * на блок загрузок (assistantLine) и find_files (поле note) — модель видит
 * комментарий одинаково. Нет комментария — пустая строка.
 */
export function uploadNoteOneLine(raw: unknown): string {
  return sanitizeUploadNote(raw).replace(/\s+/g, ' ').trim();
}
