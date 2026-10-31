// src/common/services/claude-cli.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from './pg.service';
import { neutralizeAtMentions, stripWordJoiner } from '../agent-guards';
import { classifyLlmError, looksLikeCliRefusal } from '../llm-error';
import {
  AnswerProvider,
  FALLBACK_ORDER,
  FallbackConfig,
  FallbackProvider,
  FallbackState,
  NO_FALLBACK_CONFIGS,
  PROVIDER_DEFAULTS,
  PROVIDER_LABELS,
  STATS_WINDOW_MS,
  fallbackModelFor,
  fallbackSpawnEnv,
  fallbackTimeoutMs,
  isFallbackWorthy,
  planProviders,
  readBreakerMs,
  readFallbackConfigs,
} from './llm-fallback';

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
 * Постоянный пустой cwd для вызовов без своего cwd, которым он нужен
 * нейтральным: с MCP (Маша) и, с F2 (31.10), с opts.isolatedCwd (проба без
 * входа, src/guest-trial). Один на все такие вызовы: CLI заводит в
 * ~/.claude/projects папку проекта на каждый новый cwd, и одноразовый
 * каталог на ход давал бы тысячи папок в сутки. Мы в него не пишем и не
 * удаляем его; уборка брошенных конфигов его не трогает.
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

/** Встроенные тулы без последствий: их вызов повтор у другого провайдера не
 *  запрещает — ни в stream-json (где вызов виден), ни вслепую в json-режиме. */
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
 * stream-json. Такой вызов у другого провайдера не повторяется: инструмент с
 * последствиями (правка продукта, жалоба в поддержку) сработал бы дважды.
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
   *  Куски вложенных суб-агентов (у события есть parent_tool_use_id) сюда не
   *  попадают — только текст основного ответа. Такой вызов у другого
   *  провайдера не повторяется: показанный человеку текст повтор не заберёт
   *  обратно. */
  onTextDelta?: (text: string) => void;
  /** Рабочая директория Claude. По умолчанию os.tmpdir(). Для агентных
   *  сценариев (Bash/Write/Edit) передавай изолированный sandbox-dir. */
  cwd?: string;
  /** Нейтральный ПОСТОЯННЫЙ пустой cwd вместо общего os.tmpdir(), когда caller
   *  сам не задал cwd — тот же каталог, что и у вызовов с MCP (см.
   *  neutralEmptyCwd). Общий tmp один на все процессы машины, а из cwd CLI
   *  сам подхватывает CLAUDE.md/.claude/settings.json (в них бывают хуки);
   *  проба без входа (src/guest-trial) не должна зависеть от того, что чужой
   *  процесс в этот момент оставил в общем tmp. Без MCP и без этой опции —
   *  прежнее поведение (tmpdir()). */
  isolatedCwd?: boolean;
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
   *  («...you haven't granted it yet»). С MCP вызов всегда идёт в stream-json
   *  (с --verbose). */
  mcpServers?: Record<string, ClaudeCliMcpHttpServer>;
  /** Только Claude: без запасных и без выбора пользователя. Для проверок
   *  живости Claude: с запасными они показывали бы «зелёный», когда Claude
   *  лежит. Сбой такого вызова окно Claude не открывает, успех — закрывает. */
  noFallback?: boolean;
  /** Выбор пользователя в админке (UserLlmProviderService): вызов сразу у
   *  выбранного запасного, при его сбое — обычный путь (Claude, затем запасные
   *  без него; spec 2026-10-31-kimi-provider-design.md). Не авария: окно Claude
   *  и аварийные счётчики он не трогает. Без ключа и при noFallback — обычный путь. */
  provider?: FallbackProvider;
  /** Без флага CLI пишет весь промпт (систему, реплики, ответ) в
   *  ~/.claude/projects/<cwd>/<uuid>.jsonl и хранит cleanupPeriodDays
   *  (по умолчанию 30 дней). При true добавляет --no-session-persistence —
   *  флаг действует только с --print/-p (у нас он всегда есть, см. '-p' в
   *  начале args). Проба без входа (src/guest-trial) обещает в политике 7
   *  дней — транскрипт CLI с чужим (дольшим) сроком хранения это обещание
   *  нарушает. */
  noSessionPersistence?: boolean;
}

@Injectable()
export class ClaudeCliService implements OnModuleInit {
  private readonly logger = new Logger(ClaudeCliService.name);
  private readonly claudeBin = process.env.CLAUDE_BIN ?? '/usr/bin/claude';
  /** Окна запасного пути (окно Claude и «не отвечает» у каждого запасного) и
   *  исходы аварийных вызовов — llm-fallback.ts. */
  private readonly fallback = new FallbackState();

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
   * Постоянный пустой cwd, когда caller не дал своего: <tmpdir>/linkeon-claude-empty.
   * Раньше — только для вызовов с MCP (Маша); с F2 (31.10) — и для любого
   * вызова с opts.isolatedCwd (проба без входа): тот же каталог, та же
   * защита от чужого CLAUDE.md/.claude/settings.json в общем tmp. Каталог
   * конфига MCP с токеном — отдельный, на вызов (writeMcpConfig), и лежит
   * рядом, а не внутри.
   *
   * Не годится (см. emptyCwdProblem) — вызов идёт в одноразовый claude-cwd-*,
   * который снимается после вызова, а в лог уходит причина: ход не должен
   * зависеть от чужого каталога в общем tmp.
   */
  private neutralEmptyCwd(registerTmpDir: (dir: string) => void): string {
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

  private trackCallEvent(opts: {
    costUsd: number; model: string; durationMs: number; ok: boolean;
    provider: AnswerProvider; fallback: boolean; selected?: FallbackProvider;
  }) {
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
        // Выбор пользователя (не Claude); «выбранный подвёл» — selected ≠ provider.
        selected: opts.selected,
      })],
    ).catch((e: any) => this.logger.warn(`claude_cli_call event insert failed: ${e.message}`));
  }

  /** Состояние запасного пути — для алертов мониторинга и пробы без входа.
   *  enabled/ok/failed — по всем запасным вместе (прежняя форма),
   *  breakerOpenUntil — окно Claude, providers — по каждому. */
  fallbackStats(now: number = Date.now()): {
    enabled: boolean; ok: number; failed: number; breakerOpenUntil: number; windowMs: number;
    providers: Record<FallbackProvider, { enabled: boolean; ok: number; failed: number; downUntil: number }>;
  } {
    const configs = readFallbackConfigs();
    const providers = {} as Record<FallbackProvider, { enabled: boolean; ok: number; failed: number; downUntil: number }>;
    let ok = 0;
    let failed = 0;
    for (const name of FALLBACK_ORDER) {
      const c = this.fallback.counts(name, now);
      providers[name] = { enabled: configs[name] !== null, ok: c.ok, failed: c.failed, downUntil: this.fallback.downUntilOf(name, now) };
      ok += c.ok;
      failed += c.failed;
    }
    return {
      enabled: FALLBACK_ORDER.some((n) => configs[n] !== null),
      ok,
      failed,
      windowMs: STATS_WINDOW_MS,
      breakerOpenUntil: this.fallback.claudeWindowUntil(now),
      providers,
    };
  }

  /**
   * Разовый запрос к Claude CLI: текст ответа и стоимость. При сбое доступа к
   * Claude ответ может дать запасной провайдер (см. runRaw).
   */
  async textWithCost(prompt: string, opts: ClaudeCliOptions = {}): Promise<{ text: string; costUsd: number }> {
    const res = await this.runRaw(prompt, opts);
    return { text: res.text, costUsd: res.costUsd };
  }

  /**
   * Разовый запрос к Claude CLI: текст ответа. При сбое доступа к Claude ответ
   * может дать запасной провайдер (см. runRaw).
   * Бросает при падении процесса или ненулевом коде выхода.
   */
  async text(prompt: string, opts: ClaudeCliOptions = {}): Promise<string> {
    const res = await this.runRaw(prompt, opts);
    return res.text;
  }

  /**
   * План попыток (spec 2026-10-31-kimi-provider-design.md, раздел 3): выбор
   * пользователя, Claude, запасные Qwen → Kimi в порядке цепочки. Без ключей
   * запасных и с noFallback — ровно один вызов Claude, как раньше.
   */
  private async runRaw(prompt: string, opts: ClaudeCliOptions): Promise<CliRunResult> {
    const configs = opts.noFallback ? NO_FALLBACK_CONFIGS : readFallbackConfigs();
    // Выбор пользователя (админка): сразу выбранный, при его сбое — обычный путь.
    let selected: FallbackProvider | undefined;
    if (opts.provider && !opts.noFallback) {
      // Проверка через FALLBACK_ORDER.includes, не configs[...] и не `in`
      // впрямую: имя из прототипа объекта (например 'constructor') резолвится
      // правдой по цепочке прототипов и у configs[opts.provider], и у
      // `in PROVIDER_DEFAULTS` — тот же случай отсекает planProviders.
      if (FALLBACK_ORDER.includes(opts.provider) && configs[opts.provider]) selected = opts.provider;
      else if (FALLBACK_ORDER.includes(opts.provider)) this.logger.warn(`${PROVIDER_LABELS[opts.provider]} выбран для пользователя, но ключ ${PROVIDER_DEFAULTS[opts.provider].envPrefix}_FALLBACK_API_KEY не задан — обычный путь`);
    }
    const plan = planProviders({ selected, configs, state: this.fallback, noFallback: opts.noFallback });
    const breakerMs = readBreakerMs();
    const startedAt = Date.now();
    // Причины по попыткам — для текста ошибки, если не ответит никто.
    const parts: string[] = plan[0] !== 'claude' && plan[0] !== selected
      ? ['claude CLI пропущен (окно запасного пути)']
      : [];
    let reachedFallback = false;
    let attemptOpts = opts;
    for (let i = 0; i < plan.length; ) {
      const p = plan[i];
      const emergency = p !== 'claude' && p !== selected;
      if (emergency) reachedFallback = true;
      const attemptStartedAt = Date.now();
      let res: CliRunResult | null = null;
      let err: unknown = null;
      try {
        res = await this.runOnce(prompt, attemptOpts, p === 'claude' ? null : configs[p], { fallback: emergency, selected });
      } catch (e) {
        err = e;
      }
      // Отказ CLI, пришедший обычным ответом (без is_error), — сбой того
      // провайдера, что его дал; окно Claude такой «успех» не закрывает.
      const refusal = res !== null && looksLikeCliRefusal(res.text);
      if (res !== null && !refusal) {
        if (p === 'claude') this.fallback.claudeSucceeded(attemptStartedAt);
        else {
          this.fallback.markUp(p);
          if (emergency) this.fallback.recordOutcome(p, true);
        }
        return res;
      }
      if (refusal) err = new ClaudeCliCallError(`claude CLI error: ${res!.text.trim()}`, res!.toolUsed);
      const msg = String((err as any)?.message ?? err);
      const access = isFallbackWorthy(msg);
      const kind = classifyLlmError(msg).kind;
      // Сбой доступа — свидетельство для следующих вызовов, даже если этот
      // повторять нельзя: у Claude — окно Claude (если есть на кого
      // переключаться), у запасного — его окно «не отвечает».
      if (access) {
        if (p !== 'claude') this.fallback.markDown(p, breakerMs);
        else if (FALLBACK_ORDER.some((n) => configs[n] !== null)) this.fallback.openClaudeWindow(breakerMs);
      }
      if (emergency) this.fallback.recordOutcome(p, false);
      parts.push(parts.length === 0 ? (p === selected ? `${p} (выбран): ${msg}` : msg) : `${p} fallback: ${msg}`);
      const next = this.nextAttempt(plan, i);
      // Выбранный — при любом сбое (решение владельца), остальные — только при
      // сбое доступа; и только если повтор ничего не задвоит.
      const allowed = (p === selected || access) && this.mayRetry(err, opts);
      if (next < 0 || !allowed) {
        if (access && next >= 0) {
          this.logger.warn(`${this.attemptLabel(p, selected)}: сбой доступа (${kind}), вызов не повторяется (инструмент с последствиями или показанный текст): ${msg.slice(0, 200)}`);
        }
        if (reachedFallback) {
          // Вызов дошёл до запасных, и никто не ответил: Claude мог уже ожить —
          // следующий вызов снова попробует его. Цена осознанная: при шторме 529
          // у Claude сбой запасного на конкретном запросе (или устаревший сбой
          // параллельного вызова) вернёт следующие вызовы в попытку Claude.
          this.fallback.closeClaudeWindow();
          this.logger.error(`запасные тоже не ответили: ${parts.join(' | ').slice(0, 300)}`);
        }
        if (parts.length === 1) {
          // Одна попытка — как раньше: отказ текстом вызывающий получает как
          // есть, ошибку Claude — исходным объектом.
          if (refusal) return res!;
          if (p === 'claude') throw err;
        }
        throw new Error(parts.join(' | '));
      }
      const target = plan[next];
      const toLabel = target === 'claude'
        ? 'Claude'
        : `запасной ${PROVIDER_LABELS[target]} ${fallbackModelFor(opts.model ?? DEFAULT_MODEL, configs[target]!.models)}`;
      this.logger.warn(`${this.attemptLabel(p, selected)} → ${toLabel} (${kind}): ${msg.slice(0, 200)}`);
      // Следующая попытка укладывается в остаток бюджета вызова, а не в полный.
      attemptOpts = { ...opts, timeoutMs: fallbackTimeoutMs(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, Date.now() - startedAt) };
      i = next;
    }
    throw new Error(parts.join(' | ') || 'claude CLI: пустой план попыток');
  }

  /** Подпись попытки в логе: «claude CLI», «Kimi (выбран)», «Qwen». */
  private attemptLabel(p: AnswerProvider, selected?: FallbackProvider): string {
    if (p === 'claude') return 'claude CLI';
    return p === selected ? `${PROVIDER_LABELS[p]} (выбран)` : PROVIDER_LABELS[p];
  }

  /** Следующий в плане после i: запасной, который за время вызова стал «не
   *  отвечает» (его уронил параллельный вызов), пропускается. -1 — некуда. */
  private nextAttempt(plan: AnswerProvider[], i: number): number {
    for (let j = i + 1; j < plan.length; j++) {
      const p = plan[j];
      if (p !== 'claude' && this.fallback.isDown(p)) continue;
      return j;
    }
    return -1;
  }

  private static hasMcp(opts: ClaudeCliOptions): boolean {
    return !!opts.mcpServers && Object.keys(opts.mcpServers).length > 0;
  }

  /** stderr без строк с безобидным предупреждением о незнакомой модели
   *  запасного (`[claude-code:unrecognized_model] {...}`): живая проверка на
   *  Linux (31.10, битый ключ Qwen) показала, что оно заслоняет настоящую
   *  причину сбоя (401), если брать stderr как есть. Остаток — склеен и
   *  обрезан. */
  private static stderrDetail(stderr: string): string {
    return stderr
      .split('\n')
      .filter((line) => !line.includes('[claude-code:unrecognized_model]'))
      .join('\n')
      .trim()
      .slice(0, 400);
  }

  /** Признак stream-json — в одном месте: его же читают mayRetry (решает,
   *  было бы видно использование инструмента) и spawnClaude (--output-format). */
  private static isStreaming(opts: ClaudeCliOptions): boolean {
    return !!opts.onProgress || !!opts.onTextDelta || ClaudeCliService.hasMcp(opts);
  }

  /** Можно ли повторить вызов у следующего провайдера: только если модель ещё
   *  ничего не сделала инструментами с последствиями и человек не видел текста. */
  private mayRetry(e: unknown, opts: ClaudeCliOptions): boolean {
    if (e instanceof ClaudeCliCallError && e.toolUsed) return false;
    // Человек уже видит куски ответа — второй, другой ответ поверх них хуже ошибки.
    if (opts.onTextDelta) return false;
    // Без stream-json вызов инструмента не виден: вслепую повторяем, только
    // если встроенные тулы лишь из Read/WebSearch/WebFetch (Bash, Write, Edit,
    // 'default' — нельзя). Вызовы с MCP всегда идут в stream-json (isStreaming).
    if (!ClaudeCliService.isStreaming(opts)) {
      const riskyTools = (opts.tools ?? '')
        .split(/[\s,]+/)
        .some((t) => t !== '' && !SIDE_EFFECT_FREE_TOOLS.has(t));
      if (riskyTools) return false;
    }
    return true;
  }

  /** Один запуск CLI: cfg = null — Claude, иначе — модель и окружение запасного. */
  private async runOnce(
    prompt: string,
    opts: ClaudeCliOptions,
    cfg: FallbackConfig | null,
    meta: { fallback: boolean; selected?: FallbackProvider },
  ): Promise<CliRunResult> {
    // Одноразовые каталоги вызова (создаются только когда нужны — см. ниже):
    // копии вложений и конфиг MCP с токенами. Снимаются в finally — и на успехе,
    // и на падении, и по таймауту, — чтобы не копить в tmp ни чужих файлов, ни
    // живых токенов. У следующей попытки — свои: каталоги упавшей к этому
    // моменту уже сняты.
    const perCallTmpDirs: string[] = [];
    try {
      return await this.spawnClaude(prompt, opts, (dir) => { perCallTmpDirs.push(dir); }, cfg, meta);
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
   * постоянный пустой linkeon-claude-empty — см. neutralEmptyCwd.
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
    cfg: FallbackConfig | null,
    meta: { fallback: boolean; selected?: FallbackProvider },
  ): Promise<CliRunResult> {
    const requestedModel = opts.model ?? DEFAULT_MODEL;
    // У запасного в --model уходит его модель: полный id Claude он не знает.
    const model = cfg ? fallbackModelFor(requestedModel, cfg.models) : requestedModel;
    const provider: AnswerProvider = cfg ? cfg.name : 'claude';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const hasAttachments = (opts.attachments?.length ?? 0) > 0;
    const hasMcp = ClaudeCliService.hasMcp(opts);
    // stream-json — и у любого вызова с MCP, даже без onProgress: там видно,
    // вызывала ли модель инструмент, а от этого зависит, можно ли повторить
    // вызов у другого провайдера (mayRetry). Маша и TG и так идут в stream-json
    // через onProgress; это страховка для будущих вызовов с MCP.
    const streaming = ClaudeCliService.isStreaming(opts);

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
      // Вызов с MCP (Маша) или с isolatedCwd (проба без входа, F2) получает
      // не сам os.tmpdir(), а постоянный пустой каталог (neutralEmptyCwd):
      // у MCP каталог конфига с токеном лежит рядом, а не внутри cwd, при
      // любом наборе тулов; у пробы — просто чтобы не достался чужой
      // CLAUDE.md из общего tmp (см. emptyCwdProblem).
      if (opts.cwd) {
        spawnCwd = opts.cwd;
      } else if (hasMcp || opts.isolatedCwd) {
        spawnCwd = this.neutralEmptyCwd(registerTmpDir);
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
    // Приватность пробы без входа (F1, ревью 31.10): без флага CLI пишет весь
    // промпт (персону, реплики гостя, ответ) в
    // ~/.claude/projects/<cwd>/<uuid>.jsonl и хранит cleanupPeriodDays (30
    // дней) — дольше, чем обещает политика пробы (7 дней). Флаг работает
    // только с --print/-p — он у нас есть всегда (см. '-p' в начале args).
    if (opts.noSessionPersistence) args.push('--no-session-persistence');

    return new Promise<CliRunResult>((resolve, reject) => {
      // Обычный запуск наследует process.env как есть; запасной получает своё
      // окружение (адрес и ключ провайдера) — и только он.
      const proc = spawn(this.claudeBin, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: spawnCwd,
        ...(cfg ? { env: fallbackSpawnEnv(process.env, cfg) } : {}),
      });
      let stdout = '';
      let stderr = '';
      // StringDecoder держит «хвост» незавершённого многобайтового символа
      // между кусками: граница чтения из pipe может прийтись внутрь буквы
      // (кириллица — 2 байта), и b.toString() на каждом куске ОТДЕЛЬНО
      // превращал бы обе половинки в U+FFFD. Один декодер на процесс — до
      // конца этого вызова, не общий между вызовами.
      const outDecoder = new StringDecoder('utf8');
      const errDecoder = new StringDecoder('utf8');
      // Вызвала ли модель инструмент с последствиями (не Read/WebSearch/WebFetch)
      // до сбоя — решает, можно ли повторить у другого провайдера.
      let sawRiskyToolUse = false;
      // Вызов уже отклонён или разрешён — дальнейшие данные от процесса (он
      // может ещё писать в stdout после kill('SIGTERM') по таймауту) больше не
      // должны доходить до колбэков caller-а.
      let settled = false;
      const fail = (message: string) => {
        settled = true;
        reject(new ClaudeCliCallError(message, sawRiskyToolUse));
      };

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
        const chunk = outDecoder.write(b);
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
                if (opts.onProgress && !settled) {
                  try { opts.onProgress({ kind: 'tool_use', name: c.name }); } catch { /* user callback safety */ }
                }
              }
            }
          }
          if (
            !settled &&
            opts.onTextDelta &&
            // parent_tool_use_id — кусок вложенного суб-агента, а не основного
            // ответа; у основного это поле null/отсутствует.
            !ev.parent_tool_use_id &&
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
      proc.stderr.on('data', (b) => { stderr += errDecoder.write(b); });

      proc.on('close', (code) => {
        if (timer) clearTimeout(timer);

        // Stream mode: всё уже распарсено по ходу, просто возвращаем накопленное.
        if (streaming) {
          if (code !== 0) {
            this.logger.error(`claude CLI exit ${code}: stderr=${stderr.slice(0, 300)} stdout=${stdout.slice(0, 300)}`);
            const detail = streamErrorDetail || ClaudeCliService.stderrDetail(stderr) || stdout.trim().slice(0, 400);
            fail(`claude CLI exited with code ${code}: ${detail.slice(0, 200) || '(no output)'}`);
            return;
          }
          if (streamIsError) {
            fail(`claude CLI error: ${streamErrorDetail}`);
            return;
          }
          if (streamCostUsd) {
            this.logger.debug(`claude CLI cost${cfg ? ` (${cfg.name})` : ''}: $${streamCostUsd.toFixed(4)}, ${streamDurationMs}ms (stream)`);
          }
          this.trackCallEvent({
            costUsd: streamCostUsd,
            model,
            durationMs: streamDurationMs,
            ok: true,
            provider,
            fallback: meta.fallback,
            selected: meta.selected,
          });
          // stripWordJoiner на выходе: U+2060, которым мы обезвреживали
          // @-упоминания во входе, не должен доехать до пользователя.
          settled = true;
          resolve({ text: stripWordJoiner(streamResultText), costUsd: streamCostUsd, toolUsed: sawRiskyToolUse });
          return;
        }

        // Non-streaming path: одноразовый JSON parse на выходе.
        if (code !== 0) {
          // Причина — сначала из JSON в stdout, но ТОЛЬКО если это
          // действительно ошибка (is_error или текст похож на отказ CLI) и
          // result/error — непустая строка после .trim() (иначе строка из
          // пробелов заслонила бы stderr). Если stdout — валидный JSON, но ни
          // result, ни error не дали причину (обычный ответ с ненулевым
          // кодом) — сырой stdout в причину НЕ берём: в нём тот же текст
          // («429», «try again»), и он классифицировался бы как лимит и
          // открыл бы окно Claude для всех. Сырой stdout — только когда
          // stdout НЕ JSON вовсе. Дальше — stderr (без безобидных
          // предупреждений о модели — stderrDetail; живая проверка на Linux,
          // 31.10, битый ключ Qwen: `[claude-code:unrecognized_model] {...}`
          // заслоняло настоящую причину 401), а если и там пусто —
          // нейтральная причина.
          let detail = '';
          try {
            const j = JSON.parse(stdout);
            if (typeof j.result === 'string') {
              const r = j.result.trim();
              if (r && (j.is_error === true || looksLikeCliRefusal(j.result))) detail = r;
            }
            if (!detail && typeof j.error === 'string') {
              const e = j.error.trim();
              if (e) detail = e;
            }
            if (!detail) detail = ClaudeCliService.stderrDetail(stderr);
            if (!detail) detail = 'ненулевой код после обычного ответа (без is_error)';
          } catch {
            detail = ClaudeCliService.stderrDetail(stderr) || stdout.trim().slice(0, 400);
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
            this.logger.debug(`claude CLI cost${cfg ? ` (${cfg.name})` : ''}: $${costUsd.toFixed(4)}, ${json.duration_ms}ms`);
          }
          this.trackCallEvent({
            costUsd,
            model,
            durationMs: Number(json.duration_ms) || 0,
            ok: true,
            provider,
            fallback: meta.fallback,
            selected: meta.selected,
          });
          // В json-режиме вызов инструмента не виден: toolUsed всегда false,
          // осторожность — в mayRetry по набору тулов.
          settled = true;
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
