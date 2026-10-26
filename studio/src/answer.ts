/** Тексты, которыми релей сообщает о сбое вместо ответа. */
export const FAILURE_MARKERS = ['Временный сбой'];

/**
 * Хвост после вопросительного знака, который не меняет смысла: пробелы,
 * закрывающие кавычки и скобки, эмодзи и их модификаторы (тон кожи,
 * вариант начертания — это символы категории Mark и Extended_Pictographic),
 * и невидимый соединитель ZWJ составных эмодзи (категория Cf).
 */
const QUESTION_TAIL = /[\s"'»“”„)\]\p{Extended_Pictographic}\p{M}\p{Emoji_Modifier}\p{Cf}]+$/u;

/** Встречный вопрос вместо ответа: коротко и кончается вопросительным знаком (хвост из эмодзи и кавычек не мешает). */
export function isCounterQuestion(answer: string, minChars: number): boolean {
  const a = answer.trim();
  return a.length < minChars && /[?？]$/.test(a.replace(QUESTION_TAIL, ''));
}

/** Почему этот ответ нельзя снимать; пустой список — можно. */
export function answerProblems(answer: string, minChars: number): string[] {
  const a = answer.trim();
  const problems: string[] = [];
  if (FAILURE_MARKERS.some((m) => a.includes(m))) problems.push('ассистент ответил «Временный сбой»');
  if (a.length < minChars) problems.push(`ответ ${a.length} символов — меньше порога ${minChars}`);
  return problems;
}
