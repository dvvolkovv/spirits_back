/**
 * У Telegram подпись к фото — 1024 символа. Берём 1000 с запасом: пост
 * «картинка + история» не должен разъезжаться на два сообщения.
 */
export const CAPTION_LIMIT = 1000;

export function buildCaption(title: string, body: string): string {
  const head = (title || '').trim();
  const tail = (body || '').trim();
  const full = tail ? `${head}\n\n${tail}` : head;
  if (full.length <= CAPTION_LIMIT) return full;

  const cut = full.slice(0, CAPTION_LIMIT);

  // Режем по границе слова — никогда не рвём слово пополам. Если в тексте
  // вообще нет пробела в пределах лимита, режем жёстко символ в символ.
  const wordEnd = cut.lastIndexOf(' ');
  const safe = (wordEnd > 0 ? cut.slice(0, wordEnd) : cut.slice(0, CAPTION_LIMIT - 1)).trim();

  // Если граница слова сама совпала с концом предложения — обрывать
  // многоточием не нужно, мысль и так закончена.
  if (/[.!?]$/.test(safe)) return safe;

  return `${safe}…`;
}
