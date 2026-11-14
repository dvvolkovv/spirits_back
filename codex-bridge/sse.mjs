import { randomUUID } from 'node:crypto';

export function createSseParser(onEvent) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      // SSE допускает CRLF; хвостовой \r неоднозначен (начало разделителя \r\n\r\n
      // или данные) — откладываем разбор до следующего push.
      if (buffer.endsWith('\r')) return;
      let m;
      while ((m = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const raw = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        let type;
        const dataLines = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (type === undefined && dataLines.length === 0) continue;
        let data = {};
        try {
          data = JSON.parse(dataLines.join('\n'));
        } catch {
          // data остаётся {} — событие обработается по типу
        }
        onEvent({ type: type ?? data.type, data });
      }
    },
  };
}

export function createAnthropicStream({ model, messageId = `msg_${randomUUID()}`, write }) {
  let started = false;
  let finished = false;
  let blockIndex = 0;
  let sawFunctionCall = false;
  let inputTokens = 0;
  let outputTokens = 0;
  const blocks = new Map(); // upstream output_index → anthropic index блока

  const emit = (type, payload) => {
    write(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  function start() {
    if (started) return;
    started = true;
    emit('message_start', {
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens, output_tokens: 0 },
      },
    });
  }
  function openBlock(contentBlock, outputIdx) {
    start();
    if (blocks.has(outputIdx)) closeBlock(outputIdx);
    const index = blockIndex++;
    blocks.set(outputIdx, index);
    emit('content_block_start', { index, content_block: contentBlock });
  }
  function deltaBlock(outputIdx, delta) {
    const index = blocks.get(outputIdx);
    if (index === undefined) return;
    emit('content_block_delta', { index, delta });
  }
  function closeBlock(outputIdx) {
    const index = blocks.get(outputIdx);
    if (index === undefined) return;
    blocks.delete(outputIdx);
    emit('content_block_stop', { index });
  }
  function finish(stopReason) {
    if (finished) return;
    finished = true;
    for (const outputIdx of [...blocks.keys()]) closeBlock(outputIdx);
    start();
    emit('message_delta', {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    });
    emit('message_stop', {});
  }
  function fail(message, type = 'api_error') {
    if (finished) return;
    finished = true;
    start();
    emit('error', { error: { type, message } });
  }

  return {
    handleEvent({ type, data }) {
      if (finished) return; // после message_stop никаких кадров — дубликаты upstream игнорируем
      switch (type) {
        case 'response.created':
          if (typeof data.response?.usage?.input_tokens === 'number') {
            inputTokens = data.response.usage.input_tokens;
          }
          start();
          break;
        case 'response.output_item.added':
          if (data.item?.type === 'function_call') {
            sawFunctionCall = true;
            openBlock({
              type: 'tool_use',
              id: data.item.call_id ?? data.item.id ?? `call_${data.output_index}`,
              name: typeof data.item.name === 'string' ? data.item.name : '',
              input: {},
            }, data.output_index);
          }
          // message/reasoning items: текстовый блок открывает content_part.added
          break;
        case 'response.content_part.added':
          if (data.part?.type === 'output_text') {
            openBlock({ type: 'text', text: typeof data.part.text === 'string' ? data.part.text : '' }, data.output_index);
          }
          break;
        case 'response.output_text.delta':
          deltaBlock(data.output_index, { type: 'text_delta', text: data.delta ?? '' });
          break;
        case 'response.function_call_arguments.delta':
          deltaBlock(data.output_index, { type: 'input_json_delta', partial_json: data.delta ?? '' });
          break;
        case 'response.output_item.done':
          closeBlock(data.output_index);
          break;
        case 'response.completed': {
          const usage = data.response?.usage;
          if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
          finish(sawFunctionCall ? 'tool_use' : 'end_turn');
          break;
        }
        case 'response.incomplete': {
          const usage = data.response?.usage;
          if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
          finish('max_tokens');
          break;
        }
        case 'response.failed':
          fail(data.response?.error?.message ?? 'Upstream response failed');
          break;
        case 'error':
          fail(data.message ?? 'Upstream error', typeof data.code === 'string' ? data.code : 'api_error');
          break;
        default:
          break; // response.in_progress, *.done, reasoning-события
      }
    },
    finishIfOpen() {
      if (!finished) finish(sawFunctionCall ? 'tool_use' : 'end_turn');
    },
    failOpen(message) {
      if (!finished) fail(message);
    },
    get isFinished() {
      return finished;
    },
  };
}

// stream:false — собрать единый Anthropic-JSON из тех же SSE-фреймов.
export function assembleMessage(frames) {
  let message = null;
  const content = [];
  const jsonBuffers = new Map(); // index блока → накопленный partial_json
  for (const frame of frames) {
    const m = /^event: (.+)\ndata: (.+)\n\n$/.exec(frame);
    if (!m) continue;
    let ev;
    try {
      ev = JSON.parse(m[2]);
    } catch {
      continue;
    }
    switch (ev.type) {
      case 'message_start':
        message = { ...ev.message };
        break;
      case 'content_block_start':
        content[ev.index] = { ...ev.content_block };
        break;
      case 'content_block_delta': {
        const block = content[ev.index];
        if (!block) break;
        if (ev.delta?.type === 'text_delta') {
          block.text = (block.text ?? '') + (ev.delta.text ?? '');
        } else if (ev.delta?.type === 'input_json_delta') {
          jsonBuffers.set(ev.index, (jsonBuffers.get(ev.index) ?? '') + (ev.delta.partial_json ?? ''));
        }
        break;
      }
      case 'message_delta':
        if (message) {
          message.stop_reason = ev.delta?.stop_reason ?? message.stop_reason;
          message.stop_sequence = ev.delta?.stop_sequence ?? null;
          if (ev.usage) message.usage = { ...message.usage, ...ev.usage };
        }
        break;
      case 'error':
        throw Object.assign(
          new Error(ev.error?.message ?? 'Stream error'),
          { safeType: ev.error?.type ?? 'api_error' },
        );
      default:
        break; // content_block_stop, message_stop
    }
  }
  if (!message) {
    throw Object.assign(new Error('Empty upstream stream'), { safeType: 'api_error' });
  }
  for (const [index, partial] of jsonBuffers) {
    const block = content[index];
    if (!block) continue;
    try {
      const parsed = JSON.parse(partial || '{}');
      // Anthropic tool_use.input обязан быть объектом — null/строка/массив → {}
      block.input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      block.input = {}; // неполный/битый JSON аргументов — пустой объект
    }
  }
  message.content = content.filter((block) => block !== undefined);
  return message;
}
