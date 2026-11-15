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

export function messagesToInput(messages) {
  const input = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const textType = role === 'user' ? 'input_text' : 'output_text';
    const parts = [];
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
        } else if (block.type === 'image'
          && block.source?.type === 'base64'
          && typeof block.source.data === 'string') {
          const media = typeof block.source.media_type === 'string' ? block.source.media_type : 'image/png';
          parts.push({
            type: 'input_image',
            image_url: `data:${media};base64,${block.source.data}`,
            detail: 'auto',
          });
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
          let output = '';
          if (typeof block.content === 'string') output = block.content;
          else if (Array.isArray(block.content)) {
            output = block.content
              .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text)
              .join('\n');
          }
          input.push({
            type: 'function_call_output',
            call_id: typeof block.tool_use_id === 'string' ? block.tool_use_id : '',
            output,
          });
        }
        // thinking и прочие блоки сознательно пропускаются
      }
    }
    flushParts();
  }
  return input;
}

export function toolsToFunctions(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({
      type: 'function',
      name: t.name,
      description: typeof t.description === 'string' ? t.description : '',
      parameters: t.input_schema && typeof t.input_schema === 'object'
        ? t.input_schema
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
  if (typeof anthropic.max_tokens === 'number' && Number.isFinite(anthropic.max_tokens)) {
    payload.max_output_tokens = Math.max(anthropic.max_tokens, MIN_OUTPUT_TOKENS);
  }
  return payload;
}
