export interface EditorDraft {
  title: string;
  body: string;
  imagePrompt: string;
}

/**
 * Сколько символов сырого ответа редактора кладём в ошибку разбора.
 *
 * Ошибка уходит в `last_error` поста и в личку владельцу. Без начала ответа
 * причина отказа не видна нигде: кейсы про Романа и Лиану упали на проде с
 * голым «не нашёл JSON», и что редактор написал вместо поста — переспросил,
 * извинился, оборвался, — осталось догадкой. Трёхсот символов хватает, чтобы
 * это понять, и строка в админке остаётся строкой.
 */
export const RAW_SNIPPET_CHARS = 300;

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
  if (!candidate) throw parseFailure('blog: не нашёл JSON в ответе редактора', text);

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    throw parseFailure('blog: не нашёл JSON в ответе редактора', text);
  }
  // В заборе может оказаться и не объект: `null`, строка, массив.
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw parseFailure('blog: не нашёл JSON в ответе редактора', text);
  }

  for (const field of ['title', 'body', 'imagePrompt'] as const) {
    if (typeof parsed[field] !== 'string' || !parsed[field].trim()) {
      throw parseFailure(`blog: в ответе редактора нет поля ${field}`, text);
    }
  }

  return {
    title: parsed.title.trim(),
    body: parsed.body.trim(),
    imagePrompt: parsed.imagePrompt.trim(),
  };
}

/** Причина отказа плюс начало того, что редактор прислал вместо поста. */
function parseFailure(reason: string, text: string): Error {
  return new Error(`${reason}; начало ответа: «${rawSnippet(text)}»`);
}

/**
 * Одна строка — в админке `last_error` показывается строкой, — не длиннее
 * `RAW_SNIPPET_CHARS` символов. Режем по символам, а не по UTF-16: эмодзи на
 * границе иначе распался бы пополам и уехал в базу мусором.
 */
function rawSnippet(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  if (chars.length <= RAW_SNIPPET_CHARS) return chars.join('');
  return `${chars.slice(0, RAW_SNIPPET_CHARS).join('')}…`;
}

function sliceOuterObject(text: string): string | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}
