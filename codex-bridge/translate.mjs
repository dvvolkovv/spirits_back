export const DEFAULT_UPSTREAM_MODEL = 'gpt-6-astra';

// У Responses API max_output_tokens включает reasoning-токены: маленький бюджет
// Anthropic max_tokens привёл бы к response.incomplete с пустым текстом.
export const MIN_OUTPUT_TOKENS = 1024;

export function systemToInstructions(system) {
  if (typeof system === 'string') return system.trim();
  if (Array.isArray(system)) {
    return system
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n\n')
      .trim();
  }
  return '';
}

// Пометка в выходе функции: сама картинка идёт следом отдельным сообщением.
export const TOOL_IMAGE_NOTE = '[image attached in the next user message]';

function toInputImage(block) {
  if (block?.type !== 'image' || block.source?.type !== 'base64' || typeof block.source.data !== 'string') return null;
  const media = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
  return { type: 'input_image', image_url: `data:${media};base64,${block.source.data}`, detail: 'auto' };
}

export function messagesToInput(messages) {
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const textType = role === 'user' ? 'input_text' : 'output_text';
    const parts = [];
    // Картинки из tool_result (Read по фото): input_image допустим только в
    // сообщении пользователя, а выходы функций должны идти подряд за вызовами —
    // поэтому картинки копятся и уходят одним сообщением после всех выходов.
    // Без этого модель видела пустой результат (релей, 16.11.2026).
    const toolImages = [];
    const flushParts = () => {
      if (parts.length) {
        input.push({ type: 'message', role, content: parts.splice(0, parts.length) });
      }
    };
    const content = message.content;
    if (typeof content === 'string') {
      parts.push({ type: textType, text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: textType, text: block.text });
        } else if (block.type === 'image') {
          const image = toInputImage(block);
          if (image) parts.push(image);
        } else if (block.type === 'tool_use') {
          flushParts();
          input.push({
            type: 'function_call',
            call_id: typeof block.id === 'string' ? block.id : `call_${input.length}`,
            name: typeof block.name === 'string' ? block.name : '',
            arguments: JSON.stringify(block.input && typeof block.input === 'object' ? block.input : {}),
          });
        } else if (block.type === 'tool_result') {
          flushParts();
          const callId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          let output = '';
          let withImage = false;
          if (typeof block.content === 'string') output = block.content;
          else if (Array.isArray(block.content)) {
            output = block.content
              .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('\n');
            for (const c of block.content) {
              const image = toInputImage(c);
              if (!image) continue;
              toolImages.push({ type: 'input_text', text: `Image from tool result ${callId}:` }, image);
              withImage = true;
            }
          }
          if (withImage) output = output ? `${output}\n${TOOL_IMAGE_NOTE}` : TOOL_IMAGE_NOTE;
          input.push({ type: 'function_call_output', call_id: callId, output });
        }
        // thinking и прочие блоки сознательно пропускаются
      }
    }
    flushParts();
    if (toolImages.length) input.push({ type: 'message', role: 'user', content: toolImages });
  }
  return input;
}

// Ключевые слова со значениями-данными: внутри них «pattern» — не ключевое слово.
const SCHEMA_VALUE_KEYWORDS = new Set(['enum', 'const', 'default', 'examples']);
// Словари «имя → схема»: имена в них — имена параметров, а не ключевые слова.
const SCHEMA_MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

// OpenAI проверяет регулярки в схемах функций и отвергает часть синтаксиса
// («regex lookaround is not supported»), причём одна такая схема роняет весь
// запрос со всеми инструментами — 16.11.2026 так на релее не прошёл ни один ход
// (параметр to стороннего MCP-инструмента). pattern — только подсказка модели,
// вход всё равно проверяет сам инструмент, поэтому строковые pattern снимаем все.
// Свойство с именем pattern (у Grep) — объект, а не строка, и остаётся.
export function stripSchemaPatterns(schema) {
  if (Array.isArray(schema)) return schema.map(stripSchemaPatterns);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'pattern' && typeof value === 'string') continue;
    if (SCHEMA_VALUE_KEYWORDS.has(key)) {
      out[key] = value;
    } else if (SCHEMA_MAP_KEYWORDS.has(key) && value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, sub]) => [name, stripSchemaPatterns(sub)]));
    } else {
      out[key] = stripSchemaPatterns(value);
    }
  }
  return out;
}

// Серверный поиск Anthropic (им WebSearch CLI делает подзапрос) — у upstream это
// встроенный инструмент, а не функция: функцию без параметров модель «вызывала»
// впустую, и WebSearch у ассистентов на Codex всегда был пуст (19.11.2026).
// allowed_domains/blocked_domains не переносим — поиск идёт без фильтра доменов.
const ANTHROPIC_WEB_SEARCH = /^web_search_\d+$/;

export function toolsToFunctions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => (ANTHROPIC_WEB_SEARCH.test(t.type ?? '') ? { type: 'web_search' } : {
      type: 'function',
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema && typeof t.input_schema === 'object'
        ? stripSchemaPatterns(t.input_schema)
        : { type: 'object', properties: {} },
    }));
}

export function translateRequest(anthropic, {
  model = DEFAULT_UPSTREAM_MODEL,
  reasoningEffort = 'medium',
} = {}) {
  const payload = {
    model,
    input: messagesToInput(Array.isArray(anthropic.messages) ? anthropic.messages : []),
    stream: true,
    store: false,
    reasoning: { effort: reasoningEffort },
  };
  const instructions = systemToInstructions(anthropic.system);
  if (instructions) payload.instructions = instructions;
  const tools = toolsToFunctions(anthropic.tools);
  if (tools.length) payload.tools = tools;
  // Без include web_search_call приходит без ссылок — CLI нечего показать.
  if (tools.some((t) => t.type === 'web_search')) payload.include = ['web_search_call.action.sources'];
  if (typeof anthropic.max_tokens === 'number' && Number.isFinite(anthropic.max_tokens)) {
    payload.max_output_tokens = Math.max(anthropic.max_tokens, MIN_OUTPUT_TOKENS);
  }
  return payload;
}
