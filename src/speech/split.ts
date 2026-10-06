// src/speech/split.ts

/**
 * Режет текст на куски не длиннее maxChars — для синтеза ответа по частям.
 *
 * Кнопка «Прослушать» отдаёт целый ответ ассистента, а у провайдера потолок
 * на один запрос (maxCharsFor: 2000 у Yandex, 4000 у OpenAI). Граница ищется
 * от самой естественной к самой грубой: конец абзаца → конец предложения →
 * пробел; слово длиннее лимита режется посередине. Абзац и предложение берём,
 * только если кусок выходит хотя бы в половину лимита, — иначе текст
 * раздробился бы на лишние запросы к провайдеру.
 *
 * Инварианты (их сторожат тесты): кусков без текста нет, каждый не длиннее
 * maxChars, склейка сохраняет все непробельные символы в исходном порядке.
 */
export function splitForSpeech(text: string, maxChars: number): string[] {
  if (!(maxChars >= 1)) throw new RangeError(`maxChars must be >= 1, got ${maxChars}`);
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > maxChars) {
    const cut = findCut(rest, maxChars);
    const head = rest.slice(0, cut).trim();
    if (head) chunks.push(head);
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function findCut(text: string, maxChars: number): number {
  // +1: перевод строки или пробел ровно на границе тоже годится — он уйдёт
  // при trim, и кусок выйдет ровно в maxChars.
  const window = text.slice(0, maxChars + 1);
  const minUseful = Math.ceil(maxChars / 2);

  const para = window.lastIndexOf('\n');
  if (para >= minUseful) return para + 1;

  // Конец предложения: знаки препинания, за ними могут стоять закрывающие
  // кавычки и скобки, дальше обязателен пробельный символ.
  const sentenceEnd = /[.!?…]+["»”’')\]]*(?=\s)/g;
  let sentence = -1;
  let m: RegExpExecArray | null;
  while ((m = sentenceEnd.exec(window)) !== null) {
    const end = m.index + m[0].length;
    if (end <= maxChars) sentence = end;
  }
  if (sentence >= minUseful) return sentence;

  const space = window.lastIndexOf(' ');
  if (space > 0) return space + 1;

  return maxChars;
}
