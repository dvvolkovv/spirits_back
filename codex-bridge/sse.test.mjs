import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleMessage, createAnthropicStream, createSseParser } from './sse.mjs';

function collector() {
  const writes = [];
  const stream = createAnthropicStream({
    model: 'gpt-6-astra',
    messageId: 'msg_test',
    write: (s) => writes.push(s),
  });
  return {
    stream,
    rawWrites: () => writes,
    events: () => writes.map((w) => {
      const m = /^event: (.+)\ndata: (.+)\n\n$/.exec(w);
      assert.ok(m, `bad SSE frame: ${JSON.stringify(w)}`);
      return JSON.parse(m[2]);
    }),
    types: () => writes.map((w) => /^event: (.+)\n/.exec(w)[1]),
  };
}

test('parser splits frames across chunks and parses data', () => {
  const got = [];
  const parser = createSseParser((ev) => got.push(ev));
  parser.push('event: response.created\ndata: {"response":{"id":"r1"}}\n\neve');
  parser.push('nt: response.completed\ndata: {"response":{"status":"completed"}}\n\n');
  assert.deepEqual(got, [
    { type: 'response.created', data: { response: { id: 'r1' } } },
    { type: 'response.completed', data: { response: { status: 'completed' } } },
  ]);
});

test('parser tolerates malformed data and missing event line', () => {
  const got = [];
  const parser = createSseParser((ev) => got.push(ev));
  parser.push('data: not-json\n\ndata: {"type":"response.created"}\n\n');
  assert.equal(got.length, 2);
  assert.deepEqual(got[0].data, {});
  assert.equal(got[1].type, 'response.created');
});

test('text response translates to full anthropic sequence', () => {
  const c = collector();
  const events = [
    { type: 'response.created', data: { response: { usage: { input_tokens: 11 } } } },
    { type: 'response.output_item.added', data: { output_index: 0, item: { type: 'message', role: 'assistant', content: [] } } },
    { type: 'response.content_part.added', data: { output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } } },
    { type: 'response.output_text.delta', data: { output_index: 0, delta: 'При' } },
    { type: 'response.output_text.delta', data: { output_index: 0, delta: 'вет' } },
    { type: 'response.output_item.done', data: { output_index: 0, item: { type: 'message' } } },
    { type: 'response.completed', data: { response: { status: 'completed', usage: { input_tokens: 11, output_tokens: 7 } } } },
  ];
  for (const ev of events) c.stream.handleEvent(ev);
  assert.deepEqual(c.types(), [
    'message_start',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ]);
  const evs = c.events();
  assert.equal(evs[0].message.id, 'msg_test');
  assert.equal(evs[0].message.model, 'gpt-6-astra');
  assert.equal(evs[0].message.usage.input_tokens, 11);
  assert.deepEqual(evs[1].content_block, { type: 'text', text: '' });
  assert.deepEqual(evs[2].delta, { type: 'text_delta', text: 'При' });
  assert.deepEqual(evs[4], { type: 'content_block_stop', index: 0 });
  assert.deepEqual(evs[5].delta, { stop_reason: 'end_turn', stop_sequence: null });
  assert.deepEqual(evs[5].usage, { input_tokens: 11, output_tokens: 7 });
});

test('function_call translates to tool_use block and stop_reason tool_use', () => {
  const c = collector();
  const events = [
    { type: 'response.created', data: { response: {} } },
    { type: 'response.output_item.added', data: { output_index: 0, item: { type: 'function_call', call_id: 'toolu_9', name: 'get_time' } } },
    { type: 'response.function_call_arguments.delta', data: { output_index: 0, delta: '{"tz":' } },
    { type: 'response.function_call_arguments.delta', data: { output_index: 0, delta: '"msk"}' } },
    { type: 'response.output_item.done', data: { output_index: 0, item: { type: 'function_call' } } },
    { type: 'response.completed', data: { response: { status: 'completed', usage: { output_tokens: 5 } } } },
  ];
  for (const ev of events) c.stream.handleEvent(ev);
  const evs = c.events();
  assert.deepEqual(evs[1].content_block, { type: 'tool_use', id: 'toolu_9', name: 'get_time', input: {} });
  assert.deepEqual(evs[2].delta, { type: 'input_json_delta', partial_json: '{"tz":' });
  assert.equal(evs.at(-2).delta.stop_reason, 'tool_use');
});

test('reasoning items are ignored entirely', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.output_item.added', data: { output_index: 0, item: { type: 'reasoning' } } });
  c.stream.handleEvent({ type: 'response.reasoning_summary_text.delta', data: { output_index: 0, delta: 'thinking...' } });
  c.stream.handleEvent({ type: 'response.output_item.done', data: { output_index: 0, item: { type: 'reasoning' } } });
  c.stream.handleEvent({ type: 'response.completed', data: { response: { status: 'completed' } } });
  assert.ok(!c.types().includes('content_block_start'));
  assert.equal(c.types().at(-2), 'message_delta');
});

test('incomplete maps to max_tokens; failed and error emit error events once', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.incomplete', data: { response: { status: 'incomplete', usage: { output_tokens: 99 } } } });
  assert.equal(c.events().at(-2).delta.stop_reason, 'max_tokens');

  const f = collector();
  f.stream.handleEvent({ type: 'response.failed', data: { response: { error: { message: 'boom' } } } });
  f.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  assert.deepEqual(f.types(), ['message_start', 'error']);
  assert.deepEqual(f.events()[1].error, { type: 'api_error', message: 'boom' });

  const e = collector();
  e.stream.handleEvent({ type: 'error', data: { code: 'rate_limit', message: 'slow down' } });
  assert.deepEqual(e.events()[1].error, { type: 'rate_limit', message: 'slow down' });
});

test('finishIfOpen closes dangling blocks and is idempotent after completion', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.content_part.added', data: { output_index: 0, part: { type: 'output_text', text: '' } } });
  c.stream.handleEvent({ type: 'response.output_text.delta', data: { output_index: 0, delta: 'partial' } });
  c.stream.finishIfOpen();
  c.stream.finishIfOpen();
  const t = c.types();
  assert.equal(t.filter((x) => x === 'message_stop').length, 1);
  assert.ok(t.includes('content_block_stop'));
});

test('assembleMessage builds one JSON message from text frames', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.created', data: { response: { usage: { input_tokens: 4 } } } });
  c.stream.handleEvent({ type: 'response.content_part.added', data: { output_index: 0, part: { type: 'output_text', text: '' } } });
  c.stream.handleEvent({ type: 'response.output_text.delta', data: { output_index: 0, delta: 'he' } });
  c.stream.handleEvent({ type: 'response.output_text.delta', data: { output_index: 0, delta: 'llo' } });
  c.stream.handleEvent({ type: 'response.completed', data: { response: { usage: { input_tokens: 4, output_tokens: 2 } } } });
  const message = assembleMessage(c.rawWrites());
  assert.equal(message.type, 'message');
  assert.equal(message.role, 'assistant');
  assert.equal(message.stop_reason, 'end_turn');
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }]);
  assert.deepEqual(message.usage, { input_tokens: 4, output_tokens: 2 });
});

test('assembleMessage parses tool input JSON and throws on error frames', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.output_item.added', data: { output_index: 0, item: { type: 'function_call', call_id: 'toolu_1', name: 'get_time' } } });
  c.stream.handleEvent({ type: 'response.function_call_arguments.delta', data: { output_index: 0, delta: '{"tz":' } });
  c.stream.handleEvent({ type: 'response.function_call_arguments.delta', data: { output_index: 0, delta: '"msk"}' } });
  c.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  const message = assembleMessage(c.rawWrites());
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'toolu_1', name: 'get_time', input: { tz: 'msk' } }]);
  assert.equal(message.stop_reason, 'tool_use');

  const e = collector();
  e.stream.handleEvent({ type: 'response.failed', data: { response: { error: { message: 'boom' } } } });
  assert.throws(() => assembleMessage(e.rawWrites()), /boom/);
});

test('события после завершения потока не эмитят кадры после message_stop', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.created', data: { response: {} } });
  c.stream.handleEvent({ type: 'response.content_part.added', data: { output_index: 0, part: { type: 'output_text', text: '' } } });
  c.stream.handleEvent({ type: 'response.completed', data: { response: { status: 'completed' } } });
  const before = c.types();
  assert.equal(before.at(-1), 'message_stop');
  // upstream после completed шлёт дубликаты — клиент не должен получить кадры после message_stop
  c.stream.handleEvent({ type: 'response.content_part.added', data: { output_index: 1, part: { type: 'output_text', text: '' } } });
  c.stream.handleEvent({ type: 'response.output_text.delta', data: { output_index: 1, delta: 'поздно' } });
  c.stream.handleEvent({ type: 'response.output_item.added', data: { output_index: 2, item: { type: 'function_call', call_id: 'toolu_late', name: 'f' } } });
  assert.deepEqual(c.types(), before);
});

test('parser принимает CRLF-разделители, в том числе разорванные между чанками', () => {
  const got = [];
  const parser = createSseParser((ev) => got.push(ev));
  parser.push('event: response.created\r\ndata: {"a":1}\r\n\r\nevent: response.completed\r\ndata: {"b":2}\r\n\r\n');
  assert.deepEqual(got, [
    { type: 'response.created', data: { a: 1 } },
    { type: 'response.completed', data: { b: 2 } },
  ]);

  // граница чанков между \r и \n разделителя — оба события всё равно распознаются
  const got2 = [];
  const p2 = createSseParser((ev) => got2.push(ev));
  p2.push('event: response.created\r\ndata: {"a":1}\r');
  assert.equal(got2.length, 0); // хвостовой \r неоднозначен — откладываем до следующего push
  p2.push('\n\r\nevent: response.completed\r\ndata: {"b":2}\r\n\r\n');
  assert.deepEqual(got2, [
    { type: 'response.created', data: { a: 1 } },
    { type: 'response.completed', data: { b: 2 } },
  ]);
});

test('assembleMessage приводит не-объектный JSON аргументов к {}', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.output_item.added', data: { output_index: 0, item: { type: 'function_call', call_id: 'toolu_x', name: 'f' } } });
  c.stream.handleEvent({ type: 'response.function_call_arguments.delta', data: { output_index: 0, delta: 'null' } });
  c.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  const message = assembleMessage(c.rawWrites());
  assert.deepEqual(message.content[0].input, {});
});

test('error с вложенным error (так шлёт бэкенд codex) отдаёт настоящий текст и код', () => {
  // 16.11.2026 на релее: бэкенд codex прислал сбой во вложенном error, а мост
  // искал поля на верхнем уровне — CLI получил пустую заглушку «Upstream error».
  const c = collector();
  c.stream.handleEvent({ type: 'error', data: { type: 'error', error: {
    type: 'invalid_request_error', code: 'context_length_exceeded', message: 'input too long',
  } } });
  assert.deepEqual(c.types(), ['message_start', 'error']);
  assert.deepEqual(c.events()[1].error, { type: 'context_length_exceeded', message: 'input too long' });
  assert.equal(c.stream.failureCode, 'context_length_exceeded');

  const noCode = collector();
  noCode.stream.handleEvent({ type: 'error', data: { type: 'error', error: { type: 'invalid_request_error', message: 'bad schema' } } });
  assert.deepEqual(noCode.events()[1].error, { type: 'invalid_request_error', message: 'bad schema' });
});

test('response.failed с кодом отдаёт его типом ошибки и в failureCode', () => {
  const c = collector();
  c.stream.handleEvent({ type: 'response.failed', data: { response: { error: { code: 'server_error', message: 'oops' } } } });
  assert.deepEqual(c.events()[1].error, { type: 'server_error', message: 'oops' });
  assert.equal(c.stream.failureCode, 'server_error');
});

test('failureCode: null без сбоя, api_error без кода, unknown для кода, негодного в журнал', () => {
  const ok = collector();
  ok.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  assert.equal(ok.stream.failureCode, null);

  const bare = collector();
  bare.stream.handleEvent({ type: 'error', data: { type: 'error' } });
  assert.deepEqual(bare.events()[1].error, { type: 'api_error', message: 'Upstream error' });
  assert.equal(bare.stream.failureCode, 'api_error');

  const weird = collector();
  weird.stream.handleEvent({ type: 'error', data: { code: 'код с пробелами', message: 'x' } });
  assert.equal(weird.stream.failureCode, 'unknown');
});

// Так upstream отдаёт поиск (живая проба релея 19.11.2026, include
// web_search_call.action.sources): готовый item в output_item.done.
const webSearchDone = (overrides = {}) => ({
  type: 'response.output_item.done',
  data: {
    output_index: 0,
    item: {
      type: 'web_search_call',
      id: 'ws_1',
      status: 'completed',
      action: {
        type: 'search',
        query: 'погода Горячий Ключ',
        queries: ['погода Горячий Ключ'],
        sources: [
          { type: 'url', url: 'https://meteoinfo.ru/gk' },
          { type: 'url', url: 'https://pogoda.mail.ru/gk', title: 'Погода Mail' },
        ],
      },
      ...overrides,
    },
  },
});

test('web_search_call → server_tool_use и web_search_tool_result, как серверный поиск Anthropic', () => {
  const c = collector();
  const events = [
    { type: 'response.created', data: { response: {} } },
    { type: 'response.output_item.added', data: { output_index: 0, item: { type: 'web_search_call', id: 'ws_1', status: 'in_progress' } } },
    { type: 'response.web_search_call.searching', data: { output_index: 0, item_id: 'ws_1' } },
    webSearchDone(),
    { type: 'response.output_item.added', data: { output_index: 1, item: { type: 'message', content: [] } } },
    { type: 'response.content_part.added', data: { output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } } },
    { type: 'response.output_text.delta', data: { output_index: 1, delta: 'Завтра +12' } },
    { type: 'response.output_item.done', data: { output_index: 1, item: { type: 'message' } } },
    { type: 'response.completed', data: { response: { status: 'completed' } } },
  ];
  for (const ev of events) c.stream.handleEvent(ev);
  const message = assembleMessage(c.rawWrites());
  assert.deepEqual(message.content, [
    { type: 'server_tool_use', id: 'srvtoolu_ws_1', name: 'web_search', input: { query: 'погода Горячий Ключ' } },
    {
      type: 'web_search_tool_result',
      tool_use_id: 'srvtoolu_ws_1',
      content: [
        { type: 'web_search_result', url: 'https://meteoinfo.ru/gk', title: 'https://meteoinfo.ru/gk' },
        { type: 'web_search_result', url: 'https://pogoda.mail.ru/gk', title: 'Погода Mail' },
      ],
    },
    { type: 'text', text: 'Завтра +12' },
  ]);
  assert.equal(message.stop_reason, 'end_turn');
});

test('упавший поиск — web_search_tool_result с ошибкой; open_page и прочие шаги чтения — без блоков', () => {
  const failed = collector();
  failed.stream.handleEvent(webSearchDone({ status: 'failed', action: undefined }));
  failed.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  const [use, result] = assembleMessage(failed.rawWrites()).content;
  assert.equal(use.type, 'server_tool_use');
  assert.deepEqual(result.content, { type: 'web_search_tool_result_error', error_code: 'unavailable' });

  const page = collector();
  page.stream.handleEvent(webSearchDone({ action: { type: 'open_page', url: 'https://meteoinfo.ru/gk' } }));
  page.stream.handleEvent({ type: 'response.completed', data: { response: {} } });
  assert.ok(!page.types().includes('content_block_start'));
});
