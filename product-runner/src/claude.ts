import { spawn } from 'child_process';

export type NDJsonEvent =
  | { type: 'begin' }
  | { type: 'item'; content: string }
  | { type: 'tool_start'; tool: string; input: any }
  | { type: 'tool_result'; tool: string; result: any }
  | { type: 'end'; usage?: { input: number; output: number; total: number } }
  | { type: 'error'; message: string };

/**
 * Переводит stream-json от `claude -p` в NDJSON-протокол, который уже понимает
 * фронт (`begin | item | tool_start | tool_result | end | error`).
 *
 * Такой же транслятор есть в бэкенде (spirits_back/src/chat/claude-agent.event-translator.ts),
 * и переиспользовать его нельзя намеренно: он держит состояние (соответствие
 * tool_use_id → имя инструмента) в пределах одного хода, а на бэкенд события
 * приезжают отдельными HTTP-запросами — состояние не переживёт ни рестарт, ни
 * второй инстанс. Здесь раннер спавнит claude сам и инстанс транслятора живёт
 * ровно столько, сколько идёт один ход — дублирование тут дешевле, чем
 * тащить состояние через границу процессов на чужой машине.
 */
export class ClaudeTranslator {
  private toolNames = new Map<string, string>();
  private buffer = '';

  translate(event: any): NDJsonEvent[] {
    if (!event || typeof event !== 'object') return [];

    if (event.type === 'system' && event.subtype === 'init') {
      return [{ type: 'begin' }];
    }

    if (event.type === 'stream_event') {
      const inner = event.event;
      if (inner?.type === 'content_block_delta' && inner.delta?.type === 'text_delta') {
        return [{ type: 'item', content: String(inner.delta.text ?? '') }];
      }
      return [];
    }

    if (event.type === 'assistant') {
      const out: NDJsonEvent[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_use') {
          // Запоминаем имя по id: событие tool_result (в событии user ниже)
          // отдаёт только id, имени в нём нет вовсе.
          this.toolNames.set(block.id, block.name);
          out.push({ type: 'tool_start', tool: block.name, input: block.input });
        }
      }
      return out;
    }

    if (event.type === 'user') {
      const out: NDJsonEvent[] = [];
      for (const block of event.message?.content ?? []) {
        if (block.type === 'tool_result') {
          out.push({
            type: 'tool_result',
            tool: this.toolNames.get(block.tool_use_id) ?? 'unknown',
            result: block.content,
          });
        }
      }
      return out;
    }

    if (event.type === 'result') {
      const input = Number(event.usage?.input_tokens ?? 0);
      const output = Number(event.usage?.output_tokens ?? 0);
      return [{ type: 'end', usage: { input, output, total: input + output } }];
    }

    return [];
  }

  /** Достаёт целые строки из потока, придерживая хвост до следующего чанка. */
  takeLines(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() ?? '';
    return lines.filter((l) => l.trim().length > 0);
  }
}

export function translateEvent(translator: ClaudeTranslator, chunk: string): NDJsonEvent[] {
  const out: NDJsonEvent[] = [];
  for (const line of translator.takeLines(chunk)) {
    try {
      out.push(...translator.translate(JSON.parse(line)));
    } catch {
      // Строка не JSON — CLI иногда пишет в stdout служебные сообщения
      // помимо stream-json, ход из-за этого падать не должен.
    }
  }
  return out;
}

export interface RunClaudeInput {
  claudeBin: string;
  cwd: string;
  prompt: string;
  sessionId?: string | null;
  timeoutMs: number;
  onEvents: (events: NDJsonEvent[]) => void;
}

/**
 * Спавнит `claude -p` и переводит его stdout в NDJSON-события через
 * ClaudeTranslator. Аргументы идут массивом в spawn, а не строкой в shell —
 * промпт приходит от клиента продукта напрямую, и без этого символы вроде
 * `; rm -rf /` в промпте исполнились бы как отдельная команда. Та же защита,
 * что в git.ts для сообщения коммита, и здесь она важнее.
 */
export async function runClaude(input: RunClaudeInput): Promise<{ ok: boolean; error?: string }> {
  const args = ['-p', input.prompt, '--output-format', 'stream-json', '--verbose'];
  if (input.sessionId) args.push('--resume', input.sessionId);

  return new Promise((resolve) => {
    const child = spawn(input.claudeBin, args, { cwd: input.cwd });
    const translator = new ClaudeTranslator();
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve({ ok: false, error: `Ход не уложился в ${Math.round(input.timeoutMs / 60000)} минут` });
    }, input.timeoutMs);

    child.stdout.on('data', (d) => input.onEvents(translateEvent(translator, d.toString())));
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim().slice(0, 2000) || `claude exited ${code}` });
    });

    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
  });
}
