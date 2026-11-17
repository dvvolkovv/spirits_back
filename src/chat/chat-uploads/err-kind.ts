/**
 * Журнал загрузок: сервис и контроллер пишут только вид ошибки и id в кавычках.
 */

/**
 * Только вид ошибки, без текста сообщения: ключ объекта — это
 * `<uuid>/<safeFileName(имя)>`, и сообщения S3/pg могут повторять его или
 * имя файла. name, HTTP-статус S3 ($metadata.httpStatusCode) и код
 * (SQLSTATE pg или системный вроде ETIMEDOUT) — каждое лишь из безопасных
 * символов, перевод строки запись не подделает.
 */
export function errKind(e: any): string {
  const name = String(e?.name || 'Error').replace(/[^\w.-]/g, '').slice(0, 64) || 'Error';
  const parts = [name];
  const status = e?.$metadata?.httpStatusCode;
  if (Number.isInteger(status)) parts.push(`status=${status}`);
  const code = e?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) parts.push(`code=${code}`);
  return parts.join(' ');
}

/** id из запроса для журнала: в кавычках и экранирован — перевод строки не подделает запись. */
export function logId(id: unknown): string {
  return JSON.stringify(String(id).slice(0, 64));
}
