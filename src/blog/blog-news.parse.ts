export interface NewsPick {
  theme: string;
  headline: string;
}

/**
 * Разбор ответа отборщика новостей.
 *
 * Терпим к обвязке ровно так же, как `parseEditorReply`: релей любит
 * обернуть JSON в markdown-забор или добавить вежливую фразу до и после.
 * Переиспользовать тот разбор нельзя — у него другие обязательные поля.
 *
 * Разница в строгости принципиальная: пустой `picks` — это НОРМАЛЬНЫЙ ответ
 * («рассказывать нечего»), а не ошибка. А вот пустая строка или текст без
 * JSON — ошибка: молчание релея и осознанный отказ выбирать это разные
 * события, и сводить их в пустой список значило бы не заметить сломанный
 * отбор.
 */
export function parseNewsSelection(raw: string): NewsPick[] {
  const text = (raw || '').trim();
  if (!text) throw new Error('blog: пустой ответ отбора новостей');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : sliceOuterObject(text);
  if (!candidate) throw new Error('blog: не нашёл JSON в ответе отбора новостей');

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('blog: не нашёл JSON в ответе отбора новостей');
  }

  if (!Array.isArray(parsed?.picks)) {
    throw new Error('blog: в ответе отбора нет списка picks');
  }

  // Кривой пункт молча выбрасываем, годные оставляем. Направление намеренно
  // в сторону «меньше новостей»: пункт без строки про пользу — это пункт,
  // по которому редактору нечего писать.
  return parsed.picks
    .map((p: any) => ({ theme: str(p?.theme), headline: str(p?.headline) }))
    .filter((p: NewsPick) => p.theme && p.headline);
}

const str = (v: any): string => (typeof v === 'string' ? v.trim() : '');

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
