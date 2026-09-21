export interface EditorDraft {
  title: string;
  body: string;
  imagePrompt: string;
}

/**
 * Релей иногда оборачивает JSON в markdown-забор или добавляет вежливую
 * обвязку до и после. Разбираем терпимо, но отсутствие полей — ошибка:
 * пустой пост лучше не выпускать вовсе, чем выпустить наполовину.
 */
export function parseEditorReply(raw: string): EditorDraft {
  const text = (raw || '').trim();
  if (!text) throw new Error('blog: пустой ответ редактора');

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : sliceOuterObject(text);
  if (!candidate) throw new Error('blog: не нашёл JSON в ответе редактора');

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw new Error('blog: не нашёл JSON в ответе редактора');
  }

  for (const field of ['title', 'body', 'imagePrompt'] as const) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw new Error(`blog: в ответе редактора нет поля ${field}`);
    }
  }

  return {
    title: parsed.title.trim(),
    body: parsed.body.trim(),
    imagePrompt: parsed.imagePrompt.trim(),
  };
}

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
