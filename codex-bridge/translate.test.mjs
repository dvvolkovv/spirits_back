import test from 'node:test';
import assert from 'node:assert/strict';
import {
  messagesToInput,
  systemToInstructions,
  TOOL_IMAGE_NOTE,
  toolsToFunctions,
  translateRequest,
} from './translate.mjs';

test('system string and text blocks become joined instructions', () => {
  assert.equal(systemToInstructions('  hello  '), 'hello');
  assert.equal(
    systemToInstructions([
      { type: 'text', text: 'a', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'b' },
      { type: 'other', text: 'skip' },
    ]),
    'a\n\nb',
  );
  assert.equal(systemToInstructions(undefined), '');
});

test('user text and base64 image become one message item', () => {
  const input = messagesToInput([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      ],
    },
  ]);
  assert.deepEqual(input, [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'hi' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' },
      ],
    },
  ]);
});

test('assistant text uses output_text; string content supported', () => {
  const input = messagesToInput([
    { role: 'user', content: 'привет' },
    { role: 'assistant', content: [{ type: 'text', text: 'здорово' }] },
  ]);
  assert.deepEqual(input[0].content, [{ type: 'input_text', text: 'привет' }]);
  assert.deepEqual(input[1].content, [{ type: 'output_text', text: 'здорово' }]);
});

test('tool_use becomes function_call, tool_result becomes function_call_output, order preserved', () => {
  const input = messagesToInput([
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'tool_use', id: 'toolu_1', name: 'get_time', input: { tz: 'msk' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: '12:00' }] },
      ],
    },
  ]);
  assert.deepEqual(input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
    { type: 'function_call', call_id: 'toolu_1', name: 'get_time', arguments: '{"tz":"msk"}' },
    { type: 'function_call_output', call_id: 'toolu_1', output: '12:00' },
  ]);
});

test('tool_result with string content and tool_use without input are handled', () => {
  const input = messagesToInput([
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'x' }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
  ]);
  assert.equal(input[0].arguments, '{}');
  assert.equal(input[1].output, 'ok');
});

test('thinking blocks are dropped', () => {
  const input = messagesToInput([
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }] },
  ]);
  assert.deepEqual(input, [
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
  ]);
});

test('tools map to function schemas with safe defaults', () => {
  const tools = toolsToFunctions([
    { name: 'a', description: 'd', input_schema: { type: 'object', properties: { x: { type: 'string' } } }, cache_control: {} },
    { name: 'b' },
    { description: 'no name' },
  ]);
  assert.deepEqual(tools, [
    { type: 'function', name: 'a', description: 'd', parameters: { type: 'object', properties: { x: { type: 'string' } } } },
    { type: 'function', name: 'b', description: '', parameters: { type: 'object', properties: {} } },
  ]);
});

test('translateRequest builds full Responses payload', () => {
  const payload = translateRequest({
    model: 'gpt-6-astra',
    max_tokens: 1024,
    system: 'sys',
    thinking: { type: 'enabled', budget_tokens: 2048 },
    tools: [{ name: 'a', input_schema: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'hi' }],
    stop_sequences: ['x'],
  }, { model: 'gpt-6-astra', reasoningEffort: 'high' });
  assert.deepEqual(payload, {
    model: 'gpt-6-astra',
    instructions: 'sys',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    tools: [{ type: 'function', name: 'a', description: '', parameters: { type: 'object', properties: {} } }],
    stream: true,
    store: false,
    reasoning: { effort: 'high' },
    max_output_tokens: 1024,
  });
});

test('translateRequest omits optional fields when absent', () => {
  const payload = translateRequest({ model: 'gpt-6-astra', messages: [] });
  assert.equal('instructions' in payload, false);
  assert.equal('tools' in payload, false);
  assert.equal('max_output_tokens' in payload, false);
  assert.equal(payload.reasoning.effort, 'medium');
});

test('small max_tokens is floored to MIN_OUTPUT_TOKENS (reasoning shares the budget)', () => {
  const small = translateRequest({ model: 'gpt-6-astra', max_tokens: 16, messages: [] });
  assert.equal(small.max_output_tokens, 1024);
  const large = translateRequest({ model: 'gpt-6-astra', max_tokens: 8000, messages: [] });
  assert.equal(large.max_output_tokens, 8000);
});

test('картинки из tool_result доходят до модели: сообщением пользователя сразу после выходов', () => {
  // 16.11.2026 на релее: ассистент читал загруженные фото инструментом Read, а мост
  // оставлял от tool_result только текст — модель видела пустой результат и
  // перечитывала файлы по кругу. input_image допустим только в сообщении
  // пользователя, а выходы функций должны идти подряд за вызовами.
  const input = messagesToInput([
    { role: 'assistant', content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/u/a.jpg' } },
      { type: 'tool_use', id: 'toolu_2', name: 'Read', input: { file_path: '/u/b.jpg' } },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAA' } },
      ] },
      { type: 'tool_result', tool_use_id: 'toolu_2', content: [
        { type: 'text', text: 'meta' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'BBB' } },
      ] },
    ] },
  ]);
  assert.deepEqual(input.map((i) => i.type),
    ['function_call', 'function_call', 'function_call_output', 'function_call_output', 'message']);
  assert.equal(input[2].output, TOOL_IMAGE_NOTE);
  assert.equal(input[3].output, `meta\n${TOOL_IMAGE_NOTE}`);
  assert.deepEqual(input[4], { type: 'message', role: 'user', content: [
    { type: 'input_text', text: 'Image from tool result toolu_1:' },
    { type: 'input_image', image_url: 'data:image/jpeg;base64,AAA', detail: 'auto' },
    { type: 'input_text', text: 'Image from tool result toolu_2:' },
    { type: 'input_image', image_url: 'data:image/png;base64,BBB', detail: 'auto' },
  ] });
});

test('схемы инструментов без строковых pattern: OpenAI отвергает lookaround и роняет весь запрос', () => {
  // 16.11.2026 на релее: «Invalid JSON schema: regex lookaround is not supported.
  // Found at $.properties.to.pattern» — из-за одного MCP-инструмента не прошёл ни один ход.
  const schema = {
    type: 'object',
    properties: {
      to: { type: 'string', format: 'email', pattern: '^(?!\\.)(?!.*\\.\\.)[^@]+@[^@]+$' },
      pattern: { type: 'string', description: 'свойство с таким именем — у Grep, его не трогаем' },
      list: { type: 'array', items: { type: 'string', pattern: '^a' } },
      mode: { type: 'object', const: { pattern: 'значение, а не ключевое слово' } },
      default: { type: 'string', pattern: '^(?=x)' },
    },
    required: ['to', 'pattern'],
  };
  const [fn] = toolsToFunctions([{ name: 'send', input_schema: schema }]);
  assert.deepEqual(fn.parameters, {
    type: 'object',
    properties: {
      to: { type: 'string', format: 'email' },
      pattern: { type: 'string', description: 'свойство с таким именем — у Grep, его не трогаем' },
      list: { type: 'array', items: { type: 'string' } },
      mode: { type: 'object', const: { pattern: 'значение, а не ключевое слово' } },
      // параметр с именем ключевого слова-значения — всё равно схема
      default: { type: 'string' },
    },
    required: ['to', 'pattern'],
  });
  // исходная схема CLI не мутируется
  assert.equal(schema.properties.to.pattern, '^(?!\\.)(?!.*\\.\\.)[^@]+@[^@]+$');
});

test('серверный web_search Anthropic (подзапрос WebSearch у CLI) — встроенный web_search upstream с источниками', () => {
  // 19.11.2026: мост делал из него функцию без параметров, модель «вызывала»
  // её впустую, и каждый WebSearch у ассистентов на Codex возвращал пустой список.
  const payload = translateRequest({
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: 'Perform a web search for the query: погода' }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', allowed_domains: [], blocked_domains: [], max_uses: 8 }],
    tool_choice: { type: 'tool', name: 'web_search' },
  });
  assert.deepEqual(payload.tools, [{ type: 'web_search' }]);
  assert.deepEqual(payload.include, ['web_search_call.action.sources']);
});

test('обычные инструменты рядом с web_search остаются функциями, include без поиска не ставится', () => {
  const tools = toolsToFunctions([
    { type: 'web_search_20250305', name: 'web_search' },
    { name: 'Read', input_schema: { type: 'object', properties: {} } },
  ]);
  assert.deepEqual(tools, [
    { type: 'web_search' },
    { type: 'function', name: 'Read', description: '', parameters: { type: 'object', properties: {} } },
  ]);
  const plain = translateRequest({ model: 'gpt-6-astra', messages: [], tools: [{ name: 'Read' }] });
  assert.equal('include' in plain, false);
});
