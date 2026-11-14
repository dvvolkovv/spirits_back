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
