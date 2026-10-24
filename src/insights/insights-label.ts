import { deidentify } from './deidentify';
import { cleanLine, parseModelJson } from './insights-text';
import { FRICTION_TYPES, type Conversation, type FrictionType, type Label } from './insights.types';

export const LABEL_MODEL = 'claude-haiku-4-5';
export const LABEL_BATCH = 8;
export const MAX_CONVERSATION_CHARS = 12_000;
const ASSISTANT_HEAD = 400;
const ASSISTANT_TAIL = 200;

export const LABEL_SYSTEM = `Ты помогаешь команде Linkeon находить затыки продукта в разговорах пользователей с AI-ассистентами.
Затык — место, где человек не получил того, за чем пришёл. Типы:
- missing — просит то, чего в Linkeon нет (функцию, интеграцию, формат);
- confused — не находит функцию, путает похожие разделы, не понимает, как сделать;
- assistant — ассистент ответил неверно, отказал без причины, обещал и не сделал, ответил не по своей роли;
- failure — технический сбой: пустой ответ, обрыв, ошибка инструмента;
- money — непонятное списание, не получилось пополнить, «дорого»;
- silent — человек переспрашивает, повторяет вопрос, пишет «?» без ответа, бросает разговор сразу после ответа.

Правила:
- Отмечай только явные затыки. Обычный удачный разговор — пустой список items.
- about — суть своими словами, до 140 знаков, в продуктовых терминах. Без цитат: слова людей — только своими словами; в «ёлочках» можно лишь короткие названия разделов и кнопок. Без имён, без чисел, без деталей, по которым можно узнать человека, его дело или его здоровье. Про здоровье и психологию — не глубже темы («вопрос о здоровье»).
- Тексты уже обезличены: метки [имя], [телефон], [почта], [ссылка: …], [число] не раскрывай и не повторяй.
- severity: 1 — мелочь, 2 — мешает, 3 — человек ушёл ни с чем.

Ответь ТОЛЬКО JSON-массивом, без пояснений:
[{"conv": <номер разговора>, "items": [{"type": "<тип>", "about": "<суть>", "severity": 1}]}]`;

export interface LabelInput {
  person: number;
  conversation: Conversation;
}

function clipAssistant(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= ASSISTANT_HEAD + ASSISTANT_TAIL + 50) return text;
  return `${chars.slice(0, ASSISTANT_HEAD).join('')} […] ${chars.slice(-ASSISTANT_TAIL).join('')}`;
}

/** Разговор текстом для модели: обезличен, ответы ассистента сокращены, не длиннее MAX_CONVERSATION_CHARS. */
export function renderConversation(c: Conversation, names: readonly string[]): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of c.turns) {
    const body = deidentify(t.role === 'assistant' ? clipAssistant(t.text) : t.text, names);
    const line = `${t.role === 'user' ? 'Человек' : 'Ассистент'}: ${body}`;
    if (used + line.length > MAX_CONVERSATION_CHARS) {
      lines.push('[…дальше разговор обрезан…]');
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

export function buildLabelPrompt(batch: readonly LabelInput[], namesOf: (userId: string) => readonly string[]): string {
  return batch
    .map(
      (b, i) =>
        `Разговор ${i + 1} (ассистент «${b.conversation.assistant}»):\n${renderConversation(b.conversation, namesOf(b.conversation.userId))}`,
    )
    .join('\n\n');
}

/**
 * Разбор ответа разметки. null — ответ не по форме (повод повторить вызов);
 * [] — затыков нет. Человек и ассистент берутся из пачки, а не из ответа:
 * модель знает только номер разговора.
 */
export function parseLabels(text: string, batch: readonly LabelInput[]): Label[] | null {
  const data = parseModelJson(text);
  if (!Array.isArray(data)) return null;
  const out: Label[] = [];
  for (const row of data as any[]) {
    const input = batch[Number(row?.conv) - 1];
    if (!input || !Array.isArray(row?.items)) continue;
    for (const item of row.items) {
      const type = item?.type as FrictionType;
      if (!FRICTION_TYPES.includes(type)) continue;
      const about = cleanLine(item?.about, 140);
      if (!about) continue;
      const sev = Number(item?.severity);
      out.push({
        person: input.person,
        assistant: input.conversation.assistant,
        type,
        about,
        severity: sev === 1 || sev === 3 ? sev : 2,
      });
    }
  }
  return out;
}
