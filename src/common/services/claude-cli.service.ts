// src/common/services/claude-cli.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from './pg.service';
import { neutralizeAtMentions, stripWordJoiner } from '../agent-guards';

export interface ClaudeCliProgressEvent {
  kind: 'tool_use';
  name: string;
}

export interface ClaudeCliOptions {
  /** System prompt prepended to user message. Concatenated with prompt via SYSTEM marker. */
  system?: string;
  /** Model alias or full name. Defaults to claude-haiku-4-5. */
  model?: string;
  /** Timeout in ms. Default 60_000 (60s). Set to 0 to disable timeout completely. */
  timeoutMs?: number;
  /** Файлы для multimodal-вызова (фото, PDF, txt). Пути к локальным файлам.
   *  При наличии — добавляются как @<path> в конец промпта и включается tool Read. */
  attachments?: string[];
  /** Колбэк прогресса. Если задан — CLI переключается в stream-json и колбэк
   *  вызывается на каждое tool_use событие. Подходит для UX-индикации
   *  (например edit-message в Telegram). */
  onProgress?: (event: ClaudeCliProgressEvent) => void;
  /** Рабочая директория Claude. По умолчанию os.tmpdir(). Для агентных
   *  сценариев (Bash/Write/Edit) передавай изолированный sandbox-dir. */
  cwd?: string;
  /** Полностью переопределяет --allowedTools (это АВТО-ОДОБРЕНИЕ, а не набор
   *  доступного). По умолчанию: 'Read' если есть attachments, иначе ''.
   *  Передавай явный список для агентного режима. */
  allowedTools?: string;
  /** ДОСТУПНЫЙ набор встроенных тулов → CLI-флаг `--tools`. Именно он решает,
   *  что модель ВООБЩЕ может вызвать (в отличие от allowedTools, который лишь
   *  снимает запрос на подтверждение уже доступного).
   *  По умолчанию (caller не передал ни tools, ни attachments): '' — все
   *  встроенные тулы выключены. При наличии attachments и без явного tools: 'Read'.
   *  Передавай явный список (например 'Read,WebSearch,WebFetch') для нужного режима;
   *  'default' у CLI означает «все тулы» — использовать осознанно. */
  tools?: string;
}

@Injectable()
export class ClaudeCliService {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudeBin = process.env.CLAUDE_BIN ?? '/usr/bin/claude';

  // Direct PG insert (not EventsService) because ClaudeCliService lives in
  // CommonModule and EventsService lives in EventsModule which imports
  // CommonModule — injecting EventsService here creates a module cycle.
  // The DB schema is identical (events table), so direct insert is equivalent.
  constructor(private readonly pg?: PgService) {}

  private trackCallEvent(opts: { costUsd: number; model: string; durationMs: number; ok: boolean }) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('claude_cli_call', $1::jsonb)`,
      [JSON.stringify({
        cost_usd: opts.costUsd,
        model: opts.model,
        duration_ms: opts.durationMs,
        ok: opts.ok,
      })],
    ).catch((e: any) => this.logger.warn(`claude_cli_call event insert failed: ${e.message}`));
  }

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
    // Одноразовый каталог под копии вложений (создаётся только когда он нужен —
    // см. ниже). Снимается в finally, чтобы не копить чужие файлы в tmp.
    let perCallTmpDir: string | null = null;
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDir = dir; });
    } finally {
      if (perCallTmpDir) {
        try { fs.rmSync(perCallTmpDir, { recursive: true, force: true }); }
        catch (e: any) { this.logger.warn(`per-call tmp cleanup failed (${perCallTmpDir}): ${e.message}`); }
      }
    }
  }

  private spawnClaude(
    prompt: string,
    opts: ClaudeCliOptions,
    registerTmpDir: (dir: string) => void,
  ): Promise<{ text: string; costUsd: number }> {
    const model = opts.model ?? 'claude-haiku-4-5';
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const streaming = !!opts.onProgress;

    const hasAttachments = (opts.attachments?.length ?? 0) > 0;

    // ── cwd и ссылки на вложения ──────────────────────────────────────────
    // Безопасность (25.09.2026): вложения раньше подставлялись в промпт как
    // @<АБСОЛЮТНЫЙ путь>. CLI разворачивает @-упоминания на этапе сборки промпта
    // (инлайнит содержимое файла) — без cwd-ограничения; для наших же файлов это
    // норма, но абсолютный путь мы дальше не эмитим сами. Если caller НЕ задал
    // cwd — Read не должен дотянуться никуда, кроме вложений: заводим одноразовый
    // per-call каталог, копируем туда вложения и ссылаемся по ОТНОСИТЕЛЬНОМУ
    // имени. Если cwd задан (агентный/sandbox-режим), вложения там же — ссылаемся
    // относительно cwd.
    let spawnCwd: string;
    let refNames: string[] = [];
    if (hasAttachments && !opts.cwd) {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cli-'));
      registerTmpDir(tmpDir);
      spawnCwd = tmpDir;
      const used = new Set<string>();
      for (const src of opts.attachments!) {
        let base = path.basename(src) || 'file';
        // Разводим коллизии имён: два вложения с одинаковым basename не должны
        // затирать друг друга в одноразовом каталоге.
        if (used.has(base)) {
          const ext = path.extname(base);
          base = `${path.basename(base, ext)}-${used.size}${ext}`;
        }
        used.add(base);
        try {
          fs.copyFileSync(src, path.join(tmpDir, base));
          refNames.push(base);
        } catch (e: any) {
          this.logger.warn(`attachment copy failed (${src}): ${e.message}`);
        }
      }
    } else {
      // Neutral cwd by default: backend runs in /home/dvolkov/spirits_back, whose
      // ~40KB CLAUDE.md the CLI would auto-discover and prepend to EVERY one-shot
      // prompt — irrelevant context that inflated input and tripled VPM latency.
      // Caller may override cwd для агентного sandbox-режима.
      spawnCwd = opts.cwd ?? os.tmpdir();
      if (hasAttachments) {
        // cwd задан caller-ом (вложения уже внутри него): ссылаемся относительно
        // cwd, если файл действительно там; иначе — абсолютным путём как раньше
        // (в наших флоу этого не случается, вложения лежат в sandbox=cwd).
        refNames = opts.attachments!.map((p) => {
          const rel = path.relative(spawnCwd, p);
          return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : p;
        });
      }
    }

    // Compose final prompt: system + user (claude -p has no separate --system arg).
    //
    // Безопасность: обезвреживаем @-упоминания в тексте от caller-а (и prompt, и
    // system) ДО того, как допишем СВОИ ссылки на вложения. Наши `@<имя>` идут
    // после нейтрализации и остаются живыми — CLI их развернёт и подтянет файл.
    // Без этого `@/home/dvolkov/spirits_back/.env` в реплике пользователя
    // инлайнился бы в промпт мимо всех ограничений тулов.
    const safePrompt = neutralizeAtMentions(prompt);
    let userBlock = safePrompt;
    if (hasAttachments && refNames.length) {
      const refs = refNames.map(r => `@${r}`).join(' ');
      userBlock = `${safePrompt}\n\nПриложенные файлы: ${refs}`;
    }
    const safeSystem = opts.system ? neutralizeAtMentions(opts.system) : opts.system;
    const fullPrompt = safeSystem
      ? `${safeSystem}\n\n---\n\nUSER REQUEST:\n${userBlock}`
      : userBlock;

    // --allowedTools — это АВТО-ОДОБРЕНИЕ уже доступного. Дефолт как раньше.
    const allowedTools = opts.allowedTools !== undefined
      ? opts.allowedTools
      : (hasAttachments ? 'Read' : '');

    // --tools — ДОСТУПНЫЙ набор встроенных тулов. Ключевая защита: без явного
    // значения и без вложений отдаём '' — все встроенные тулы выключены (иначе
    // CLI даёт полный набор Claude Code, и «безобидный» Bash вроде echo
    // выполняется в -p без подтверждения). При вложениях без явного tools — 'Read',
    // чтобы CLI мог открыть присланный файл, и не более того.
    const tools = opts.tools !== undefined
      ? opts.tools
      : (hasAttachments ? 'Read' : '');

    const args = [
      '-p',
      fullPrompt,
      '--model', model,
      '--output-format', streaming ? 'stream-json' : 'json',
      '--allowedTools', allowedTools,
      // Пустая строка обязана уйти отдельным argv-элементом '' (spawn так и
      // делает — не через шелл): '--tools' '' = «встроенных тулов нет».
      '--tools', tools,
      '--strict-mcp-config',         // load NO MCP servers (none passed) — these
                                     // one-shot calls use no tools; skipping MCP
                                     // startup avoids stalls in the pm2 env.
    ];
    // stream-json требует --verbose, иначе CLI отвергает комбинацию.
    if (streaming) args.push('--verbose');

    return new Promise<{ text: string; costUsd: number }>((resolve, reject) => {
      const proc = spawn(this.claudeBin, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: spawnCwd });
      let stdout = '';
      let stderr = '';

      // Stream-mode accumulators (заполняются по мере прихода NDJSON).
      let streamLineBuf = '';
      let streamResultText = '';
      let streamCostUsd = 0;
      let streamDurationMs = 0;
      let streamIsError = false;
      let streamErrorDetail = '';

      let timer: NodeJS.Timeout | null = null;
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          proc.kill('SIGTERM');
          reject(new Error(`claude CLI timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }

      proc.stdout.on('data', (b) => {
        const chunk = b.toString();
        stdout += chunk;
        if (!streaming) return;
        streamLineBuf += chunk;
        let nl: number;
        while ((nl = streamLineBuf.indexOf('\n')) >= 0) {
          const line = streamLineBuf.slice(0, nl).trim();
          streamLineBuf = streamLineBuf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try { ev = JSON.parse(line); } catch { continue; }
          if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            for (const c of ev.message.content) {
              if (c?.type === 'tool_use' && typeof c.name === 'string' && opts.onProgress) {
                try { opts.onProgress({ kind: 'tool_use', name: c.name }); } catch { /* user callback safety */ }
              }
            }
          }
          if (ev.type === 'result') {
            streamResultText = typeof ev.result === 'string' ? ev.result : '';
            streamCostUsd = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0;
            streamDurationMs = Number(ev.duration_ms) || 0;
            if (ev.is_error) {
              streamIsError = true;
              streamErrorDetail = String(ev.result ?? ev.error ?? 'unknown');
            }
          }
        }
      });
      proc.stderr.on('data', (b) => { stderr += b.toString(); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);

        // Stream mode: всё уже распарсено по ходу, просто возвращаем накопленное.
        if (streaming) {
          if (code !== 0) {
            this.logger.error(`claude CLI exit ${code}: stderr=${stderr.slice(0, 300)} stdout=${stdout.slice(0, 300)}`);
            const detail = streamErrorDetail || stderr.trim() || stdout.trim().slice(0, 400);
            reject(new Error(`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}`));
            return;
          }
          if (streamIsError) {
            reject(new Error(`claude CLI error: ${streamErrorDetail}`));
            return;
          }
          if (streamCostUsd) {
            this.logger.debug(`claude CLI cost: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);
          }
          this.trackCallEvent({
            costUsd: streamCostUsd,
            model,
            durationMs: streamDurationMs,
            ok: true,
          });
          // stripWordJoiner на выходе: U+2060, которым мы обезвреживали
          // @-упоминания во входе, не должен доехать до пользователя.
          resolve({ text: stripWordJoiner(streamResultText), costUsd: streamCostUsd });
          return;
        }

        // Non-streaming path: одноразовый JSON parse на выходе.
        if (code !== 0) {
          // Реальная причина часто уходит в stdout (CLI с --output-format json
          // печатает {is_error, result} и при ненулевом коде, либо текстовую
          // ошибку авторизации). stderr нередко пуст — поэтому подмешиваем stdout.
          let detail = stderr.trim();
          if (!detail && stdout.trim()) {
            try {
              const j = JSON.parse(stdout);
              detail = String(j.result ?? j.error ?? stdout).slice(0, 400);
            } catch { detail = stdout.trim().slice(0, 400); }
          }
          this.logger.error(`claude CLI exit ${code}: stderr=${stderr.slice(0, 300)} stdout=${stdout.slice(0, 300)}`);
          reject(new Error(`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}`));
          return;
        }
        try {
          const json = JSON.parse(stdout);
          if (json.is_error) {
            reject(new Error(`claude CLI error: ${json.result ?? 'unknown'}`));
            return;
          }
          const text: string = stripWordJoiner(json.result ?? '');
          const costUsd: number = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0;
          if (costUsd) {
            this.logger.debug(`claude CLI cost: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
          }
          this.trackCallEvent({
            costUsd,
            model,
            durationMs: Number(json.duration_ms) || 0,
            ok: true,
          });
          resolve({ text, costUsd });
        } catch (e: any) {
          this.logger.error(`claude CLI parse error: ${e.message}, stdout: ${stdout.slice(0, 200)}`);
          reject(new Error(`claude CLI returned invalid JSON: ${e.message}`));
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        reject(new Error(`claude CLI spawn error: ${err.message}`));
      });
    });
  }
}
