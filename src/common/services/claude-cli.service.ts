// src/common/services/claude-cli.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';

export interface ClaudeCliOptions {
  /** System prompt prepended to user message. Concatenated with prompt via SYSTEM marker. */
  system?: string;
  /** Model alias or full name. Defaults to claude-haiku-4-5. */
  model?: string;
  /** Timeout in ms. Default 60_000 (60s). */
  timeoutMs?: number;
}

@Injectable()
export class ClaudeCliService {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudeBin = process.env.CLAUDE_BIN ?? '/usr/bin/claude';

  /**
   * Run one-shot Claude prompt via OAuth and return text + cost.
   */
  async textWithCost(prompt: string, opts: ClaudeCliOptions = {}): Promise<{ text: string; costUsd: number }> {
    const res = await this.runRaw(prompt, opts);
    return { text: res.text, costUsd: res.costUsd };
  }

  /**
   * Run one-shot Claude prompt via OAuth (no API key required).
   * Returns the assistant's text response.
   * Throws on subprocess failure or non-zero exit.
   */
  async text(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
    const res = await this.runRaw(prompt, opts);
    return res.text;
  }

  private async runRaw(prompt: string, opts: ClaudeCliOptions): Promise<{ text: string; costUsd: number }> {
    const model = opts.model ?? 'claude-haiku-4-5';
    const timeoutMs = opts.timeoutMs ?? 60_000;

    // Compose final prompt: system + user (claude -p has no separate --system arg)
    const fullPrompt = opts.system
      ? `${opts.system}\n\n---\n\nUSER REQUEST:\n${prompt}`
      : prompt;

    const args = [
      '-p',
      fullPrompt,
      '--model', model,
      '--output-format', 'json',
      '--allowedTools', '',          // disable all built-in tools
      '--disallowedTools', 'all',
    ];

    return new Promise<{ text: string; costUsd: number }>((resolve, reject) => {
      const proc = spawn(this.claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        reject(new Error(`claude CLI timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      proc.stdout.on('data', (b) => { stdout += b.toString(); });
      proc.stderr.on('data', (b) => { stderr += b.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          this.logger.error(`claude CLI exit ${code}: ${stderr.slice(0, 400)}`);
          reject(new Error(`claude CLI exited with code ${code}: ${stderr.slice(0, 200)}`));
          return;
        }
        try {
          const json = JSON.parse(stdout);
          if (json.is_error) {
            reject(new Error(`claude CLI error: ${json.result ?? 'unknown'}`));
            return;
          }
          const text: string = json.result ?? '';
          const costUsd: number = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0;
          if (costUsd) {
            this.logger.debug(`claude CLI cost: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
          }
          resolve({ text, costUsd });
        } catch (e: any) {
          this.logger.error(`claude CLI parse error: ${e.message}, stdout: ${stdout.slice(0, 200)}`);
          reject(new Error(`claude CLI returned invalid JSON: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`claude CLI spawn error: ${err.message}`));
      });
    });
  }
}
