// src/common/services/claude-cli.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
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

/** HTTP MCP-сервер в формате конфига CLI (--mcp-config). */
export interface ClaudeCliMcpHttpServer {
  type: 'http';
  url: string;
  headers?: Record<string, string>;
  /** Потолок одного вызова инструмента, мс (схема CLI 2.1.280: перекрывает
   *  MCP_TOOL_TIMEOUT, меньше 1000 игнорируется, прогресс его не продлевает). */
  timeout?: number;
}

/** Префикс одноразового каталога с конфигом MCP (в нём токены). */
const MCP_CONFIG_DIR_PREFIX = 'claude-mcp-';

/**
 * Сколько живёт брошенный конфиг MCP до уборки при старте сервиса. Час — с
 * запасом дольше хода Маши (10 мин) и срока веб-токена (30 мин). Ход бота
 * может идти дольше, но CLI читает конфиг один раз на старте — снятый позже
 * файл ему уже не нужен.
 */
const MCP_CONFIG_STALE_MS = 60 * 60 * 1000;

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
   *  доступного). По умолчанию: '' ВСЕГДА — в т.ч. при attachments. Голое 'Read'
   *  в allowedTools одобряет чтение ЛЮБОГО пути, а не только внутри cwd; Read
   *  внутри cwd в -p и так идёт без подтверждения. Передавай явный список только
   *  осознанно (и без голого Read). */
  allowedTools?: string;
  /** ДОСТУПНЫЙ набор встроенных тулов → CLI-флаг `--tools`. Именно он решает,
   *  что модель ВООБЩЕ может вызвать (в отличие от allowedTools, который лишь
   *  снимает запрос на подтверждение уже доступного).
   *  По умолчанию (caller не передал ни tools, ни attachments): '' — все
   *  встроенные тулы выключены. При наличии attachments и без явного tools: 'Read'.
   *  Передавай явный список (например 'Read,WebSearch,WebFetch') для нужного режима;
   *  'default' у CLI означает «все тулы» — использовать осознанно. */
  tools?: string;
  /** MCP-серверы на ЭТОТ вызов (ключ — имя сервера: инструменты придут как
   *  mcp__<ключ>__<имя>). Пишутся в одноразовый файл конфига с правами 0600 —
   *  заголовки несут токены, в argv им нельзя (аргументы процесса видит `ps`);
   *  файл снимается после вызова. --strict-mcp-config остаётся: кроме
   *  переданных, серверов нет.
   *  Автоодобрения сервис НЕ добавляет: имена нужных MCP-инструментов caller
   *  кладёт в allowedTools сам — без этого в -p вызов отклоняется
   *  («...you haven't granted it yet»). */
  mcpServers?: Record<string, ClaudeCliMcpHttpServer>;
}

@Injectable()
export class ClaudeCliService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudeBin = process.env.CLAUDE_BIN ?? '/usr/bin/claude';

  // Direct PG insert (not EventsService) because ClaudeCliService lives in
  // CommonModule and EventsService lives in EventsModule which imports
  // CommonModule — injecting EventsService here creates a module cycle.
  // The DB schema is identical (events table), so direct insert is equivalent.
  constructor(private readonly pg?: PgService) {}

  /**
   * Конфиг вызова с токеном снимается в finally, но процесс, убитый посреди
   * хода (рестарт, OOM, kill -9), finally не выполняет — файл с живым токеном
   * остался бы в tmp. При старте сервиса такие каталоги старше часа снимаются.
   * Сбой уборки старт не роняет.
   */
  onModuleInit(): void {
    try {
      const removed = ClaudeCliService.sweepStaleMcpConfigDirs(os.tmpdir(), MCP_CONFIG_STALE_MS);
      if (removed.length) this.logger.log(`removed ${removed.length} stale MCP config dir(s)`);
    } catch (e: any) {
      this.logger.warn(`stale MCP config sweep failed: ${e?.message}`);
    }
  }

  /**
   * Снимает в root каталоги claude-mcp-XXXXXX старше maxAgeMs (по mtime —
   * каталог создаётся с файлом и больше не меняется). Только настоящие
   * каталоги: симлинк с тем же именем и обычный файл не трогаются (lstat).
   * Отдаёт снятые пути. Статический — чтобы проверяться на своём корне.
   */
  static sweepStaleMcpConfigDirs(root: string, maxAgeMs: number, now: number = Date.now()): string[] {
    let names: string[];
    try { names = fs.readdirSync(root); } catch { return []; }
    const removed: string[] = [];
    for (const name of names) {
      if (!name.startsWith(MCP_CONFIG_DIR_PREFIX)) continue;
      const full = path.join(root, name);
      try {
        const st = fs.lstatSync(full);
        if (!st.isDirectory() || now - st.mtimeMs <= maxAgeMs) continue;
        fs.rmSync(full, { recursive: true, force: true });
        removed.push(full);
      } catch { /* исчез между readdir и lstat, чужие права — не наше */ }
    }
    return removed;
  }

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
    // Одноразовые каталоги вызова (создаются только когда нужны — см. ниже):
    // копии вложений и конфиг MCP с токенами. Снимаются в finally — и на успехе,
    // и на падении, и по таймауту, — чтобы не копить в tmp ни чужих файлов, ни
    // живых токенов.
    const perCallTmpDirs: string[] = [];
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDirs.push(dir); });
    } finally {
      for (const dir of perCallTmpDirs) {
        try { fs.rmSync(dir, { recursive: true, force: true }); }
        catch (e: any) { this.logger.warn(`per-call tmp cleanup failed (${dir}): ${e.message}`); }
      }
    }
  }

  /**
   * Конфиг MCP на один вызов: свой каталог (mkdtemp, 0700) под os.tmpdir() и
   * файл 0600 в нём. Каталог регистрируется ДО записи, чтобы снялся и при
   * сбое самой записи.
   *
   * Не в cwd вызова: в агентном режиме (рабочая папка чата Telegram) модель
   * читает файлы cwd тулом Read, а в одноразовом каталоге вложений — тоже.
   * Отдельный каталог лежит рядом с ними, а не внутри. Нейтральным cwd вызову
   * с MCP служит не сам os.tmpdir() (каталог конфига оказался бы внутри), а
   * свой пустой claude-cwd-XXXXXX — см. spawnClaude.
   */
  private writeMcpConfig(
    servers: Record<string, ClaudeCliMcpHttpServer>,
    registerTmpDir: (dir: string) => void,
  ): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), MCP_CONFIG_DIR_PREFIX));
    registerTmpDir(dir);
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    return file;
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
    const hasMcp = !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;

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
      //
      // Вызов с MCP (Маша) получает не сам os.tmpdir(), а свой пустой
      // одноразовый каталог: каталог конфига с токеном лежит рядом, а не внутри
      // cwd, при любом наборе тулов. Снимается в finally, как и остальные.
      if (opts.cwd) {
        spawnCwd = opts.cwd;
      } else if (hasMcp) {
        spawnCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cwd-'));
        registerTmpDir(spawnCwd);
      } else {
        spawnCwd = os.tmpdir();
      }
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

    // --allowedTools — это АВТО-ОДОБРЕНИЕ уже доступного. Дефолт '' ВСЕГДА, в
    // том числе при вложениях. Раньше при attachments здесь стояло 'Read', но
    // голое правило Read одобряет чтение ЛЮБОГО пути, а не только внутри cwd:
    // ревью воспроизвело чтение канарейки вне одноразового каталога (мок + живой
    // haiku). Без правила Read внутри cwd в -p идёт без подтверждения (проверено
    // пробой), а Read наружу упирается в запрос разрешения и отклоняется.
    const allowedTools = opts.allowedTools !== undefined ? opts.allowedTools : '';

    // --tools — ДОСТУПНЫЙ набор встроенных тулов. Ключевая защита: без явного
    // значения и без вложений отдаём '' — все встроенные тулы выключены (иначе
    // CLI даёт полный набор Claude Code, и «безобидный» Bash вроде echo
    // выполняется в -p без подтверждения). При вложениях без явного tools — 'Read',
    // чтобы CLI мог открыть присланный файл, и не более того.
    const tools = opts.tools !== undefined
      ? opts.tools
      : (hasAttachments ? 'Read' : '');

    // MCP-серверы вызова — только файлом (токены в заголовках), см. writeMcpConfig.
    //
    // --tools и MCP (проба на CLI 2.1.280, 26.09.2026): `--tools` задаёт ТОЛЬКО
    // встроенный набор. С `--tools ""` и `--mcp-config` в init.tools остаётся
    // ровно mcp__products__manage_product, вызов проходит — отдельного флага
    // для MCP не нужно, и встроенные тулы остаются выключенными. Но без имени
    // инструмента в --allowedTools вызов в -p отклоняется (permission_denials),
    // поэтому имя кладёт в allowedTools caller.
    const mcpConfigPath = hasMcp ? this.writeMcpConfig(opts.mcpServers!, registerTmpDir) : null;

    const args = [
      '-p',
      fullPrompt,
      '--model', model,
      '--output-format', streaming ? 'stream-json' : 'json',
      '--allowedTools', allowedTools,
      // Пустая строка обязана уйти отдельным argv-элементом '' (spawn так и
      // делает — не через шелл): '--tools' '' = «встроенных тулов нет».
      '--tools', tools,
    ];
    // --mcp-config вариадический: следом обязан идти флаг, а не позиционный
    // аргумент, иначе CLI примет его за второй конфиг. Поэтому — перед
    // --strict-mcp-config. В argv — только путь, токены остаются в файле.
    if (mcpConfigPath) args.push('--mcp-config', mcpConfigPath);
    // Всегда: никаких MCP-серверов, кроме переданных в --mcp-config (без него —
    // ни одного). Разовым вызовам без MCP это ещё и экономит старт серверов,
    // который подвисал в окружении pm2.
    args.push('--strict-mcp-config');
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
