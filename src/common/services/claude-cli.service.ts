// src/common/services/claude-cli.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from './pg.service';
import { neutralizeAtMentions, stripWordJoiner } from '../agent-guards';
import { classifyLlmError, looksLikeCliRefusal } from '../llm-error';
import {
  QwenFallbackConfig,
  fallbackTimeoutMs,
  isFallbackWorthy,
  qwenModelFor,
  qwenSpawnEnv,
  readQwenFallbackConfig,
} from './qwen-fallback';

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
 * Постоянный пустой cwd вызовов с MCP без своего cwd (Маша). Один на все
 * вызовы: CLI заводит в ~/.claude/projects папку проекта на каждый новый cwd,
 * и одноразовый каталог на ход давал бы тысячи папок в сутки. Мы в него не
 * пишем и не удаляем его; уборка брошенных конфигов его не трогает.
 */
const EMPTY_CWD_NAME = 'linkeon-claude-empty';

/**
 * Сколько живёт брошенный конфиг MCP до уборки при старте сервиса. Час — с
 * запасом дольше хода Маши (10 мин) и срока веб-токена (30 мин). Ход бота
 * может идти дольше, но CLI читает конфиг один раз на старте — снятый позже
 * файл ему уже не нужен.
 */
const MCP_CONFIG_STALE_MS = 60 * 60 * 1000;

/** Модель и таймаут вызова, когда caller их не задал. */
const DEFAULT_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 60_000;

/** За какое окно fallbackStats() считает исходы запасного пути (для алерта). */
const FALLBACK_STATS_WINDOW_MS = 15 * 60_000;

/** Встроенные тулы без последствий: их вызов повтор на Qwen не запрещает —
 *  ни в stream-json (где вызов виден), ни вслепую в json-режиме. */
const SIDE_EFFECT_FREE_TOOLS: ReadonlySet<string> = new Set(['Read', 'WebSearch', 'WebFetch']);

/** Результат одного запуска CLI (внутренний): toolUsed — как у ClaudeCliCallError. */
interface CliRunResult {
  text: string;
  costUsd: number;
  toolUsed: boolean;
}

/**
 * Ошибка вызова CLI. toolUsed — модель успела вызвать инструмент с
 * последствиями (не Read/WebSearch/WebFetch) до сбоя; виден только в
 * stream-json. Такой вызов на Qwen не повторяется: инструмент с последствиями
 * (правка продукта, жалоба в поддержку) сработал бы дважды.
 */
export class ClaudeCliCallError extends Error {
  constructor(message: string, readonly toolUsed: boolean) {
    super(message);
    this.name = 'ClaudeCliCallError';
  }
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
  /** Куски текста ответа по мере генерации (проба без входа, src/guest-trial).
   *  Если задан — CLI идёт в stream-json с --include-partial-messages, и каждый
   *  text_delta уходит сюда; итоговый текст по-прежнему возвращает textWithCost.
   *  Такой вызов не повторяется на Qwen: показанный человеку текст повтор не
   *  заберёт обратно. */
  onTextDelta?: (text: string) => void;
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
  /** Только Claude, без запасного пути на Qwen. Для проверок живости Claude:
   *  с запасным путём они показывали бы «зелёный», когда Claude лежит. Сбой
   *  такого вызова предохранитель не открывает, успех — закрывает. */
  noFallback?: boolean;
  /** Выбор пользователя в админке (UserLlmProviderService): 'qwen' — вызов
   *  сразу на Qwen, без попытки Claude. Не авария: окно предохранителя и
   *  fallbackStats не трогаются. Без ключа и при noFallback — обычный Claude. */
  provider?: 'qwen';
}

@Injectable()
export class ClaudeCliService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudeBin = process.env.CLAUDE_BIN ?? '/usr/bin/claude';
  /** До какого момента (Date.now()) вызовы идут сразу на Qwen, не пробуя
   *  Claude: на 429/529 CLI сам долго повторяет запрос, и без окна каждый ход
   *  ждал бы этого заново. 0 — окно закрыто. */
  private breakerOpenUntil = 0;
  /** Когда окно открыли в последний раз. Успех вызова Claude, начатого раньше,
   *  окно не закрывает: он не говорит, что Claude ожил после того сбоя. */
  private breakerOpenedAt = 0;
  /** Исходы запасных вызовов за последние FALLBACK_STATS_WINDOW_MS. */
  private fallbackOutcomes: Array<{ at: number; ok: boolean }> = [];

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
      const removed = ClaudeCliService.sweepStaleMcpConfigDirs(this.tmpRoot(), MCP_CONFIG_STALE_MS);
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
      // Постоянный пустой cwd — не конфиг и не мусор, сколько бы ему ни было
      // лет. Префикс его и так не ловит; явная проверка — на случай, если
      // префикс когда-нибудь расширят.
      if (name === EMPTY_CWD_NAME) continue;
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

  /**
   * Корень временных каталогов вызова. Метод, а не прямой os.tmpdir(), — ради
   * тестов: у теста в jest своя копия process.env, и TMPDIR из неё до
   * os.tmpdir() не доходит.
   */
  private tmpRoot(): string {
    return os.tmpdir();
  }

  /**
   * cwd вызова с MCP, когда caller не дал своего (Маша): постоянный пустой
   * <tmpdir>/linkeon-claude-empty. Каталог конфига с токеном — отдельный,
   * на вызов (writeMcpConfig), и лежит рядом, а не внутри.
   *
   * Не годится (см. emptyCwdProblem) — вызов идёт в одноразовый claude-cwd-*,
   * который снимается после вызова, а в лог уходит причина: ход не должен
   * зависеть от чужого каталога в общем tmp.
   */
  private mcpNeutralCwd(registerTmpDir: (dir: string) => void): string {
    const dir = path.join(this.tmpRoot(), EMPTY_CWD_NAME);
    const problem = ClaudeCliService.emptyCwdProblem(dir);
    if (!problem) return dir;
    this.logger.warn(`${dir}: ${problem} — вызов идёт в одноразовый каталог`);
    const tmp = fs.mkdtempSync(path.join(this.tmpRoot(), 'claude-cwd-'));
    registerTmpDir(tmp);
    return tmp;
  }

  /**
   * null — каталог годится в cwd; иначе — чем не годится. При первом
   * обращении создаёт его (mkdir -p, 0700).
   *
   * Tmp общий для всех пользователей машины, а из cwd CLI сам подхватывает
   * CLAUDE.md и .claude/settings.json (в них бывают хуки). Поэтому каталог
   * обязан быть настоящим (lstat: симлинк — не каталог, даже если ведёт на
   * каталог), нашим, закрытым на запись для других и пустым.
   */
  private static emptyCwdProblem(dir: string): string | null {
    try {
      // Существующий каталог (и симлинк на каталог) mkdir -p пропускает молча,
      // файл на этом месте даёт EEXIST — уйдёт в catch.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const st = fs.lstatSync(dir);
      if (!st.isDirectory()) return 'не каталог (или симлинк)';
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      if (uid !== undefined && st.uid !== uid) return `чужой владелец (uid ${st.uid})`;
      if (st.mode & 0o022) return `запись открыта не только владельцу (${(st.mode & 0o777).toString(8)})`;
      if (fs.readdirSync(dir).length > 0) return 'не пуст';
      return null;
    } catch (e: any) {
      return `недоступен: ${e?.message}`;
    }
  }

  private trackCallEvent(opts: { costUsd: number; model: string; durationMs: number; ok: boolean; provider: 'claude' | 'qwen'; fallback: boolean }) {
    if (!this.pg) return;
    this.pg.query(
      `INSERT INTO events (name, props) VALUES ('claude_cli_call', $1::jsonb)`,
      [JSON.stringify({
        cost_usd: opts.costUsd,
        model: opts.model,
        duration_ms: opts.durationMs,
        ok: opts.ok,
        provider: opts.provider,
        fallback: opts.fallback,
      })],
    ).catch((e: any) => this.logger.warn(`claude_cli_call event insert failed: ${e.message}`));
  }

  /** Состояние запасного пути — для алерта мониторинга. */
  fallbackStats(now: number = Date.now()): {
    enabled: boolean; ok: number; failed: number; breakerOpenUntil: number; windowMs: number;
  } {
    this.pruneFallbackOutcomes(now);
    const ok = this.fallbackOutcomes.filter((o) => o.ok).length;
    return {
      enabled: !!readQwenFallbackConfig(),
      ok,
      failed: this.fallbackOutcomes.length - ok,
      windowMs: FALLBACK_STATS_WINDOW_MS, // за какое окно посчитаны ok/failed
      // Истёкшее окно — закрытое: 0, а не момент в прошлом.
      breakerOpenUntil: this.breakerOpenUntil > now ? this.breakerOpenUntil : 0,
    };
  }

  private noteFallbackOutcome(ok: boolean): void {
    const now = Date.now();
    this.fallbackOutcomes.push({ at: now, ok });
    this.pruneFallbackOutcomes(now);
  }

  private pruneFallbackOutcomes(now: number): void {
    const from = now - FALLBACK_STATS_WINDOW_MS;
    this.fallbackOutcomes = this.fallbackOutcomes.filter((o) => o.at >= from);
  }

  /**
   * Разовый запрос к Claude CLI: текст ответа и стоимость. При сбое доступа к
   * Claude ответ может дать запасной Qwen (см. runRaw).
   */
  async textWithCost(prompt: string, opts: ClaudeCliOptions = {}): Promise<{ text: string; costUsd: number }> {
    const res = await this.runRaw(prompt, opts);
    return { text: res.text, costUsd: res.costUsd };
  }

  /**
   * Разовый запрос к Claude CLI: текст ответа. При сбое доступа к Claude ответ
   * может дать запасной Qwen (см. runRaw).
   * Бросает при падении процесса или ненулевом коде выхода.
   */
  async text(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
    const res = await this.runRaw(prompt, opts);
    return res.text;
  }

  /**
   * Claude, при сбое доступа — тот же вызов на Qwen (spec
   * 2026-10-29-qwen-fallback-design.md). Без ключа QWEN_FALLBACK_API_KEY и с
   * noFallback — ровно прежнее поведение.
   */
  private async runRaw(prompt: string, opts: ClaudeCliOptions): Promise<CliRunResult> {
    const qwen = opts.noFallback ? null : readQwenFallbackConfig();
    // Выбор пользователя (админка): ответы сразу через Qwen, без попытки Claude.
    if (opts.provider === 'qwen') {
      if (qwen) return this.runForcedQwen(prompt, opts, qwen);
      if (!opts.noFallback) {
        this.logger.warn('Qwen выбран для пользователя, но ключ QWEN_FALLBACK_API_KEY не задан — вызов идёт на Claude');
      }
    }
    if (qwen && Date.now() < this.breakerOpenUntil) {
      return this.runOnQwen(prompt, opts, qwen, null);
    }
    const startedAt = Date.now();
    let res: CliRunResult;
    try {
      res = await this.runOnce(prompt, opts, null);
    } catch (e: any) {
      if (!qwen) throw e;
      const retryOpts = this.planQwenRetry(e, opts, qwen, startedAt);
      if (!retryOpts) throw e;
      return this.runOnQwen(prompt, retryOpts, qwen, e);
    }
    // Отказ CLI, пришедший обычным ответом (без is_error): с ключом — такой же
    // сбой доступа, как ошибка. Если ключа нет или повторить нельзя —
    // вызывающий получает тот же текст, что и раньше. Окно такой «успех» не
    // закрывает никогда (и у пробы с noFallback): Claude на деле не ответил.
    if (looksLikeCliRefusal(res.text)) {
      if (qwen) {
        const refusal = new ClaudeCliCallError(`claude CLI error: ${res.text.trim()}`, res.toolUsed);
        const retryOpts = this.planQwenRetry(refusal, opts, qwen, startedAt);
        if (retryOpts) return this.runOnQwen(prompt, retryOpts, qwen, refusal);
      }
      return res;
    }
    // Claude ответил (в том числе проба с noFallback) — окно закрыто. Кроме
    // успеха вызова, начатого до открытия окна: о Claude после того сбоя он
    // ничего не говорит.
    if (startedAt >= this.breakerOpenedAt) this.breakerOpenUntil = 0;
    return res;
  }

  /**
   * Сбой попытки Claude — ошибка или отказ, пришедший ответом. Подходящий вид
   * (вход, лимит, перегрузка) открывает окно, даже если сам вызов повторять
   * нельзя: это свидетельство «Claude сейчас недоступен», следующие вызовы
   * пойдут сразу на Qwen. Отдаёт опции запасного вызова, если его можно
   * повторить, иначе null.
   */
  private planQwenRetry(
    e: unknown,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig,
    startedAt: number,
  ): ClaudeCliOptions | null {
    const msg = String((e as any)?.message ?? e);
    if (!isFallbackWorthy(msg)) return null;
    const kind = classifyLlmError(msg).kind;
    this.breakerOpenedAt = Date.now();
    this.breakerOpenUntil = this.breakerOpenedAt + qwen.breakerMs;
    if (!this.mayRetryOnQwen(e, opts)) {
      this.logger.warn(`claude CLI: сбой доступа (${kind}) — окно запасного пути открыто, сам вызов не повторяется (инструменты): ${msg.slice(0, 200)}`);
      return null;
    }
    const qwenModel = qwenModelFor(opts.model ?? DEFAULT_MODEL, qwen.models);
    this.logger.warn(`claude CLI → запасной Qwen ${qwenModel} (${kind}): ${msg.slice(0, 200)}`);
    // Запасной вызов укладывается в остаток бюджета вызова, а не в полный.
    const timeoutMs = fallbackTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, Date.now() - startedAt);
    return { ...opts, timeoutMs };
  }

  /** Можно ли повторить на Qwen вызов, упавший по сбою доступа (вид сбоя
   *  planQwenRetry уже проверил): только если модель ещё ничего не сделала
   *  инструментами с последствиями. */
  private mayRetryOnQwen(e: unknown, opts: ClaudeCliOptions): boolean {
    if (e instanceof ClaudeCliCallError && e.toolUsed) return false;
    // Человек уже видит куски ответа — второй, другой ответ поверх них хуже ошибки.
    if (opts.onTextDelta) return false;
    // Без stream-json вызов инструмента не виден: вслепую повторяем, только
    // если последствий быть не может — нет MCP, а встроенные тулы лишь из
    // Read/WebSearch/WebFetch (Bash, Write, Edit, 'default' — нельзя).
    if (!opts.onProgress) {
      const hasMcp = !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
      const riskyTools = (opts.tools ?? '')
        .split(/[\s,]+/)
        .some((t) => t !== '' && !SIDE_EFFECT_FREE_TOOLS.has(t));
      if (hasMcp || riskyTools) return false;
    }
    return true;
  }

  /** Принудительный Qwen (выбор пользователя): окно предохранителя и
   *  fallbackStats не трогаются — это не авария, а выбор. */
  private async runForcedQwen(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig,
  ): Promise<CliRunResult> {
    try {
      return await this.runOnce(prompt, opts, qwen, false);
    } catch (qe: any) {
      const qmsg = String(qe?.message ?? qe);
      this.logger.error(`Qwen (выбран для пользователя) упал: ${qmsg.slice(0, 200)}`);
      throw new Error(`claude CLI не вызывался (выбран Qwen) | qwen: ${qmsg}`);
    }
  }

  private async runOnQwen(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig,
    claudeError: unknown | null,
  ): Promise<CliRunResult> {
    try {
      const res = await this.runOnce(prompt, opts, qwen);
      this.noteFallbackOutcome(true);
      return res;
    } catch (qe: any) {
      this.noteFallbackOutcome(false);
      // Любой сбой Qwen окно закрывает — не только «Qwen лежит» (ключ отозван,
      // кредиты кончились, 429 от Alibaba), но и таймаут длинного хода, отказ
      // на вложении и т.п.: держать окно на неработающем Qwen хуже, Claude мог
      // уже ожить. Цена осознанная: при шторме 529 у Claude сбой Qwen на
      // конкретном запросе вернёт следующие вызовы в долгие повторы CLI на Claude.
      this.breakerOpenUntil = 0;
      const qmsg = String(qe?.message ?? qe);
      this.logger.error(`запасной Qwen тоже упал: ${qmsg.slice(0, 200)}`);
      // Причина Claude — первой, чтобы её было видно в логе и тексте ошибки;
      // вид по classifyLlmError считается по всей строке (приоритет
      // weekly_limit → rate_limit → auth → …).
      const head = claudeError
        ? String((claudeError as any)?.message ?? claudeError)
        : 'claude CLI пропущен (окно запасного пути)';
      throw new Error(`${head} | qwen fallback: ${qmsg}`);
    }
  }

  /** Один запуск CLI: qwen = null — Claude, иначе — модель и окружение Alibaba. */
  private async runOnce(
    prompt: string,
    opts: ClaudeCliOptions,
    qwen: QwenFallbackConfig | null,
    fallback: boolean = qwen !== null,
  ): Promise<CliRunResult> {
    // Одноразовые каталоги вызова (создаются только когда нужны — см. ниже):
    // копии вложений и конфиг MCP с токенами. Снимаются в finally — и на успехе,
    // и на падении, и по таймауту, — чтобы не копить в tmp ни чужих файлов, ни
    // живых токенов. У запасного запуска — свои: каталоги упавшей попытки
    // к этому моменту уже сняты.
    const perCallTmpDirs: string[] = [];
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDirs.push(dir); }, qwen, fallback);
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
   * постоянный пустой linkeon-claude-empty — см. mcpNeutralCwd.
   */
  private writeMcpConfig(
    servers: Record<string, ClaudeCliMcpHttpServer>,
    registerTmpDir: (dir: string) => void,
  ): string {
    const dir = fs.mkdtempSync(path.join(this.tmpRoot(), MCP_CONFIG_DIR_PREFIX));
    registerTmpDir(dir);
    const file = path.join(dir, 'mcp.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }), { mode: 0o600 });
    return file;
  }

  private spawnClaude(
    prompt: string,
    opts: ClaudeCliOptions,
    registerTmpDir: (dir: string) => void,
    qwen: QwenFallbackConfig | null,
    fallback: boolean,
  ): Promise<CliRunResult> {
    const requestedModel = opts.model ?? DEFAULT_MODEL;
    // На запасном пути в --model уходит модель Qwen: полный id Claude Alibaba не знает.
    const model = qwen ? qwenModelFor(requestedModel, qwen.models) : requestedModel;
    const provider: 'claude' | 'qwen' = qwen ? 'qwen' : 'claude';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const streaming = !!opts.onProgress || !!opts.onTextDelta;

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
      const tmpDir = fs.mkdtempSync(path.join(this.tmpRoot(), 'claude-cli-'));
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
      // Вызов с MCP (Маша) получает не сам os.tmpdir(), а постоянный пустой
      // каталог (mcpNeutralCwd): каталог конфига с токеном лежит рядом, а не
      // внутри cwd, при любом наборе тулов.
      if (opts.cwd) {
        spawnCwd = opts.cwd;
      } else if (hasMcp) {
        spawnCwd = this.mcpNeutralCwd(registerTmpDir);
      } else {
        spawnCwd = this.tmpRoot();
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
    // Куски текста приходят только с этим флагом (stream_event → text_delta).
    if (opts.onTextDelta) args.push('--include-partial-messages');

    return new Promise<CliRunResult>((resolve, reject) => {
      // Обычный запуск наследует process.env как есть; запасной получает своё
      // окружение (адрес и ключ Alibaba) — и только он.
      const proc = spawn(this.claudeBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: spawnCwd,
        ...(qwen ? { env: qwenSpawnEnv(process.env, qwen) } : {}),
      });
      let stdout = '';
      let stderr = '';
      // Вызвала ли модель инструмент с последствиями (не Read/WebSearch/WebFetch)
      // до сбоя — решает, можно ли повторить на Qwen.
      let sawRiskyToolUse = false;
      const fail = (message: string) => reject(new ClaudeCliCallError(message, sawRiskyToolUse));

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
          fail(`claude CLI timeout after ${timeoutMs}ms`);
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
              if (c?.type === 'tool_use' && typeof c.name === 'string') {
                if (!SIDE_EFFECT_FREE_TOOLS.has(c.name)) sawRiskyToolUse = true;
                if (opts.onProgress) {
                  try { opts.onProgress({ kind: 'tool_use', name: c.name }); } catch { /* user callback safety */ }
                }
              }
            }
          }
          if (
            opts.onTextDelta &&
            ev.type === 'stream_event' &&
            ev.event?.type === 'content_block_delta' &&
            ev.event.delta?.type === 'text_delta' &&
            typeof ev.event.delta.text === 'string'
          ) {
            try { opts.onTextDelta(stripWordJoiner(ev.event.delta.text)); } catch { /* user callback safety */ }
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
            fail(`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}`);
            return;
          }
          if (streamIsError) {
            fail(`claude CLI error: ${streamErrorDetail}`);
            return;
          }
          if (streamCostUsd) {
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);
          }
          this.trackCallEvent({
            costUsd: streamCostUsd,
            model,
            durationMs: streamDurationMs,
            ok: true,
            provider,
            fallback,
          });
          // stripWordJoiner на выходе: U+2060, которым мы обезвреживали
          // @-упоминания во входе, не должен доехать до пользователя.
          resolve({ text: stripWordJoiner(streamResultText), costUsd: streamCostUsd, toolUsed: sawRiskyToolUse });
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
          fail(`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}`);
          return;
        }
        try {
          const json = JSON.parse(stdout);
          if (json.is_error) {
            fail(`claude CLI error: ${json.result ?? 'unknown'}`);
            return;
          }
          const text: string = stripWordJoiner(json.result ?? '');
          const costUsd: number = typeof json.total_cost_usd === 'number' ? json.total_cost_usd : 0;
          if (costUsd) {
            this.logger.debug(`claude CLI cost${qwen ? ' (qwen)' : ''}: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
          }
          this.trackCallEvent({
            costUsd,
            model,
            durationMs: Number(json.duration_ms) || 0,
            ok: true,
            provider,
            fallback,
          });
          // В json-режиме вызов инструмента не виден: toolUsed всегда false,
          // осторожность — в mayRetryOnQwen по набору тулов и MCP.
          resolve({ text, costUsd, toolUsed: sawRiskyToolUse });
        } catch (e: any) {
          this.logger.error(`claude CLI parse error: ${e.message}, stdout: ${stdout.slice(0, 200)}`);
          fail(`claude CLI returned invalid JSON: ${e.message}`);
        }
      });

      proc.on('error', (err) => {
        if (timer) clearTimeout(timer);
        fail(`claude CLI spawn error: ${err.message}`);
      });
    });
  }
}
