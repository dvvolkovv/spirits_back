/** Тексты, которыми релей сообщает о сбое вместо ответа. */
export const FAILURE_MARKERS = ['Временный сбой'];

/** Встречный вопрос вместо ответа: коротко и кончается вопросительным знаком. */
export function isCounterQuestion(answer: string, minChars: number): boolean {
  const a = answer.trim();
  return a.length < minChars && a.endsWith('?');
}

/** Почему этот ответ нельзя снимать; пустой список — можно. */
export function answerProblems(answer: string, minChars: number): string[] {
  const a = answer.trim();
  const problems: string[] = [];
  if (FAILURE_MARKERS.some((m) => a.includes(m))) problems.push('ассистент ответил «Временный сбой»');
  if (a.length < minChars) problems.push(`ответ ${a.length} символов — меньше порога ${minChars}`);
  return problems;
}
