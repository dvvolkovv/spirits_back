// src/chat/claude-agent.event-translator.ts
/**
 * Translates Claude Agent SDK events to the NDJSON protocol that
 * ChatInterface.tsx expects.
 *
 * Stateful — tracks tool_use_id → tool_name mappings emitted in `assistant`
 * events so we can attach the right tool name to subsequent `user/tool_result`
 * events (SDK only gives us the id there, not the name).
 *
 * Per-request instance. Reset via constructor.
 */

export type NDJsonEvent =
  | { type: 'begin' }
  | { type: 'item'; content: string }
  | { type: 'tool_start'; tool: string; input: any }
  | { type: 'tool_result'; tool: string; result: any }
  | { type: 'end'; usage?: any }
  | { type: 'error'; message: string };

const MCP_PREFIX_RE = /^mcp__[^_]+__/;

function stripMcpPrefix(name: string): string {
  return name.replace(MCP_PREFIX_RE, '');
}

export class SdkEventTranslator {
  private toolUseIdToName = new Map<string, string>();

  translate(event: any): NDJsonEvent[] {
    if (!event || typeof event !== 'object') return [];

    const t = event.type;

    // 1. system/init → begin
    if (t === 'system' && event.subtype === 'init') {
      return [{ type: 'begin' }];
    }

    // 2. stream_event — extract text deltas from content_block_delta
    if (t === 'stream_event') {
      const inner = event.event;
      if (inner?.type === 'content_block_delta') {
        const delta = inner.delta;
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          return [{ type: 'item', content: delta.text }];
        }
      }
      return [];
    }

    // 3. assistant — full turn. Capture tool_use blocks: emit tool_start + remember id→name
    if (t === 'assistant') {
      const out: NDJsonEvent[] = [];
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
            const shortName = stripMcpPrefix(block.name);
            this.toolUseIdToName.set(block.id, shortName);
            out.push({ type: 'tool_start', tool: shortName, input: block.input ?? {} });
          }
          // text blocks already streamed via stream_event text_delta — skip
          // thinking blocks — skip (internal model reasoning, not user-facing)
        }
      }
      return out;
    }

    // 4. user — tool_result echo. Extract id, look up name, parse JSON content
    if (t === 'user') {
      const out: NDJsonEvent[] = [];
      const content = event.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            const toolName = this.toolUseIdToName.get(block.tool_use_id) ?? 'unknown';
            // block.content is an array of {type:'text', text: JSON_STRING} or a string
            let resultJson: any = null;
            try {
              let rawText = '';
              if (Array.isArray(block.content)) {
                rawText = block.content
                  .map((c: any) => (typeof c?.text === 'string' ? c.text : ''))
                  .join('');
              } else if (typeof block.content === 'string') {
                rawText = block.content;
              }
              resultJson = rawText ? JSON.parse(rawText) : null;
            } catch {
              // Tool result wasn't valid JSON — pass the raw text through
              const fallback = Array.isArray(block.content)
                ? block.content.map((c: any) => c?.text ?? '').join('')
                : String(block.content ?? '');
              resultJson = { error: fallback.slice(0, 500) };
            }
            // Skip the built-in ToolSearch tool_result — irrelevant for frontend
            if (toolName === 'ToolSearch') continue;
            out.push({ type: 'tool_result', tool: toolName, result: resultJson });
          }
        }
      }
      return out;
    }

    // 5. result → end
    if (t === 'result') {
      return [{ type: 'end', usage: event.usage }];
    }

    return [];
  }
}
