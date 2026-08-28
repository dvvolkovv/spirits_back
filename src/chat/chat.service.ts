import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { KlingService } from '../misc/kling.service';
import { ChatToolsService } from './chat-tools';
import { SmmProducerToolsService } from '../smm/producer/smm-producer-tools.service';
import { ClaudeAgentService } from './claude-agent.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { TasksService } from '../tasks/tasks.service';
import { EventsService } from '../events/events.service';
import { TalerIdOauthService } from '../talerid/talerid-oauth.service';
import { LanguageService, LANGUAGE_REPLY_LINE, DEFAULT_LANGUAGE } from '../common/services/language.service';
import { parseMeetingLink } from '../meeting/meeting-link';
import { RoomService } from '../meeting/room.service';
import { buildMeetingCard } from './meeting-card';
import { RESPONSE_STYLE_RULE } from './response-style';
import { BalanceContextService } from '../tokens/balance-context.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import axios from 'axios';
import { Request, Response } from 'express';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';
import { sendTelegramAlert } from '../common/telegram-alert';
// Agent server at r.linkeon.io (remote Claude Code)

/** Файл в папке сессии, как его отдаёт relay (`GET /session/:sid/files`). */
export interface SessionFile { name: string; url: string }

/**
 * Сырой расход хода, как его присылает file-agent в событии `done`.
 * Записи в кэш разделены по TTL: 5 минут стоят 1.25x input, час — 2x,
 * складывать их в одно число нельзя.
 */
export interface SdkUsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  webSearch: number;
  webFetch: number;
}

/**
 * Чем ход объясняет своё списание. Едет в token_consumption_tasks.metadata,
 * оттуда TokenAccountingService переносит в token_transactions рядом с
 * человекочитаемым description.
 *
 * `source` тут важнее суммы: `usage` при низком покрытии означает, что
 * взвешенный расчёт хода не видел (был фан-аут субагентов) и сумма пришла от
 * costUsd — именно так набежали 862 673 токена 2026-08-10.
 */
export interface ChargeFacts {
  costUsd: number;
  source: 'usage' | 'cost' | 'length';
  durationMs: number;
  replyChars: number;
}

/**
 * Ошибки апстрима, которые релей отдаёт как обычный текст ответа.
 *
 * Claude CLI при отвале подписки или протухшем OAuth печатает сообщение в
 * stdout и выходит. Для релея это просто текст, он передаёт его дальше как
 * ответ ассистента — с нулевым costUsd и без usage, потому что модель не
 * работала. 11.08.2026 такой ход четырём пользователям обошёлся в 288 токенов
 * каждому: сработал откат «длина × 2», и мы взяли деньги за чужую поломку.
 *
 * Строки английские и стабильные — это тексты CLI, не наши. Держим список
 * узким: задача отличить поломку от работы, а не угадывать все сбои.
 */
const UPSTREAM_ERROR_SIGNATURES = [
  'disabled claude subscription access',
  'oauth token has expired',
  'invalid api key',
  'claude code process exited',
  'credit balance is too low',
];

/**
 * Похож ли ответ на проброшенную ошибку апстрима, а не на работу ассистента.
 *
 * Порог длины обязателен: ассистента могут СПРОСИТЬ про такую ошибку, и его
 * разбор — полноценный ответ, за который списать надо. Пробросы короткие (на
 * проде 144 символа), разборы — в разы длиннее.
 */
export function isUpstreamErrorReply(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length > 400) return false;
  const low = trimmed.toLowerCase();
  return UPSTREAM_ERROR_SIGNATURES.some(sig => low.includes(sig));
}

/**
 * Дособирает ссылки на файлы, которые ассистент оформить не смог.
 *
 * Ассистенту инструкцией запрещено писать пути и URL: их подставляет
 * платформа. Но подставляет она только файлы, ИЗМЕНЁННЫЕ за текущий шаг —
 * relay сравнивает mtime с состоянием на старте запроса. На многошаговой
 * работе это теряет результат: ролики пишутся на одних шагах, итоговый
 * отчёт собирается на последнем, и к нему не прикладывается ничего, хотя
 * файлы лежат целые.
 *
 * Оставшись без механизма, ассистент выкручивается — и каждый раз
 * по-разному. Наблюдались три формы, все три и обрабатываем:
 *  1. пустые скобки `[Скачать отчёт.pdf]()`;
 *  2. адрес в блоке кода — внутри ``` разметка не работает, кликнуть нельзя;
 *  3. адрес голым текстом — этот фронт подсвечивает сам, трогать не нужно.
 *
 * Возвращаем список готовых markdown-ссылок, которые вызывающий дописывает
 * в конец ответа. Полный список файлов сессии НЕ прикладываем: сессия живёт
 * неделями, файлов там десятки, и они начали бы липнуть к каждой реплике —
 * это уже случалось в бою и было откачено.
 */
export function resolveEmptyFileLinks(
  text: string,
  files: SessionFile[],
  agentUrl: string,
): string[] {
  const byName = new Map<string, string>();
  for (const f of files || []) {
    if (f?.name && f?.url) byName.set(String(f.name), String(f.url));
  }

  const out: string[] = [];
  const seen = new Set<string>();

  /** Уже кликабельно, если адрес стоит внутри `](...)`. */
  const isLinked = (url: string) =>
    new RegExp(`\\]\\(\\s*${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text);

  const push = (name: string, url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    out.push(`[Скачать ${name}](${url})`);
  };

  // 1. Пустые скобки: имя есть, адреса нет.
  if (byName.size > 0) {
    for (const m of text.matchAll(/\[([^\]]+)\]\(\s*\)/g)) {
      const label = String(m[1]);
      // Метка бывает «Скачать имя.pdf» и просто «имя.pdf» — берём последнее
      // слово, похожее на имя файла с расширением.
      const withExt = label.match(/([^\s/\\]+\.[A-Za-z0-9]{2,5})\s*$/);
      const name = withExt ? withExt[1] : label.trim();
      const rel = byName.get(name);
      if (rel) push(name, `${agentUrl}${rel}`);
    }
  }

  // 2. Готовый адрес в тексте, но не оформленный ссылкой. Чаще всего это
  //    блок кода: ассистент кладёт туда URL и просит «скопируй строку».
  const urlRe = new RegExp(
    `${agentUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/files/[^\\s\`'"<>)\\]]+`,
    'g',
  );
  for (const m of text.matchAll(urlRe)) {
    const url = String(m[0]);
    if (isLinked(url)) continue; // уже кликабельно — второй раз не надо
    const name = decodeURIComponent(url.split('/').pop() || '').trim();
    if (name) push(name, url);
  }

  return out;
}

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  // Множитель цены за текст для агентов, идущих через SDK-путь
  // (streamUniversalAgent → r.linkeon.io). Применяется только для текстовых
  // токенов; MCP-инструменты (картинки, видео) списываются их сервисами
  // независимо и НЕ умножаются здесь. Маша считается отдельно — через
  // total_cost_usd из ClaudeCliService.
  private readonly SDK_TEXT_MULTIPLIER = 2;

  // Курс перевода реальной стоимости хода в Linkeon-токены для SDK-пути.
  //
  // Курс общий для всех путей, которые едят ёмкость подписки Claude —
  // обоснование и оговорки в common/billing-rates.ts.
  private readonly TOKENS_PER_USD = SEAT_TOKENS_PER_USD;

  // Веса для перевода сырого usage во «взвешенные токены» — это отношения цен
  // Anthropic к цене input-токена. Ключевое свойство: у opus, sonnet и haiku
  // отношения ОДИНАКОВЫЕ (out = 5x in, cache_read = 0.1x, запись 5м = 1.25x,
  // запись 1ч = 2x), поэтому единица не зависит от того, какая модель отработала,
  // и не плывёт, когда Anthropic меняет абсолютные цены.
  //
  // Единица = «сколько стоила бы та же работа во входных токенах».
  private readonly W_INPUT = 1;
  private readonly W_CACHE_READ = 0.1;
  private readonly W_CACHE_WRITE_5M = 1.25;
  private readonly W_CACHE_WRITE_1H = 2;
  private readonly W_OUTPUT = 5;

  // Цена input-токена модели, на которой крутится SDK-путь (сейчас opus-5, $5/MTok).
  // Нужна только чтобы перевести взвешенные единицы обратно в доллары и дальше в
  // токены по единому курсу TOKENS_PER_USD.
  private readonly SDK_INPUT_USD_PER_MTOK = Number(process.env.SDK_INPUT_USD_PER_MTOK || 5);

  // Порог алерта на дорогой ход, в долларах реальной стоимости. Обычные ходы
  // укладываются в $0.05–0.20, тяжёлые с субагентами доходили до $3.7; ход за
  // $47 у юриста 2026-08-08 прошёл незамеченным. $5 ловит выбросы и молчит на
  // рабочем потоке.
  private readonly EXPENSIVE_TURN_ALERT_USD = Number(process.env.SDK_ALERT_USD || 5);

  // Идемпотентность отправки: гасит дубли от повторных запросов (обрыв связи,
  // таймаут стрима, двойной тап) — второй идентичный запрос НЕ запускает агента
  // и НЕ списывает токены, пока первый «в полёте» или только что завершился.
  // In-memory (единый PM2-процесс). Инцидент 2026-07-12 (дубли картинок/текста).
  private readonly inflight = new Map<string, { state: 'running' | 'done'; ts: number }>();
  private readonly DEDUP_COOLDOWN_MS = 12000;
  private readonly DEDUP_RUNNING_TTL_MS = 600000; // страховка от «залипшего» running

  /**
   * Сколько ходов прямо сейчас в полёте. Считается отдельно от inflight-мапы:
   * у той TTL 10 минут (страховка дедупа), а ходы юридических ассистентов идут
   * по 20–25 минут — как раз те, которые нельзя рвать.
   *
   * Нужен деплою. 2026-08-10 в 20:22 выкат перезапустил процесс через 58 секунд
   * после того, как пользователь отправил сообщение: ход убило посреди стрима,
   * ответа не появилось вовсе (заглушка «попробуйте ещё раз» живёт в
   * persistResponse того же процесса), а релей ещё три минуты жёг токены в никуда.
   */
  private activeStreams = 0;

  /**
   * Живые ходы поимённо: `${userId}_${assistantId}` → когда начался.
   *
   * Счётчика выше не хватает: он отвечает деплою на вопрос «можно ли сейчас
   * рестартовать», а фронту нужен другой — «идёт ли ход ИМЕННО у меня». Без
   * этого перезагрузка страницы посреди долгого ответа выглядит как зависший
   * чат: индикатор «печатает» жил только в памяти вкладки и после F5 исчезал,
   * ответ ещё считался, а пользователь видел тишину и слал «?» — и этим «?»
   * убивал собственный ход (релей пре-эмптит предыдущий процесс сессии).
   */
  private readonly activeTurns = new Map<string, number>();

  /** Ходов в полёте. 0 — можно перезапускать, не порвав ничей ответ. */
  getActiveStreamCount(): number {
    return this.activeStreams;
  }

  /**
   * Идёт ли прямо сейчас ход по этой паре пользователь+ассистент, и сколько он
   * уже длится. Для индикатора «ассистент работает» после перезагрузки.
   */
  getActiveTurn(userId: string, assistantId: string): { active: boolean; startedMsAgo: number } {
    const startedAt = this.activeTurns.get(`${userId}_${assistantId}`);
    return startedAt
      ? { active: true, startedMsAgo: Date.now() - startedAt }
      : { active: false, startedMsAgo: 0 };
  }
  private dupKey(userId: string, assistantId: string, message: string): string {
    return `${userId}::${assistantId}::${(message || '').trim().slice(0, 300)}`;
  }

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
    @Optional() private readonly kling: KlingService,
    private readonly tools: ChatToolsService,
    private readonly smmProducerTools: SmmProducerToolsService,
    private readonly claudeAgent: ClaudeAgentService,
    private readonly claudeCli: ClaudeCliService,
    private readonly language: LanguageService,
    private readonly balanceCtx: BalanceContextService,
    @Optional() private readonly tasksService?: TasksService,
    @Optional() private readonly events?: EventsService,
    @Optional() private readonly talerIdOauth?: TalerIdOauthService,
    @Optional() private readonly businessProfile?: BusinessProfileService,
    @Optional() private readonly rooms?: RoomService,
  ) {}

  /**
   * Agent-direct: the TalerID fields to hand the file-agent for a connected user,
   * or null when the user hasn't connected the ecosystem (a single cheap DB read
   * for the vast majority). token = the full-scope access token (rotation-safe,
   * cached); mcpUrl = the MCP endpoint of the env this backend points at, so the
   * shared file-agent hits staging vs api.talerid.io correctly. Never throws —
   * a mint failure degrades to null (agent runs without TalerID tools).
   */
  async taleridAgentFields(userId: string): Promise<{ token: string; mcpUrl: string } | null> {
    if (!this.talerIdOauth) return null;
    let token: string | null = null;
    try {
      token = await this.talerIdOauth.getBackendAccessToken(userId);
    } catch (e: any) {
      this.logger.warn(`talerid token mint failed for ${userId}: ${e?.message}`);
      return null;
    }
    if (!token) return null;
    const base = (process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol').replace(/\/$/, '');
    return { token, mcpUrl: `${base}/mcp` };
  }

  // Эвристика англ-утечки: длинный ответ, в котором почти нет кириллицы (после
  // вырезания кода/URL) — вероятно, ассистент «съехал» на английский или утёк
  // служебный вывод. Для агрегатной телеметрии (не для блокировки).
  /**
   * Письменность текста: кириллица / латиница / китайский. 'unknown' — букв
   * слишком мало либо ни одна не набирает уверенного большинства.
   */
  private dominantScript(text: string): 'cyrillic' | 'latin' | 'han' | 'unknown' {
    if (!text) return 'unknown';
    const cleaned = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/`[^`]*`/g, ' ');
    const cyr = (cleaned.match(/\p{Script=Cyrillic}/gu) || []).length;
    const lat = (cleaned.match(/\p{Script=Latin}/gu) || []).length;
    const han = (cleaned.match(/\p{Script=Han}/gu) || []).length;
    const total = cyr + lat + han;
    if (total < 40) return 'unknown';
    const [best, score] = ([['cyrillic', cyr], ['latin', lat], ['han', han]] as const)
      .reduce((a, b) => (b[1] > a[1] ? b : a));
    // Смешанный текст (термины латиницей в русском ответе) не считаем сменой
    // языка: у ответа на русском с парой английских слов латиница не наберёт 60%.
    return score / total >= 0.6 ? best : 'unknown';
  }

  /** Ожидаемая письменность для языка интерфейса. */
  private scriptForLanguage(lang: string): 'cyrillic' | 'latin' | 'han' | 'unknown' {
    if (lang === 'ru') return 'cyrillic';
    if (lang === 'zh') return 'han';
    if (['en', 'es', 'de', 'fr', 'pt'].includes(lang)) return 'latin';
    return 'unknown';
  }

  /**
   * Ответ не на том языке, на котором к ассистенту обратились.
   *
   * Прежняя версия называлась looksEnglishLeak и считала дефектом любой текст,
   * где меньше 10% кириллицы. Это верно ровно для одноязычного продукта: у нас
   * семь локалей, и корректный ответ англичанину, немцу, испанцу, французу или
   * португальцу попадал под правило наравне с настоящей утечкой. Китайский —
   * всегда, в нём кириллицы не бывает в принципе. 15.08.2026 такой алерт уже
   * прилетел на ровном месте.
   *
   * Опорой служит язык последней реплики пользователя, а не профиль: языковая
   * директива прямо разрешает ассистенту перейти на язык собеседника
   * (LanguageService.buildDirective), да и в профиле язык задан у меньшинства —
   * на 15.08.2026 у 21 учётки из 182. Профиль используется, когда по реплике
   * судить не о чем: короткое «ок», смайлик, ссылка.
   */
  private looksLanguageMismatch(response: string, userLanguage: string, userMessage: string): boolean {
    const responseScript = this.dominantScript(response);
    if (responseScript === 'unknown') return false; // коротко или смешанно — не судим

    const userScript = this.dominantScript(userMessage);
    const expected = userScript !== 'unknown' ? userScript : this.scriptForLanguage(userLanguage);
    if (expected === 'unknown') return false;

    return responseScript !== expected;
  }

  /**
   * Служебный отказ Claude CLI, притворившийся ответом ассистента: протухший
   * вход, исчерпанная сессия, пустой баланс. Такой «ответ» нельзя ни показывать
   * дословно, ни тарифицировать.
   *
   * Ограничение по длине — намеренное. Отказ CLI это одна короткая строка
   * целиком; настоящий ответ ассистента, который лишь ЦИТИРУЕТ такую фразу
   * («у меня выскочило „Not logged in“, что делать?»), под порог не попадёт и
   * пострадать не должен.
   */
  private looksCliFailure(text: string): boolean {
    const t = (text || '').trim();
    if (!t || t.length > 300) return false;
    return /Not logged in|Please run \/login|hit your (session|usage) limit|Invalid API key|Credit balance is too low|OAuth token (has )?expired/i.test(t);
  }

  async streamChat(
    userId: string,
    message: string,
    assistantId: string,
    sessionId: string,
    profileText: string,
    res: Response,
    req?: Request,
    // «Чистый лист»: история и запись идут в отдельную fresh-сессию (sessionId),
    // прошлые задачи в промпт не инжектятся. Профиль ЧИТАЕТСЯ (вариант A) и
    // ФОРМИРУЕТСЯ (consolidateFromChat работает от переданных сообщений).
    fresh: boolean = false,
    // Язык интерфейса из тела запроса — подсказка на случай пустого профиля.
    // Профиль остаётся главным, приоритет разбирает resolveUserLanguage.
    requestLang?: string,
    // Часовой пояс клиента (IANA, из Intl.DateTimeFormat). Без него модель
    // живёт по UTC сервера и расходится с пользователем: юрист из ЯНАО (UTC+5)
    // 11.08 писала «я тебе в 19:44 файлы направляю», а ассистент видел 14:44 и
    // объяснял ей эту разницу вручную посреди рабочего разговора.
    clientTz?: string,
    // Запрос из сборки для App Store или Google Play: ссылок на пополнение в
    // промпте быть не должно. См. BalanceContextService.buildContextForPrompt.
    storeBuild: boolean = false,
  ): Promise<void> {
    // Get agent
    // Custom-agent branch: "custom:<uuid>" references user-created agents.
    // Owner-check is enforced — a user cannot use another user's custom agent.
    let agent: any;
    if (assistantId.startsWith('custom:')) {
      const customId = assistantId.substring('custom:'.length);
      const customRes = await this.pg.query(
        `SELECT id, name, description, system_prompt FROM custom_agents
          WHERE id = $1 AND owner_user_id = $2
          LIMIT 1`,
        [customId, userId],
      );
      if (customRes.rows[0]) {
        // Shape matches the agents table row used downstream
        agent = {
          id: `custom:${customRes.rows[0].id}`,
          name: customRes.rows[0].name,
          display_name: customRes.rows[0].name,
          description: customRes.rows[0].description || '',
          system_prompt: customRes.rows[0].system_prompt || '',
        };
      } else {
        // Orphaned / not owned — fall back to the platform default agent (Роман, id=1)
        this.logger.warn(`custom agent ${customId} not found or not owned by ${userId}, falling back to default`);
        // is_active обязателен: скрытый ассистент не должен становиться
        // платформенным дефолтом. Точечные выборки по id/name ниже фильтр
        // НЕ применяют сознательно — иначе у тех, кто уже разговаривает со
        // скрытым ассистентом, чат перестал бы открываться.
        const fallbackRes = await this.pg.query('SELECT * FROM agents WHERE is_active ORDER BY id LIMIT 1');
        agent = fallbackRes.rows[0];
      }
    } else {
      const isNumeric = /^\d+$/.test(assistantId);
      const agentRes = isNumeric
        ? await this.pg.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
        : await this.pg.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
      agent = agentRes.rows[0];
    }
    if (!agent) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }

    // Get chat history (individual rows: session_id, sender_type, content)
    // fresh: история и запись — в отдельной fresh-сессии из controller'а.
    const chatSessionId = fresh ? sessionId : `${userId}_${assistantId}`;

    // Ссылка на комнату Linkeon замыкает ход: показываем карточку «Зайти во
    // встречу» и в модель не идём. Иначе за каждую вставленную ссылку платим
    // ход LLM и получаем два ответа — карточку и рассуждение ассистента о ней.
    // Тот же приём, что у приветствия и у сообщения о нехватке токенов ниже.
    const meetingLink = this.rooms ? parseMeetingLink(message) : null;
    if (meetingLink) {
      const room = await this.rooms!.info(meetingLink.code).catch(() => null);
      // Комнаты нет или она закрыта — значит это была обычная ссылка в
      // разговоре, а не приглашение. Идём обычным путём.
      if (room?.active) {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Access-Control-Allow-Origin', '*');

        await this.pg.query(
          `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
           VALUES ($1, 'human', $2, $3, 'text')`,
          [chatSessionId, agent.id, message],
        );
        const card = buildMeetingCard(room.code, room.title);
        await this.pg.query(
          `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
           VALUES ($1, 'ai', $2, $3, 'text', 0)`,
          [chatSessionId, agent.id, card],
        );

        res.write(JSON.stringify({ type: 'begin' }) + '\n');
        res.write(JSON.stringify({ type: 'item', content: card }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: card, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        return;
      }
    }
    const histRes = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT 10`,
      [chatSessionId],
    );
    const recentHistory = histRes.rows.reverse().map(r => ({
      type: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
    }));

    // Check token balance (skip for first greeting)
    const isGreetingMsg = recentHistory.length === 0 && /привет|расскажи про себя|hello|hi$/i.test(message.trim());
    // Баланс нужен и шлагбауму, и блоку промпта — читаем один раз.
    let balance = 0;
    {
      const balRes = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
      balance = Number(balRes.rows[0]?.tokens || 0);
    }
    if (!isGreetingMsg) {
      if (balance <= 0) {
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('X-Accel-Buffering', 'no');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const noTokensMsg = '⚠️ **Недостаточно токенов**\n\nВаш баланс исчерпан. Пополните баланс, чтобы продолжить общение с ассистентами.\n\n👉 [Пополнить баланс](/chat?view=tokens)';
        res.write(JSON.stringify({ type: 'begin' }) + '\n');
        res.write(JSON.stringify({ type: 'item', content: noTokensMsg }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: noTokensMsg, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        return;
      }
    }

    // Блок про баланс собирается ОДИН раз за ход и передаётся готовой строкой
    // во все пути: побочный эффект (отметка о выданном предупреждении) должен
    // случиться однократно, а тексты в путях — не разойтись.
    const balanceBlock = await this.balanceCtx.buildContextForPrompt(userId, balance, {
      isGreeting: isGreetingMsg,
      storeBuild,
    });

    // Route SMM-Producer agent to its dedicated Claude Agent SDK path (Plan 4e).
    // Uses OAuth via ~/.claude/.credentials.json — no ANTHROPIC_API_KEY needed.
    // Multi-turn handled via session resume (stored in profile_data.smm_sdk_session_id).
    if (agent?.name === 'smm_producer') {
      // Set streaming headers
      res.status(200);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('X-Accel-Buffering', 'no');
      res.setHeader('Access-Control-Allow-Origin', '*');

      // Persist the user message to chat history (so it shows up on history reload).
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
         VALUES ($1, 'human', $2, $3, 'text')`,
        [chatSessionId, agent.id, message],
      );

      const adminRes = await this.pg.query(
        `SELECT isadmin FROM ai_profiles_consolidated WHERE user_id = $1`,
        [userId],
      );
      const isAdmin = Boolean(adminRes.rows[0]?.isadmin);
      const ctx = { userId, isAdmin, balanceBlock };
      try {
        await this.claudeAgent.streamSmmProducer(ctx, message, chatSessionId, agent.id, res, agent.category, fresh);
      } catch (err: any) {
        this.logger.error(`SMM streaming failed: ${err.message}`);
        // Best-effort error event; res may already be ended.
        try {
          res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
          res.end();
        } catch {}
      }
      return;
    }

    // Все агенты кроме Маши идут через streamUniversalAgent → r.linkeon.io
    // (MCP image/video tools, code execution). Маша остаётся локально потому
    // что её метафорические карты подмешиваются регуляркой post-processing'ом
    // из metaphor_cards postgres-таблицы (см. ниже) — r.linkeon.io об этом
    // не знает.
    if (agent.id !== 3) {
      return this.streamUniversalAgent(
        userId, message, String(assistantId), String(agent.id),
        recentHistory, profileText, res,
        agent.name, agent.description || '', agent.system_prompt || '',
        req, fresh, chatSessionId, requestLang, clientTz, balanceBlock,
        agent.category,
      );
    }

    // Build system prompt with platform context + profile.
    // Use display_name (e.g. Юлия) instead of internal name (smm_producer) so the
    // assistant introduces coworkers with their human-friendly names.
    // Объявляем до запроса коллег: имена и описания тянем уже на языке
    // пользователя, иначе ассистент предложит переключиться на «Машу»
    // кириллицей посреди испанского ответа.
    const userLanguage = await this.language.resolveUserLanguage(userId, requestLang);

    const allAgents = await this.pg.query(
      `SELECT a.name,
              COALESCE(t.display_name, a.display_name, a.name) AS display_name,
              COALESCE(t.description, a.description)           AS description,
              a.system_prompt
         FROM agents a
         LEFT JOIN agent_translations t
                ON t.entity_type = 'agent'
               AND t.entity_id   = a.id::text
               AND t.locale      = $1
        ORDER BY a.id`,
      [userLanguage],
    );
    const agentsList = allAgents.rows.map(a => `${a.display_name} — ${a.description}`).join(', ');

    const otherAgents = allAgents.rows
      .filter(a => a.name !== agent.name)
      .map(a => `${a.display_name} — ${a.description}`)
      .join(', ');

    const platformContext = `ТЫ — ${agent.name}, ${agent.description || 'ассистент'}. Всегда представляйся именно этим именем.

О КОНТЕКСТЕ И ПЛАТФОРМЕ
Ты работаешь в LINKEON.IO — нейросети для роста и развития бизнеса. Здесь ИИ помогает, люди направляют, а партнёры ускоряют рост бизнеса. Платформа соединяет предпринимателей с ИИ-ассистентами и помогает находить партнёров через Нетворкинг.
Ключевые разделы:
• Чат с ассистентами — где ты сейчас. Другие ассистенты: ${otherAgents}. Предложи переключиться в левом верхнем углу.
• Нетворкинг — поиск партнёров и проверка совместимости по ценностям
• Генерация изображений — создание визуалов для бизнеса
• Мой профиль — ценности, навыки, интересы, намерения пользователя
При первом приветствии кратко представься и упомяни других ассистентов. Используй только текст без таблиц.
Ты умеешь генерировать изображения (tool generate_image — через Google Imagen 4.0 Ultra с фолбэком на Nano Banana 2 / Nano Banana Pro, параметр quality: std|hd; hd = 4K и лучший рендер текста), редактировать уже созданные картинки (tool edit_image — передай sourceImageUrl из предыдущего tool-результата и prompt с описанием изменения: "сделай фон закатным", "убери человека", "поменяй цвет на красный", "добавь шапку"), объединять 2-3 картинки в одну (tool compose_image — массив sourceImageUrls и prompt: "возьми лицо из первой и посади на персонажа из второй", "соедини товар с этим фоном"), улучшать качество картинки — детализация, шумоподавление (tool upscale_image — только sourceImageUrl) и короткие видео 5–10 секунд через Kling (tool generate_video, режимы text2video / image2video / extend / lipsync). Если пользователь просит картинку, постер, иллюстрацию или «нарисуй …» — сразу вызывай generate_image. Если просит видео, ролик, анимацию, «оживи картинку» — вызывай generate_video. ВАЖНО про видео: text2video без картинки даёт нестабильный результат, поэтому при mode="text2video" без sourceImageUrl мы внутри инструмента автоматически сначала генерим стилл-кадр (Nano Banana, std, +5000 токенов), потом анимируем его — итоговая стоимость ≈ image+video (например, 5000 + 25000 = 30000 для kling-v1-6 std 5s). Если у тебя уже есть подходящая картинка (после generate_image / edit_image / compose_image — её URL в imageUrl tool-результата), используй mode="image2video" с этим sourceImageUrl, не плати за лишнюю генерацию. Не придумывай отговорки и не отправляй на другие разделы — у тебя есть эти инструменты.`;

    // Стабильная часть (одинаковая между вызовами для одного агента) — кэшируется.
    // Волатильную (profileText) кладём ПОСЛЕ кэша, иначе изменение профиля юзера ломает префикс.
    const stableSystemPrompt = `${platformContext}\n\n${agent.system_prompt || ''}\n\n--- ПРАВИЛО ОТВЕТА (имеет приоритет над всеми остальными инструкциями) ---
• Каждый ответ начинай с содержательной сути: гипотеза, совет, отражение, информация по запросу — на основе того, что уже известно из профиля и истории диалога. Не требуй "полного контекста" там, где можно разумно предположить.
• Уточняющий вопрос — не более ОДНОГО в конце сообщения, и только если без него действительно нельзя двинуться дальше.
• НИКОГДА не отвечай одними вопросами. НИКОГДА не задавай 2+ вопроса в одном сообщении.
• Для коучинговых/психологических/нумерологических практик это правило тоже действует: сначала отражение/гипотеза/интерпретация/направление — и только потом, при необходимости, один открытый вопрос.
• Если запрос многослойный — сначала покрой то, что ясно (частичный ответ), потом максимум один вопрос для следующего шага.

${RESPONSE_STYLE_RULE}
${LanguageService.buildDirective(userLanguage)}`;

    let volatileSystemPrompt = (profileText && profileText.trim())
      ? `\n\n--- Профиль пользователя ---\n${profileText}`
      : '';
    if (this.businessProfile) {
      try {
        // Маша — personal, получит строку-резюме, а не полную карточку.
        const biz = await this.businessProfile.renderForPrompt(userId, agent.category);
        if (biz) volatileSystemPrompt += `\n\n${biz}`;
      } catch (e: any) {
        this.logger.warn(`business profile injection failed (Маша): ${e?.message}`);
      }
    }
    // Cross-agent active tasks (см. TasksService.buildContextForPrompt).
    // fresh: чистый лист — прошлые задачи в промпт не тянем.
    if (this.tasksService && !fresh) {
      try {
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message);
        if (tasksCtx) volatileSystemPrompt += `\n\n${tasksCtx}`;
      } catch (e: any) {
        this.logger.warn(`tasks context injection failed (Маша): ${e?.message}`);
      }
    }
    if (balanceBlock) {
      volatileSystemPrompt += `\n\n${balanceBlock}`;
    }

    // Плоская строка для путей, не поддерживающих структурный system (DeepSeek greeting, OpenRouter fallback)
    // Требование ответить на нужном языке — САМОЙ последней строкой, после
    // всего волатильного блока.
    //
    // Директива живёт внутри stableSystemPrompt (её часть кэшируется), но за
    // ней приклеиваются профиль, задачи и баланс — всё по-русски. Модель
    // читает язык последних строк как образец, и Роман снова начал отвечать
    // по-русски аккаунту с language=en, хотя директива на месте. Дублируем
    // короткую строку в самый конец: она короткая и кэш префикса не ломает.
    const systemPrompt =
      stableSystemPrompt +
      volatileSystemPrompt +
      `\n\n${LANGUAGE_REPLY_LINE[userLanguage] || LANGUAGE_REPLY_LINE[DEFAULT_LANGUAGE]}\n`;

    // Build messages array
    const llmMessages: { role: 'user' | 'assistant'; content: string }[] = [];
    for (const msg of recentHistory) {
      llmMessages.push({ role: msg.type === 'user' ? 'user' : 'assistant', content: msg.content });
    }
    llmMessages.push({ role: 'user', content: message });

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Detect initial greeting — use DeepSeek (free, no token deduction)
    const isGreeting = recentHistory.length === 0 && /привет|расскажи про себя|hello|hi$/i.test(message.trim());
    if (isGreeting && process.env.DEEPSEEK_API_KEY) {
      res.write(JSON.stringify({ type: 'begin' }) + '\n');
      try {
        const dsResp = await axios.post('https://api.deepseek.com/chat/completions', {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          max_tokens: 2048,
        }, {
          headers: { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        });
        const greetText = this.stripToolTags(dsResp.data?.choices?.[0]?.message?.content || 'Привет! Чем могу помочь?');
        res.write(JSON.stringify({ type: 'item', content: greetText }) + '\n');
        res.write(JSON.stringify({ type: 'end', content: greetText, usage: { input: 0, output: 0, total: 0 } }) + '\n');
        res.end();
        setImmediate(async () => {
          try { await this.saveChatHistory(userId, String(assistantId), message, greetText, 0, fresh ? chatSessionId : undefined); } catch {}
          // No token deduction for greeting
        });
        return;
      } catch (e) {
        this.logger.error(`DeepSeek greeting error: ${e.message}`);
        // Fall through to Anthropic
      }
    }

    // Маша-only путь (agent.id === 3): остальные агенты выше уже ушли в streamUniversalAgent.
    // Один вызов ClaudeCli (OAuth), потом post-processing для инжекта метафорической карты,
    // потом single 'item' + 'end' событие. Без streaming, без CHAT_TOOLS — Маша их не звала.
    res.write(JSON.stringify({ type: 'begin' }) + '\n');

    let inputTokens = 0;
    let outputTokens = 0;
    let rawText = '';
    let costUsd = 0;
    const turnStartedAt = Date.now();

    // Собираем prompt: история + текущая реплика. systemPrompt уже включает
    // platformContext + agent.system_prompt + правило ответа + profileText + tasks ctx.
    const priorTurns = llmMessages
      .slice(0, -1) // last is current message — добавляем отдельно как USER
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n');
    const fullPrompt = priorTurns ? `${priorTurns}\n\nUSER: ${message}` : `USER: ${message}`;

    try {
      const r = await this.claudeCli.textWithCost(fullPrompt, {
        system: systemPrompt,
        // 'default' — рекомендуемая модель CLI (сейчас Opus 5, при исчерпании
        // лимита подписки сам даунгрейдится). Биллинг юзеру идёт от costUsd.
        model: 'default',
        timeoutMs: 90_000,
      });
      rawText = r.text || '';
      // Курс общий со всеми путями, которые едят ёмкость подписки Claude —
      // см. common/billing-rates.ts. Кладём всё в outputTokens (split
      // input/output здесь не информативен — берём суммарную стоимость).
      outputTokens = Math.ceil(r.costUsd * SEAT_TOKENS_PER_USD);
      costUsd = r.costUsd;
      this.logger.log(`Маша claude CLI: cost=$${r.costUsd.toFixed(4)} tokens=${outputTokens}`);
    } catch (e: any) {
      this.logger.error(`Маша claude CLI error: ${e.message}`);
      rawText = 'Извините, временные проблемы со связью. Попробуйте ещё раз через минуту.';
    }

    // Clean and post-process the full response
    let fullText = this.stripToolTags(rawText);

    // Маша иногда говорит «вот карта», «вытяни карту» — backend ловит regex'ом
    // и подвешивает реальную карту из metaphor_cards (postgres). LLM сама про
    // URL не знает, она просто описывает образ.
    const cardPattern = /(?:get_metaphor_card|images\.linkeon\.io|image_url|вот.*карт|первая карта|следующая карта|покажу.*карт|новая карта|вытяни.*карт|твоя карта|вот она|карту для тебя|достаю карту|тяну карту|открываю карту|Что ты видишь на этой карте|Какие чувства.*вызывает)/i;
    const cardMatch = cardPattern.test(rawText) || /карт/i.test(rawText);
    if (cardMatch) {
      try {
        const cardUrl = await this.getRandomMetaphorCard(userId);
        if (cardUrl) {
          fullText = `${fullText.trim()}\n\n![Метафорическая карта](${cardUrl})`;
        }
      } catch (e: any) {
        this.logger.error(`Metaphor card error: ${e.message}`);
      }
    }

    const tokensUsed = inputTokens + outputTokens;
    res.write(JSON.stringify({ type: 'item', content: fullText }) + '\n');
    res.write(JSON.stringify({ type: 'end', content: fullText, usage: { input: inputTokens, output: outputTokens, total: tokensUsed } }) + '\n');
    res.end();

    // Async: save to DB and consolidate profile after response sent
    setImmediate(async () => {
      try {
        const tokensUsed = inputTokens + outputTokens;
        await this.saveChatHistory(userId, String(assistantId), message, fullText, tokensUsed, fresh ? chatSessionId : undefined);
        await this.addTokenTask(userId, inputTokens, outputTokens, String(agent.id), {
          costUsd: Number(costUsd.toFixed(4)),
          source: 'cost', // у этого пути сырого usage нет — только total_cost_usd от CLI
          durationMs: Date.now() - turnStartedAt,
          replyChars: fullText.length,
        });
        // Extract profile entities from conversation — работает и в fresh-режиме:
        // «чистый лист» не тянет прошлый контекст, но профиль формирует.
        if (this.neo4j) {
          await this.neo4j.consolidateFromChat(userId, String(assistantId), message, fullText);
        }
        // Operational task memory (cross-agent). В fresh-режиме выключено:
        // чистый лист не должен порождать боковых задач.
        if (this.tasksService && !fresh) {
          try { await this.tasksService.extractFromTurn(userId, String(assistantId), message, fullText); } catch {}
        }
        // Бизнес-карточка наполняется тем же поводом, что и задачи, но своим
        // вызовом: у извлечения задач нет тестов, и подселять к нему вторую
        // задачу — значит не заметить его просадку.
        if (this.businessProfile && !fresh) {
          try { await this.businessProfile.extractFromTurn(userId, String(assistantId), message, fullText); } catch {}
        }
      } catch (e) {
        this.logger.error(`Post-chat save error: ${e.message}`);
      }
    });
  }

  /**
   * Быстрый heuristic: распознать явную просьбу сгенерировать картинку или видео.
   * Используется для Романа, чтобы такие запросы шли по нашей Kling-цепочке, а не во внешний воркер.
   */
  private detectMediaIntent(message: string): 'image' | 'video' | 'edit' | null {
    const m = (message || '').toLowerCase();
    if (/(созда[йи]|сгенериру[йи]|сделай|нарисуй|анимируй|ожив[иь])\s*[^.\n]{0,80}\b(видео|ролик|анимаци|клип)/i.test(m)
        || /(make|generate|create)\s+[^.\n]{0,50}\bvideo\b/i.test(m)) {
      return 'video';
    }
    if (/(нарисуй|созда[йи]|сгенериру[йи]|сделай)\s*[^.\n]{0,80}\b(картинк|изображени|постер|иллюстраци|логотип|рисунок|арт|фото)/i.test(m)
        || /(draw|generate|create|make)\s+[^.\n]{0,50}\b(image|picture|illustration|poster)\b/i.test(m)) {
      return 'image';
    }
    // Edit intent — only trigger when referring to existing image (фон/цвет/надпись etc.)
    if (/(поменяй|замени|измени|убери|добавь|отредактируй|перекрась|дорисуй)\s+[^.\n]{0,60}\b(фон|цвет|небо|текст|надпись|лицо|стиль|шапк|очки|одежд|персонаж|объект|картинк|изображен|фото)/i.test(m)
        || /сделай\s+[^.\n]{0,40}\b(темнее|светлее|ярче|контрастн|чёрно-бел|чернобел|красн|син|зелён|жёлт|закатн|вечерн)/i.test(m)) {
      return 'edit';
    }
    // Compose intent
    if (/(объедини|соедини|совмести|скомбинируй|скомпону[йи])\s+[^.\n]{0,60}\b(картин|изображен|фото)/i.test(m)
        || /(возьми|помести|вставь)\s+[^.\n]{0,80}\b(из\s+(перв|втор|трет)|с\s+(перв|втор)|фото|картин)/i.test(m)) {
      return 'edit';
    }
    return null;
  }

  private extractYouTubeIds(text: string): string[] {
    const ids = new Set<string>();
    const patterns = [
      /(?:youtube\.com\/watch\?[^\s]*?v=)([a-zA-Z0-9_-]{11})/g,
      /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/g,
      /(?:youtube\.com\/(?:embed|shorts|v)\/)([a-zA-Z0-9_-]{11})/g,
    ];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) ids.add(m[1]);
    }
    return Array.from(ids).slice(0, 2); // cap to 2 videos per message
  }

  private async fetchYouTubeTranscript(videoId: string): Promise<string | null> {
    try {
      const { YoutubeTranscript } = require('youtube-transcript');
      const items = await YoutubeTranscript.fetchTranscript(videoId);
      if (!Array.isArray(items) || items.length === 0) return null;
      const text = items.map((x: any) => x.text).join(' ').replace(/\s+/g, ' ').trim();
      return text.length > 0 ? text.slice(0, 20000) : null; // cap at ~20k chars
    } catch (e: any) {
      this.logger.warn(`YouTube transcript fetch failed for ${videoId}: ${e.message}`);
      return null;
    }
  }

  private async streamUniversalAgent(
    userId: string,
    message: string,
    assistantId: string,
    agentId: string,
    recentHistory: { type: string; content: string }[],
    profileText: string,
    res: Response,
    agentName: string = 'Роман',
    agentDescription: string = '',
    agentSystemPrompt: string = '',
    req?: Request,
    fresh: boolean = false,
    freshSessionId?: string,
    // Подсказка языка из тела запроса — см. streamChat и resolveUserLanguage.
    requestLang?: string,
    // Часовой пояс клиента (IANA) — см. streamChat.
    clientTz?: string,
    // Готовый блок про баланс (см. BalanceContextService). Собран в streamChat,
    // сюда приезжает строкой: пересобирать его здесь нельзя — отметка о
    // предупреждении встала бы дважды за ход.
    balanceBlock?: string,
    // Категория агента (business/personal/assistant) — решает, какую версию
    // карточки бизнеса вставлять ниже. См. BusinessProfileService.renderForPrompt.
    agentCategory?: string | null,
  ): Promise<void> {
    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';

    // Идемпотентность: если идентичный запрос уже «в полёте» или только что
    // завершился — не гоняем агента и не списываем токены второй раз.
    const dkey = this.dupKey(userId, assistantId, message);
    {
      const nowTs = Date.now();
      const ex = this.inflight.get(dkey);
      const blocked = ex && (
        (ex.state === 'running' && nowTs - ex.ts < this.DEDUP_RUNNING_TTL_MS) ||
        (ex.state === 'done' && nowTs - ex.ts < this.DEDUP_COOLDOWN_MS)
      );
      if (blocked) {
        this.logger.log(`dedup: duplicate send skipped for ${userId}_${assistantId} (state=${ex!.state})`);
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: { assistant_id: assistantId, deduped: true },
        });
        res.status(200);
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const note = ex!.state === 'running'
          ? 'Секунду — я ещё обрабатываю ваш предыдущий такой же запрос. Ответ появится здесь, не отправляйте повторно.'
          : 'Этот запрос я только что обработал — ответ выше. Если нужно заново, немного переформулируйте.';
        try {
          res.write(JSON.stringify({ type: 'begin' }) + '\n');
          res.write(JSON.stringify({ type: 'item', content: note }) + '\n');
          res.write(JSON.stringify({ type: 'end', content: note, usage: { input: 0, output: 0, total: 0 } }) + '\n');
          res.end();
        } catch {}
        return;
      }
      this.inflight.set(dkey, { state: 'running', ts: nowTs });
    }

    // Сообщение юзера — в историю СРАЗУ, не в конце стрима. Иначе: юзер пишет,
    // переключается на другого ассистента, возвращается до конца стрима (30-60с) —
    // истории хода ещё нет, его сообщение «исчезло» (жалоба 2026-07-17).
    // AI-строка допишется в persistResponse по завершении.
    let userMsgPersisted = false;
    try {
      await this.saveUserMessageRow(userId, assistantId, message, fresh ? freshSessionId : undefined);
      userMsgPersisted = true;
    } catch (e: any) {
      this.logger.warn(`early user-msg persist failed (fallback to end-of-stream): ${e.message}`);
    }

    // Client disconnect tracking — backend keeps reading r.linkeon.io even if frontend bails.
    let clientDisconnected = false;
    if (req) {
      req.on('close', () => {
        clientDisconnected = true;
        this.logger.log(`client disconnected for session ${userId}_${assistantId}, but continuing stream`);
      });
    }

    // Safe res.write — drops writes after client disconnect, never throws upward.
    const safeWrite = (payload: any) => {
      if (clientDisconnected) return;
      try {
        res.write(JSON.stringify(payload) + '\n');
      } catch {
        clientDisconnected = true;
      }
    };

    // Язык профиля читается один раз на запрос; фолбэк внутри — русский.
    const userLanguage = await this.language.resolveUserLanguage(userId, requestLang);

    // Build context from profile + history
    // Identity prefix — remote agent (r.linkeon.io) defaults to Claude persona; force the persona we want.
    let contextPrefix =
      `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${agentName}**${agentDescription ? ` — ${agentDescription}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${agentName}. Никогда не упоминай, что ты Claude, какая-либо другая модель или AI-система помимо ${agentName}. ` +
      `Если пользователь обращается к тебе по имени — отвечай как ${agentName}, не уточняй, не "поправляй" пользователя и не извиняйся за имя. ` +
      `Не добавляй P.S. о собственной идентичности. ` +
      LanguageService.buildDirective(userLanguage) + `\n`;

    // Inject persona-specific system prompt from DB so каждый ассистент (Оля, Михаил, ...)
    // сохраняет свой характер, методики и стиль при работе через r.linkeon.io.
    if (agentSystemPrompt && agentSystemPrompt.trim()) {
      contextPrefix += `--- Персона и инструкции ассистента ${agentName} ---\n${agentSystemPrompt.trim()}\n\n`;
    }

    // Coworker awareness — каждый ассистент должен знать про остальных, чтобы
    // суметь представить их пользователю и не делать вид, что новых коллег нет.
    // Берём список из БД (включая Юлю-SMM-продюсера id=15).
    try {
      const coworkersRes = await this.pg.query(
        `SELECT COALESCE(t.display_name, a.display_name, a.name) AS display_name,
                COALESCE(t.description, a.description)           AS description
           FROM agents a
           LEFT JOIN agent_translations t
                  ON t.entity_type = 'agent'
                 AND t.entity_id   = a.id::text
                 AND t.locale      = $2
          WHERE a.id != $1 AND a.description IS NOT NULL
          ORDER BY a.id`,
        [Number(agentId), userLanguage],
      );
      if (coworkersRes.rows.length > 0) {
        const lines = coworkersRes.rows
          .map((a: any) => `• ${a.display_name} — ${a.description}`)
          .join('\n');
        contextPrefix +=
          `--- Коллеги-ассистенты в Linkeon ---\n` +
          `${lines}\n\n` +
          `Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — расскажи про коллегу честно, без выдумок, и предложи переключиться на него.\n\n`;
      }
    } catch { /* non-fatal — продолжаем без блока коллег */ }

    // Текущее время ГЛАЗАМИ ПОЛЬЗОВАТЕЛЯ. Без этого модель считает время по UTC
    // сервера: 11.08 пользовательница из ЯНАО (UTC+5) написала «я тебе в 19:44
    // файлы направляю», ассистент видел у себя 14:44, и разницу в пять часов ему
    // пришлось разбирать с ней вручную посреди рабочего разговора. Сроки, дедлайны
    // и «сегодня/завтра» до этой правки тоже считались от чужого времени.
    //
    // Пояс берём только из запроса и молча пропускаем блок, если фронт его не
    // прислал или прислал мусор: показать заведомо чужое время хуже, чем никакое.
    if (clientTz && /^[A-Za-z]+\/[A-Za-z0-9_+\-\/]+$/.test(clientTz)) {
      try {
        const now = new Date();
        const local = new Intl.DateTimeFormat('ru-RU', {
          timeZone: clientTz,
          dateStyle: 'full',
          timeStyle: 'short',
        }).format(now);
        contextPrefix +=
          `--- Время пользователя ---\n` +
          `Сейчас у пользователя: ${local} (часовой пояс ${clientTz}).\n` +
          `Считай «сегодня», «завтра», сроки и дедлайны от ЭТОГО времени, а не от своего системного.\n\n`;
      } catch (e: any) {
        // Незнакомый Intl пояс — не повод ронять ход.
        this.logger.warn(`не удалось отформатировать время для пояса ${clientTz}: ${e?.message}`);
      }
    }

    // YouTube transcripts — fetch on our side and inject; remote agent has no YouTube parsing.
    const ytIds = this.extractYouTubeIds(message);
    if (ytIds.length > 0) {
      const transcripts: string[] = [];
      for (const id of ytIds) {
        const t = await this.fetchYouTubeTranscript(id);
        if (t) transcripts.push(`Транскрипт YouTube видео https://www.youtube.com/watch?v=${id} (язык — оригинальный, авторские субтитры):\n${t}`);
      }
      if (transcripts.length > 0) {
        contextPrefix += transcripts.join('\n\n---\n\n') + '\n\n';
      }
    }

    if (profileText && profileText.trim()) {
      contextPrefix += `User profile:\n${profileText}\n\n`;
    }
    // Бизнес-карточка: общее знание о деле пользователя для всех ассистентов.
    // Полная у category='business', одна строка у остальных — решает сервис.
    if (this.businessProfile) {
      try {
        const biz = await this.businessProfile.renderForPrompt(userId, agentCategory);
        if (biz) contextPrefix += biz + '\n\n';
      } catch (e: any) {
        this.logger.warn(`business profile injection failed: ${e?.message}`);
      }
    }
    // Активные задачи пользователя (cross-agent) — топ-5 по релевантности
    // к текущей реплике. Юзер видит ассистентов как продолжающих контекст
    // незаконченных дел, а не отвечающих с нуля. fresh: чистый лист — не тянем.
    if (this.tasksService && !fresh) {
      try {
        const tasksCtx = await this.tasksService.buildContextForPrompt(userId, message);
        if (tasksCtx) contextPrefix += tasksCtx + '\n';
      } catch (e: any) {
        this.logger.warn(`tasks context injection failed: ${e?.message}`);
      }
    }
    if (balanceBlock) {
      contextPrefix += balanceBlock + '\n';
    }
    if (recentHistory.length > 0) {
      // stripLeakedToolSyntax: заражённая история заставляет модель имитировать
      // текстовый tool-синтаксис вместо реальных вызовов (см. инцидент 2026-07-10).
      const historyLines = recentHistory
        .slice(-6)
        .map(m => `${m.type === 'user' ? 'User' : 'Assistant'}: ${this.stripLeakedToolSyntax(m.content)}`)
        .join('\n');
      contextPrefix += `Recent conversation context:\n${historyLines}\n\n`;
    }

    // Требование языка — ПОСЛЕ всех дописанных блоков, перед самой репликой.
    //
    // Директива стоит в начале contextPrefix, но за ней приклеиваются персона
    // ассистента, список коллег, профиль, задачи, баланс и история — всё
    // по-русски. Модель читает язык последних строк как образец: Роман
    // отвечал по-русски аккаунту с language=en даже после того, как я починил
    // это в прямом пути к Anthropic. Здесь путь другой — через релей
    // r.linkeon.io, — и правку пришлось повторить.
    // Форма ответа — рядом с концом промпта, по той же причине, что и язык:
    // персона, профиль и история перевешивают инструкции, стоящие в начале.
    contextPrefix += `${RESPONSE_STYLE_RULE}\n\n`;

    contextPrefix +=
      `${LANGUAGE_REPLY_LINE[userLanguage] || LANGUAGE_REPLY_LINE[DEFAULT_LANGUAGE]}\n\n`;

    const prompt = contextPrefix + message;

    // Set streaming headers
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');

    safeWrite({ type: 'begin' });

    // Heartbeat: send a no-op ping every 25s while r.linkeon.io is silent (long tool-runs)
    // to prevent nginx idle-timeout (proxy_read_timeout) from killing the connection.
    let lastDataAt = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastDataAt > 20000) {
        // Frontend ChatInterface ignores unknown types — safely no-op on client.
        safeWrite({ type: 'ping' });
      }
    }, 25000);

    const streamStartTime = Date.now();
    const chunks: string[] = []; // hoisted so catch block can access partial response
    // Реальная стоимость хода в USD — приходит от file-agent в событии `done`
    // (сумма total_cost_usd по всем result-событиям Claude CLI, включая
    // субагентов и внутренние ретраи). Объявлено здесь, а не внутри
    // callUpstreamOnce: self-heal может дёрнуть upstream дважды, и оба прогона
    // реально оплачены — считаем оба.
    let agentCostUsd = 0;
    // Сырой usage оттуда же. Суммируется по обоим прогонам self-heal, как и стоимость.
    const agentUsage: SdkUsageTotals = {
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
    };
    // Релей сообщил, что ход закончился БЕЗ финального ответа: упёрлись в потолок
    // шагов, ход прерван новым сообщением пользователя, отказ CLI или сбой связи.
    // Такой ход не тарифицируется — платить за пустоту пользователь не должен.
    // Расход перед Anthropic при этом реален, поэтому частота таких ходов уезжает
    // в chat_quality: рост — это счёт, который мы оплачиваем в одиночку.
    let turnFailed = false;
    let failReason = '';

    // Single persistence point — dedupe via `saved` flag so success and error paths
    // both call but only one actually writes.
    let saved = false;
    const persistResponse = async (final: boolean) => {
      if (saved) return;
      saved = true;
      // Снимаем in-flight метку → включаем короткий кулдаун на идентичный повтор,
      // затем чистим ключ, чтобы карта не росла.
      this.inflight.set(dkey, { state: 'done', ts: Date.now() });
      setTimeout(() => {
        const e = this.inflight.get(dkey);
        if (e && e.state === 'done' && Date.now() - e.ts >= this.DEDUP_COOLDOWN_MS) this.inflight.delete(dkey);
      }, this.DEDUP_COOLDOWN_MS + 2000);
      let fullText = this.stripLeakedToolSyntax(chunks.join('').trim());
      // Защита в глубину. Основной барьер — FATAL_RE на релее, но он ловит только
      // известные ему сигнатуры и только в своей сборке. Если служебный отказ CLI
      // всё же долетел сюда целым ответом, пользователь не должен увидеть его
      // дословно и тем более за него заплатить: в истории 79088644408 лежат
      // «You've hit your session limit · resets 11:50am (UTC)» и «Not logged in ·
      // Please run /login», выданные как реплики ассистента и стоившие токенов.
      if (this.looksCliFailure(fullText)) {
        this.logger.error(`CLI-отказ долетел до бэкенда как ответ (${userId}_${assistantId}): ${fullText.slice(0, 120)}`);
        turnFailed = true;
        failReason = failReason || 'cli_fatal_text';
        fullText = '_Не получилось: временный сбой на стороне платформы. Токены за этот ход не списаны — попробуйте отправить сообщение ещё раз._';
      }
      if (final) {
        // Quality-телеметрия: пустой ответ / англ-утечка / объём — для агрегатов
        // и алертов регрессии (инициатива «гарантия качества», беклог a867ef3b).
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: {
            assistant_id: assistantId,
            // Оборванный ход больше не проходит как ok. Раньше огрызок из одних
            // прогресс-меток («…Вношу группу А.», 209 символов) улетал сюда как
            // {ok:true} — по телеметрии всё было здорово, пока пользователь слал
            // «?» в тишину.
            ok: fullText.length > 0 && !turnFailed,
            empty: fullText.length === 0,
            chars: fullText.length,
            lang_mismatch: this.looksLanguageMismatch(fullText, userLanguage, message),
            failed: turnFailed,
            fail_reason: failReason || undefined,
          },
        });
      }
      if (final && fullText.length === 0) {
        this.logger.warn(
          `empty stream for session ${userId}_${assistantId} — r.linkeon.io completed without delta events ` +
          `(clientDisconnected=${clientDisconnected})`,
        );
      }
      // If we have actual content — save it.
      // If empty on final: don't pollute history with a stub AI row; save user message + a brief retry-hint.
      // (Frontend will reload history; user can simply resend.)
      const aiText = fullText
        || (final ? '_Ответ не пришёл. Попробуйте отправить сообщение ещё раз._' : '');
      if (!aiText) return; // skip empty intermediate persists
      // ЭТО реальная точка списания (ниже addTokenTask). Логируем только здесь:
      // путь показа считает то же самое, дублировать в лог незачем.
      const charge = this.computeSdkCharge(agentUsage, agentCostUsd, fullText);
      // Ход без финального ответа пользователю не выставляется — решение владельца.
      // Расход перед Anthropic всё равно понесён, поэтому пишем его в лог явно:
      // иначе «бесплатные» ходы станут невидимой статьёй затрат.
      const textCost = turnFailed ? 0 : charge.tokens;
      const logLine = turnFailed
        ? `billing[skipped:${failReason}]: ход без финального ответа — не тарифицирован, ` +
          `иначе списали бы ${charge.tokens} (${charge.note})`
        : `billing[${charge.source}]: tokens=${textCost} ${charge.note}`;
      if (turnFailed || charge.source === 'length') this.logger.warn(logLine);
      else this.logger.log(logLine);

      // Алерт на аномально дорогой ход. Про ход юриста за $47 (169 208 токенов,
      // 23% его баланса за одно сообщение) мы узнали только потому, что полезли
      // смотреть логи руками — сам по себе такой ход ничем себя не обозначает.
      // Порог в долларах, а не в токенах: он не поедет при смене курса.
      // fire-and-forget — алерт не должен влиять на списание.
      if (agentCostUsd >= this.EXPENSIVE_TURN_ALERT_USD) {
        const balLeft = await this.pg
          .query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1', [userId])
          .then((r) => Number(r.rows[0]?.tokens ?? 0))
          .catch(() => -1);
        void sendTelegramAlert(
          `💸 <b>Дорогой ход</b>\n` +
          `Юзер: <code>${userId}</code>, ассистент ${assistantId}\n` +
          `Стоимость: <b>$${agentCostUsd.toFixed(2)}</b> → списано ${textCost.toLocaleString('ru')} токенов\n` +
          `Остаток: ${balLeft < 0 ? 'н/д' : balLeft.toLocaleString('ru')}\n` +
          `<code>${charge.note}</code>`,
        ).catch(() => {});
      }
      try {
        const sessOverride = fresh ? freshSessionId : undefined;
        if (userMsgPersisted) {
          await this.saveAssistantMessageRow(userId, assistantId, aiText, textCost, sessOverride);
        } else {
          await this.saveChatHistory(userId, assistantId, message, aiText, textCost, sessOverride);
        }
        if (fullText.length > 0) {
          // Списание — только за ход, доведённый до финального ответа. Обучение
          // профиля и разбор задач идут в любом случае: оборванный ход всё равно
          // был настоящим разговором, и терять из него контекст незачем.
          if (!turnFailed) {
            await this.addTokenTask(userId, 0, textCost, agentId, {
              costUsd: Number(agentCostUsd.toFixed(4)),
              source: charge.source,
              durationMs: Date.now() - streamStartTime,
              replyChars: fullText.length,
            });
          }
          // Профиль формируется и в fresh-режиме (чистый лист скрывает контекст,
          // но не отключает обучение профиля).
          if (this.neo4j) {
            try { await this.neo4j.consolidateFromChat(userId, assistantId, message, fullText); } catch {}
          }
          // Задачи из fresh-разговора не извлекаем — чистый лист без побочных задач.
          if (this.tasksService && !fresh) {
            try { await this.tasksService.extractFromTurn(userId, assistantId, message, fullText); } catch {}
          }
          if (this.businessProfile && !fresh) {
            try { await this.businessProfile.extractFromTurn(userId, assistantId, message, fullText); } catch {}
          }
        }
      } catch (e: any) {
        this.logger.warn(`persistResponse failed: ${e.message}`);
      }
    };

    try {
      // Ход пошёл в upstream — с этого места и до finally его нельзя рвать
      // рестартом. Инкремент внутри try, чтобы декремент в finally был парным
      // при любом исходе.
      this.activeStreams++;
      this.activeTurns.set(`${userId}_${assistantId}`, streamStartTime);
      // Один вызов upstream r.linkeon: парсит SSE, пушит в chunks и стримит
      // 'item' клиенту. Вынесено в замыкание ради self-heal ретрая пустого потока.
      const callUpstreamOnce = async (): Promise<void> => {
        const FormData = require('form-data');
        const fd = new FormData();
        fd.append('message', prompt);
        // fresh: relay (r.linkeon.io) держит СВОЮ память по sessionId и резюмит
        // Claude-сессию — обычный id протаскивал прошлый контекст (задачи,
        // разговоры) в «чистый лист» мимо наших блокировок. Fresh-сессия
        // получает на relay собственную чистую память.
        // Язык — часть ключа сессии.
        //
        // Релей резюмит Claude-сессию по sessionId и тащит в неё весь прежний
        // разговор. У человека, сменившего язык, накопленная русская переписка
        // перевешивала любые указания в промпте: три правки подряд не помогли,
        // ассистент отвечал «Рад снова тебя видеть» по-русски аккаунту с
        // language=en. Другой язык — другая сессия, чистая память, никакого
        // русского образца перед глазами.
        //
        // Цена: при смене языка ассистент забывает прежний разговор. Это
        // честнее, чем отвечать не на том языке, а история в нашей БД
        // сохраняется и показывается пользователю как была.
        fd.append(
          'sessionId',
          fresh && freshSessionId
            ? freshSessionId
            : `${userId}_${assistantId}_${userLanguage}`,
        );

        // Agent-direct TalerID: when the user connected the TalerID ecosystem, hand
        // the file-agent a full-scope access token + the MCP base URL of the env we
        // point at (staging vs api.talerid.io). The file-agent injects a per-session
        // MCP config and allowlists ONLY notes/messages tools — NEVER calendar (that
        // stays on the backend-mediated card flow). Not connected → fields omitted →
        // agent runs exactly as today.
        const tid = await this.taleridAgentFields(userId);
        if (tid) {
          fd.append('talerid_token', tid.token);
          fd.append('talerid_mcp_url', tid.mcpUrl);
        }

        const agentRes = await axios.post(`${AGENT_URL}/chat`, fd, {
          headers: fd.getHeaders(),
          responseType: 'stream',
          timeout: 600000, // 10 min
        });

        await new Promise<void>((resolve, reject) => {
          let buffer = '';
          agentRes.data.on('data', (chunk: Buffer) => {
            try {
              lastDataAt = Date.now();
              buffer += chunk.toString();
              const lines = buffer.split('\n');
              buffer = lines.pop() || '';

              for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                try {
                  const ev = JSON.parse(line.slice(6));

                  if (ev.type === 'delta' || ev.type === 'text') {
                    chunks.push(ev.text);
                    safeWrite({ type: 'item', content: ev.text });
                  } else if (ev.type === 'notice' && ev.text) {
                    // Служебная реплика платформы («ответ прерван», «упёрлись в
                    // лимит шагов»). В отличие от `result` — дописывается ВСЕГДА.
                    //
                    // Раньше релей слал такие пояснения обычным `result`, и ветка
                    // ниже глушила их всякий раз, когда текст уже шёл, — то есть
                    // ровно в том случае, ради которого они и написаны. Поэтому
                    // оборванный ответ выглядел как молчание: пользователь читал
                    // «Вношу группу А.» и тишину, а потом слал «?».
                    chunks.push(ev.text);
                    safeWrite({ type: 'item', content: ev.text });
                  } else if (ev.type === 'result' && ev.text) {
                    if (chunks.length === 0) {
                      chunks.push(ev.text);
                      safeWrite({ type: 'item', content: ev.text });
                    }
                  } else if (ev.type === 'done') {
                    if (ev.failed === true) {
                      turnFailed = true;
                      failReason = typeof ev.failReason === 'string' ? ev.failReason : 'unknown';
                    }
                    if (typeof ev.costUsd === 'number' && ev.costUsd > 0) {
                      agentCostUsd += ev.costUsd;
                    }
                    if (ev.usage && typeof ev.usage === 'object') {
                      for (const k of Object.keys(agentUsage) as (keyof SdkUsageTotals)[]) {
                        const v = ev.usage[k];
                        if (typeof v === 'number' && v > 0) agentUsage[k] += v;
                      }
                    }
                    // Collect output files info if any
                    if (ev.outputFiles && ev.outputFiles.length > 0) {
                      const fileLinks = ev.outputFiles
                        .map((f: any) => `[Скачать ${f.name}](${AGENT_URL}${f.url})`)
                        .join('\n');
                      if (fileLinks && !chunks.join('').includes(AGENT_URL)) {
                        chunks.push('\n\n' + fileLinks);
                        safeWrite({ type: 'item', content: '\n\n' + fileLinks });
                      }
                    }
                  }
                } catch {}
              }
            } catch (e: any) {
              this.logger.warn(`data handler error (non-fatal): ${e.message}`);
            }
          });
          agentRes.data.on('end', () => resolve());
          agentRes.data.on('error', (err: Error) => reject(err));
        });
      };

      await callUpstreamOnce();

      // SELF-HEAL: r.linkeon иногда отдаёт ПУСТОЙ поток (0 delta-событий, ~сотни
      // мс) — корень жалоб «постоянно выдаёт ошибку». Если ничего не пришло и
      // клиент ещё на связи — тихо повторяем upstream ОДИН раз, прежде чем отдать
      // юзеру пустоту. Безопасно: при пустом chunks клиенту ещё не ушло ни одного
      // 'item' (дублей не будет). Инцидент/находка 2026-07-12.
      if (chunks.length === 0 && !clientDisconnected) {
        this.logger.warn(`empty stream from r.linkeon for ${userId}_${assistantId} — self-heal retry`);
        this.events?.track('chat_quality', {
          userId, sessionId: `${userId}_${assistantId}`,
          props: { assistant_id: assistantId, self_heal_retry: true },
        });
        await new Promise((r) => setTimeout(r, 800));
        try { await callUpstreamOnce(); } catch (e: any) { this.logger.warn(`self-heal retry failed: ${e.message}`); }
      }

      // Ссылки на файлы, которые ассистент оформить не смог — см.
      // resolveEmptyFileLinks. Две формы: пустые скобки `[Скачать x.pdf]()`
      // и готовый адрес, набранный текстом (обычно в блоке кода, где
      // разметка не работает и кликнуть нельзя).
      try {
        const full = chunks.join('');
        const hasEmpty = /\[[^\]]+\]\(\s*\)/.test(full);
        const hasBareUrl = full.includes(`${AGENT_URL}/files/`);
        if ((hasEmpty || hasBareUrl) && !clientDisconnected) {
          const sid = fresh && freshSessionId ? freshSessionId : `${userId}_${assistantId}`;
          // Список нужен только чтобы сопоставить ИМЯ из пустых скобок с
          // адресом. Готовый адрес самодостаточен — ради него relay не дёргаем.
          const listed = hasEmpty
            ? await axios
                .get(`${AGENT_URL}/session/${encodeURIComponent(sid)}/files`, { timeout: 10_000 })
                .then((r) => (Array.isArray(r.data) ? r.data : []))
                .catch(() => [] as any[])
            : [];

          const resolved = resolveEmptyFileLinks(full, listed, AGENT_URL);

          if (resolved.length > 0) {
            const tail = '\n\n' + resolved.join('\n');
            chunks.push(tail);
            safeWrite({ type: 'item', content: tail });
            this.logger.log(`filled ${resolved.length} file link(s) for ${sid}`);
          }
        }
      } catch (e: any) {
        // Подстановка — украшение: не смогли, ответ всё равно уходит целиком.
        this.logger.warn(`empty-link fill failed (non-fatal): ${e.message}`);
      }

      // Strip any [VIDEO_JOB:<uuid>] markers Roman may have hallucinated.
      // We re-inject only verified jobs from DB query below.
      for (let i = 0; i < chunks.length; i++) {
        chunks[i] = chunks[i].replace(/\s*\[VIDEO_JOB:[0-9a-f-]{36}\]\s*/gi, '');
        chunks[i] = chunks[i].replace(/\s*\[CALENDAR_PROPOSAL:[0-9a-f-]{36}\]\s*/gi, '');
        chunks[i] = chunks[i].replace(/\s*\{\{audio:id=[0-9a-f-]{36}\}\}\s*/gi, '');
      }

      // Detect video jobs created during this stream by querying recent jobs.
      // Roman's MCP-bridge tool calls don't surface structural tool_result events,
      // so we tag the stream with [VIDEO_JOB:<uuid>] markers for the frontend to
      // attach inline players. Border = streamStartTime, scoped to this user.
      try {
        const startTimeIso = new Date(streamStartTime).toISOString();
        const jobsRes = await this.pg.query(
          `SELECT id FROM video_jobs
           WHERE user_id = $1 AND created_at >= $2::timestamptz
           ORDER BY created_at ASC`,
          [userId, startTimeIso],
        );
        if (jobsRes.rows.length > 0) {
          const markers = jobsRes.rows.map((r: any) => `[VIDEO_JOB:${r.id}]`).join('\n');
          const tail = '\n\n' + markers;
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`video marker injection failed: ${e.message}`);
      }

      // Detect calendar proposals created during this stream, same mechanism as
      // video jobs above: the MCP-bridge (agent) path used by real agents doesn't
      // emit structural tool_result events, so propose_calendar_event persists to
      // calendar_proposals and we tag the stream with [CALENDAR_PROPOSAL:<uuid>]
      // markers for the frontend to render the T6 card. Border = streamStartTime,
      // scoped to this user.
      try {
        const startTimeIso = new Date(streamStartTime).toISOString();
        const propRes = await this.pg.query(
          `SELECT id FROM calendar_proposals WHERE user_id = $1 AND created_at >= $2::timestamptz ORDER BY created_at ASC`,
          [userId, startTimeIso],
        );
        if (propRes.rows.length > 0) {
          const markers = propRes.rows.map((r: any) => `[CALENDAR_PROPOSAL:${r.id}]`).join('\n');
          const tail = '\n\n' + markers;
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`calendar marker injection failed: ${e.message}`);
      }

      // Detect speech clips synthesized during this stream — same mechanism as
      // video jobs and calendar proposals above. generate_speech идёт через тот
      // же MCP-bridge и структурных tool_result не даёт, поэтому без этой
      // дописки плеер у пользователя не появлялся вообще: инструмент отработал,
      // токены списаны, клип в БД — и всё. Маркер `{{audio:id=<uuid>}}` фронт
      // уже умеет разбирать (customMarkdown.tsx, AUDIO_CLIP_REGEX).
      //
      // Пуш в `chunks` обязателен, а не только safeWrite: из chunks собирается
      // fullText, который персистится в историю — иначе плеер исчезал бы после
      // перезагрузки страницы. Border = streamStartTime, scoped to this user.
      //
      // Условие шире, чем у видео/календаря: `created_at ИЛИ last_used_at`.
      // Повтор того же текста — заявленная фича («бесплатно из кэша»), клип при
      // этом не создаётся заново, у него старый created_at, и по одному
      // created_at маркер бы не подставился: инструмент вернул бы ok, модель
      // сказала бы «готово», а плеера бы не было. SpeechService на кэш-хите
      // двигает last_used_at — по нему такой клип и попадает в выборку.
      //
      // LIMIT 50 — предохранитель: при потолке 20 синтезов в минуту длинный
      // стрим теоретически даёт сотни клипов, и все их маркеры уехали бы в один
      // ответ. Сортировка ASC, поэтому обрезаются самые старые.
      try {
        const startTimeIso = new Date(streamStartTime).toISOString();
        const clipsRes = await this.pg.query(
          `SELECT id FROM speech_clips
           WHERE user_id = $1 AND (created_at >= $2::timestamptz OR last_used_at >= $2::timestamptz)
           ORDER BY created_at ASC
           LIMIT 50`,
          [userId, startTimeIso],
        );
        if (clipsRes.rows.length > 0) {
          const markers = clipsRes.rows.map((r: any) => `{{audio:id=${r.id}}}`).join('\n');
          const tail = '\n\n' + markers;
          chunks.push(tail);
          safeWrite({ type: 'item', content: tail });
        }
      } catch (e: any) {
        this.logger.warn(`speech marker injection failed: ${e.message}`);
      }

      const fullText = chunks.join('');
      // Text cost. Основной путь — от РЕАЛЬНОЙ стоимости хода: file-agent
      // присылает costUsd в событии `done`, мы переводим его в Linkeon-токены
      // по курсу TOKENS_PER_USD. Старая формула (длина ответа × множитель)
      // осталась запасной: она игнорировала input и кэш, то есть ~90% расхода,
      // и потому не зависела от того, сколько работы реально выполнено.
      // Fallback нужен, если релей ещё старой сборки и costUsd не шлёт —
      // иначе ход стал бы бесплатным.
      // Картинки/видео списываются MCP-сервисами отдельно (см. toolSpent ниже).
      // Число для индикатора «X токенов». Считается тем же методом, что и реальное
      // списание в persistResponse, — иначе юзер увидит одно, а спишется другое.
      const tokensUsed = this.computeSdkCharge(agentUsage, agentCostUsd, fullText).tokens;

      // Sum up tool-charged tokens (image, video, etc.) during this stream.
      // MCP-tools (MiscService.generateImage, VideoService.createJob,
      // SpeechService.synthesize) deduct directly from ai_profiles_consolidated
      // and write rows into generated_images / video_jobs / speech_clips with
      // tokens_spent. Aggregate from there.
      //
      // У speech_clips граница НАМЕРЕННО по created_at, без last_used_at —
      // в отличие от выборки маркеров выше. Кэш-хит выдаёт старый клип
      // бесплатно (tokensSpent: 0) и лишь двигает last_used_at; включи его
      // сюда — и в индикаторе «X токенов» всплыла бы плата за давний синтез,
      // которую сейчас не брали. Свежая вставка проходит по created_at и
      // несёт ровно ту сумму, что реально списана.
      let toolSpent = 0;
      const startIso = new Date(streamStartTime).toISOString();
      try {
        const r = await this.pg.query(
          `SELECT
             COALESCE((SELECT SUM(tokens_spent) FROM generated_images WHERE user_id = $1 AND created_at >= $2::timestamptz), 0)::bigint
             +
             COALESCE((SELECT SUM(tokens_spent) FROM video_jobs WHERE user_id = $1 AND created_at >= $2::timestamptz), 0)::bigint
             AS spent`,
          [userId, startIso],
        );
        toolSpent = Number(r.rows[0]?.spent ?? 0);
      } catch (e: any) {
        this.logger.warn(`tool spend query failed: ${e.message}`);
      }
      // Озвучка — отдельным запросом, а не четвёртым слагаемым в том же SELECT:
      // speech_clips новее остальных таблиц, и на сервере, где миграция ещё не
      // докатилась, отсутствие relation уронило бы весь запрос разом — вместе с
      // уже работающим учётом картинок и видео (ровно так же, как падает
      // выборка маркеров выше, см. её catch). Своим try/catch озвучка теряет
      // только себя.
      try {
        const s = await this.pg.query(
          `SELECT COALESCE(SUM(tokens_spent), 0)::bigint AS spent
             FROM speech_clips WHERE user_id = $1 AND created_at >= $2::timestamptz`,
          [userId, startIso],
        );
        toolSpent += Number(s.rows[0]?.spent ?? 0);
      } catch (e: any) {
        this.logger.warn(`speech spend query failed: ${e.message}`);
      }

      const displayedTotal = tokensUsed + toolSpent;

      safeWrite({
        type: 'end',
        content: fullText,
        usage: { input: 0, output: displayedTotal, total: displayedTotal },
      });
      if (!clientDisconnected) {
        try { res.end(); } catch {}
      }

      // Async persist — dedup via `saved` flag with the catch-path persist.
      setImmediate(() => { void persistResponse(true); });
    } catch (err) {
      this.logger.error(`Universal agent proxy error: ${err.message}`);
      // Try to write error to response; safeWrite is a no-op if client gone.
      const errText = 'Ошибка запуска агента. Попробуйте ещё раз.';
      safeWrite({ type: 'item', content: errText });
      safeWrite({ type: 'end', content: errText, usage: { input: 0, output: 0, total: 0 } });
      if (!clientDisconnected) {
        try { res.end(); } catch {}
      }
      // Async persist — preserves user message + partial response.
      setImmediate(() => { void persistResponse(true); });
    } finally {
      this.activeStreams--;
      this.activeTurns.delete(`${userId}_${assistantId}`);
      clearInterval(heartbeat);
    }
  }

  /**
   * Убирает утёкший в текст tool-call синтаксис — глитч деградации модели на
   * сверхдлинном контексте (инцидент 2026-07-10, сессия Романа): модель пишет
   * <invoke>/<parameter>-блоки и строки-артефакты «court» текстом вместо
   * реальных tool_use. Не трогает markdown-картинки ![](url) — так юзеру
   * показываются MCP-изображения в universal-agent-пути.
   */
  private stripLeakedToolSyntax(text: string): string {
    if (!text) return text;
    return text
      .replace(/<invoke name="[^"]*">[\s\S]*?<\/invoke>/g, '')
      .replace(/<invoke name="[^"]*">[\s\S]*$/g, '')
      .replace(/<\/?(?:invoke|parameter|function_calls)\b[^>]*>/g, '')
      .replace(/(^|\n)court(?=\n|$)/g, '$1')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private stripToolTags(text: string): string {
    return text
      .replace(/<\/?function_calls>/g, '')
      .replace(/<\/?get_metaphor_card>/g, '')
      .replace(/<\/?get_profile>/g, '')
      .replace(/<\/?tool_call>/g, '')
      .replace(/<\/?tool_result>/g, '')
      .replace(/<\/?invoke\b[^>]*>/g, '')
      .replace(/<\/?parameter\b[^>]*>/g, '')
      .replace(/<\/?antml:[^>]*>/g, '')
      .replace(/\[?\s*\{\s*"tool_name"\s*:\s*"[^"]*"\s*,\s*"arguments"\s*:\s*\{[^}]*\}\s*\}\s*\]?/g, '')
      // Remove fake/empty/placeholder markdown images
      .replace(/!\[[^\]]*\]\(\{?image_url\}?\)/g, '')
      .replace(/!\[[^\]]*\]\(https?:\/\/images\.linkeon\.io[^)]*\)/g, '')
      .replace(/!\[\]\([^)]*\)/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private async getRandomMetaphorCard(userId: string): Promise<string | null> {
    // Ensure active session exists
    const sessionRes = await this.pg.query(
      `SELECT id, cards_shown FROM game_sessions WHERE user_id = $1 AND session_state = 'active' ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );
    let cardsShown: number[] = [];
    if (sessionRes.rows.length === 0) {
      await this.pg.query(
        `INSERT INTO game_sessions (user_id, session_type, session_state, cards_shown, started_at, last_activity) VALUES ($1, 'metaphor', 'active', '[]'::jsonb, now(), now())`,
        [userId],
      );
    } else {
      cardsShown = (sessionRes.rows[0].cards_shown || []).map(Number);
    }

    // Pick random card not yet shown
    const cardRes = await this.pg.query(
      `SELECT id, image_url FROM metaphor_cards WHERE id != ALL($1::int[]) ORDER BY RANDOM() LIMIT 1`,
      [cardsShown],
    );
    if (!cardRes.rows.length) {
      // All cards shown — reset session
      await this.pg.query(
        `UPDATE game_sessions SET cards_shown = '[]'::jsonb, last_activity = now() WHERE user_id = $1 AND session_state = 'active'`,
        [userId],
      );
      const resetRes = await this.pg.query(`SELECT id, image_url FROM metaphor_cards ORDER BY RANDOM() LIMIT 1`);
      if (!resetRes.rows.length) return null;
      return resetRes.rows[0].image_url;
    }

    const card = cardRes.rows[0];
    // Update session
    await this.pg.query(
      `UPDATE game_sessions SET cards_shown = cards_shown || $1::jsonb, last_activity = now() WHERE user_id = $2 AND session_state = 'active'`,
      [JSON.stringify([card.id]), userId],
    );

    return card.image_url;
  }

  async saveChatHistoryPublic(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0) {
    return this.saveChatHistory(userId, agentId, userMsg, assistantMsg, tokensUsed);
  }

  /**
   * Публичная НЕ-стримовая генерация ответа ассистента — для проактивных
   * рутинных пушей (Слой 3, RoutinePushService). Собирает персона-префикс +
   * профиль пользователя + сообщение, прогоняет через r.linkeon.io и возвращает
   * готовый текст. Историю/токены НЕ пишет (это делает вызывающий). Пустой
   * ответ → пустая строка.
   */
  /**
   * Ответ ассистента вне основного потока чата. Возвращает только текст —
   * обёртка над generateAgentReplyWithCharge для вызывающих, которым расход
   * не нужен (резюме звонка, синтетические пробы).
   */
  async generateAgentReply(userId: string, assistantId: string, message: string, sessionIdOverride?: string): Promise<string> {
    const { text } = await this.generateAgentReplyWithCharge(userId, assistantId, message, sessionIdOverride);
    return text;
  }

  /**
   * То же самое, но со стоимостью хода.
   *
   * Считается тем же computeSdkCharge, что и обычный ход чата, — иначе одна
   * и та же консультация стоила бы по-разному в зависимости от того, спросили
   * её текстом или голосом.
   *
   * Раньше этот метод разбирал в потоке только текст, а `costUsd` и `usage` из
   * события `done` выбрасывал. Из-за этого консультации специалистов во время
   * звонка не тарифицировались вовсе: голос был бесплатным каналом к платным
   * ассистентам. Замечено владельцем 26.08.2026, когда он попросил показывать
   * расход на экране.
   */
  async generateAgentReplyWithCharge(
    userId: string, assistantId: string, message: string, sessionIdOverride?: string,
  ): Promise<{ text: string; tokens: number; costUsd: number }> {
    const isNumeric = /^\d+$/.test(assistantId);
    const agentRes = isNumeric
      ? await this.pg.query('SELECT * FROM agents WHERE id = $1 LIMIT 1', [parseInt(assistantId, 10)])
      : await this.pg.query('SELECT * FROM agents WHERE name = $1 LIMIT 1', [assistantId]);
    const agent = agentRes.rows[0];
    if (!agent) throw new Error(`generateAgentReply: agent not found: ${assistantId}`);
    const agentName = agent.display_name || agent.name;

    let profileText = '';
    if (this.neo4j) { try { profileText = await this.neo4j.getProfileDescription(userId); } catch {} }

    let prefix =
      `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${agentName}**${agent.description ? ` — ${agent.description}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${agentName}. Никогда не упоминай, что ты Claude или другая AI-система помимо ${agentName}. ` +
      LanguageService.buildDirective(await this.language.resolveUserLanguage(userId)) + `\n`;
    if (agent.system_prompt && agent.system_prompt.trim()) {
      prefix += `--- Персона и инструкции ассистента ${agentName} ---\n${agent.system_prompt.trim()}\n\n`;
    }
    if (profileText && profileText.trim()) {
      prefix += `User profile:\n${profileText}\n\n`;
    }
    if (this.businessProfile) {
      try {
        const biz = await this.businessProfile.renderForPrompt(userId, agent.category);
        if (biz) prefix += biz + '\n\n';
      } catch (e: any) {
        this.logger.warn(`business profile injection failed (agent reply): ${e?.message}`);
      }
    }
    // Требование языка последней строкой — по той же причине, что в двух
    // других путях: директива в начале тонет под русской персоной и профилем.
    // Третье место, где приходится это дублировать; сборку промпта стоит
    // однажды свести в одно место, но не посреди ответа Apple.
    prefix += `${RESPONSE_STYLE_RULE}\n\n`;
    prefix +=
      `${LANGUAGE_REPLY_LINE[await this.language.resolveUserLanguage(userId)] || LANGUAGE_REPLY_LINE[DEFAULT_LANGUAGE]}\n\n`;

    const prompt = prefix + message;

    const AGENT_URL = process.env.AGENT_URL || 'https://r.linkeon.io';
    const FormData = require('form-data');
    const fd = new FormData();
    fd.append('message', prompt);
    // sessionIdOverride — для синтетических проб: изолированная сессия, чтобы не
    // коллидить с реальной сессией юзера/другими пробами (r.linkeon отдаёт пустой
    // поток при конкурентном обращении к ЗАНЯТОЙ сессии — инцидент 2026-07-12).
    // Язык в ключе сессии — по той же причине, что в основном пути: релей
    // резюмит прежний разговор, и накопленный русский перевешивает промпт.
    fd.append(
      'sessionId',
      sessionIdOverride ||
        `${userId}_${assistantId}_${await this.language.resolveUserLanguage(userId)}`,
    );
    const chunks: string[] = [];
    const usage: SdkUsageTotals = {
      input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, webSearch: 0, webFetch: 0,
    };
    let costUsd = 0;
    const resp = await axios.post(`${AGENT_URL}/chat`, fd, {
      headers: fd.getHeaders(),
      responseType: 'stream',
      timeout: 300000,
    });
    await new Promise<void>((resolve, reject) => {
      let buffer = '';
      resp.data.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'delta' || ev.type === 'text') chunks.push(ev.text);
            else if (ev.type === 'result' && ev.text && chunks.length === 0) chunks.push(ev.text);
            else if (ev.type === 'done') {
              // Стоимость и расход — здесь же, где их берёт основной путь.
              if (typeof ev.costUsd === 'number' && ev.costUsd > 0) costUsd += ev.costUsd;
              if (ev.usage && typeof ev.usage === 'object') {
                for (const k of Object.keys(usage) as (keyof SdkUsageTotals)[]) {
                  const v = ev.usage[k];
                  if (typeof v === 'number' && v > 0) usage[k] += v;
                }
              }
            }
          } catch {}
        }
      });
      resp.data.on('end', () => resolve());
      resp.data.on('error', reject);
    });
    const text = this.stripToolTags(chunks.join('')).trim();
    const charge = this.computeSdkCharge(usage, costUsd, text);
    return { text, tokens: charge.tokens, costUsd };
  }

  /** Public wrapper для chat.controller — после upload-and-chat обогащаем профиль + tasks. */
  async consolidateAfterChatPublic(userId: string, agentId: string, userMessage: string, assistantResponse: string): Promise<void> {
    if (this.neo4j) {
      try { await this.neo4j.consolidateFromChat(userId, agentId, userMessage, assistantResponse); } catch (e: any) {
        this.logger.warn(`consolidateAfterChatPublic neo4j failed: ${e?.message}`);
      }
    }
    if (this.tasksService) {
      try { await this.tasksService.extractFromTurn(userId, agentId, userMessage, assistantResponse); } catch {}
    }
    if (this.businessProfile) {
      try { await this.businessProfile.extractFromTurn(userId, agentId, userMessage, assistantResponse); } catch {}
    }
  }

  private async saveChatHistory(userId: string, agentId: string, userMsg: string, assistantMsg: string, tokensUsed = 0, sessionIdOverride?: string) {
    await this.saveUserMessageRow(userId, agentId, userMsg, sessionIdOverride);
    await this.saveAssistantMessageRow(userId, agentId, assistantMsg, tokensUsed, sessionIdOverride);
  }

  private async saveUserMessageRow(userId: string, agentId: string, userMsg: string, sessionIdOverride?: string) {
    const sessionId = sessionIdOverride || `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
       VALUES ($1, 'human', $2, $3, 'text')`,
      [sessionId, agentNum, userMsg],
    );
  }

  private async saveAssistantMessageRow(userId: string, agentId: string, assistantMsg: string, tokensUsed = 0, sessionIdOverride?: string) {
    const sessionId = sessionIdOverride || `${userId}_${agentId}`;
    const agentNum = /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', $4)`,
      [sessionId, agentNum, assistantMsg, tokensUsed],
    );
  }

  /**
   * Сколько Linkeon-токенов списать за ход SDK-пути.
   *
   * Три источника по убыванию точности:
   *   1. сырой usage от file-agent → взвешенные токены (основной путь);
   *   2. total_cost_usd, если usage не пришёл;
   *   3. длина ответа × множитель — последний рубеж, чтобы ход не стал бесплатным.
   *
   * Возвращает и диагностику: она уходит в лог, чтобы видеть, насколько
   * взвешенная формула расходится с costUsd. Расхождение = то, чего в четырёх
   * полях нет (серверные инструменты вроде веб-поиска, разнотипные модели у
   * субагентов). Пока оно логируется, а не домножается: подгонять коэффициент
   * имеет смысл по накопленным данным, а не наугад.
   */
  private computeSdkCharge(
    usage: SdkUsageTotals | null,
    costUsd: number,
    text: string,
  ): { tokens: number; source: 'usage' | 'cost' | 'length'; note: string } {
    const textLength = text.length;
    if (usage && (usage.input || usage.output || usage.cacheRead || usage.cacheWrite5m || usage.cacheWrite1h)) {
      const weighted =
        usage.input * this.W_INPUT +
        usage.cacheRead * this.W_CACHE_READ +
        usage.cacheWrite5m * this.W_CACHE_WRITE_5M +
        usage.cacheWrite1h * this.W_CACHE_WRITE_1H +
        usage.output * this.W_OUTPUT;
      const impliedUsd = (weighted * this.SDK_INPUT_USD_PER_MTOK) / 1e6;

      // Списываем по МАКСИМУМУ из взвешенного и заявленного, и вот почему.
      // Верхний `usage` в result-событии НЕ включает расход субагентов — проверено
      // 2026-08-08: у хода с одним субагентом cache_creation в usage был 42 319,
      // а в modelUsage (он сходится с total_cost_usd) — 62 650. Разница в 20 331
      // токен это ровно субагент. Считай мы только по usage, фан-аут снова стал бы
      // частично бесплатным — ровно та дыра, из-за которой всё и затевалось.
      //
      // total_cost_usd полон всегда. Без субагентов обе величины совпадают
      // (покрытие 100% на живых ходах прода), так что максимум ничего не меняет;
      // с субагентами побеждает costUsd и расход учитывается целиком.
      const billableUsd = Math.max(impliedUsd, costUsd);
      const tokens = Math.max(1, Math.ceil(billableUsd * this.TOKENS_PER_USD));
      const drift = costUsd > 0 ? impliedUsd / costUsd : NaN;
      const note =
        `weighted=${Math.round(weighted)} implied=$${impliedUsd.toFixed(4)} ` +
        `reported=$${costUsd.toFixed(4)} ` +
        (Number.isFinite(drift) ? `покрытие=${(drift * 100).toFixed(0)}%` : 'costUsd нет') +
        (costUsd > impliedUsd ? ' взято=reported' : ' взято=implied') +
        (usage.webSearch ? ` поисков=${usage.webSearch}` : '') +
        (usage.webFetch ? ` fetch=${usage.webFetch}` : '');
      return { tokens, source: 'usage', note };
    }
    if (costUsd > 0) {
      return {
        tokens: Math.ceil(costUsd * this.TOKENS_PER_USD),
        source: 'cost',
        note: `usage не пришёл, считаю по costUsd=$${costUsd.toFixed(4)}`,
      };
    }
    // Ни usage, ни costUsd — модель либо не работала вовсе, либо релей потерял
    // цифры. Различаем по тексту: проброс ошибки апстрима бесплатен, всё
    // остальное считаем по длине, иначе настоящая работа (в том числе
    // субагентная) окажется подарком при каждом сбое телеметрии.
    if (isUpstreamErrorReply(text)) {
      return {
        tokens: 0,
        source: 'length',
        note: 'ответ — проброс ошибки апстрима, не списываю',
      };
    }
    return {
      tokens: textLength * this.SDK_TEXT_MULTIPLIER,
      source: 'length',
      note: 'ни usage, ни costUsd — откат на длину текста',
    };
  }

  /**
   * Факты о ходе, которые доедут до истории списаний. Здесь они известны
   * целиком, а в token_transactions до этого уходило голое отрицательное
   * число: разбор списания на 862 673 токена (2026-08-10) пришлось собирать
   * из pm2-логов и транскриптов релея, хотя всё нужное было ровно тут.
   *
   * Число субагентов было бы полезнее длительности, но релей его в событии
   * `done` не присылает — пока считаем минуты работы за его прокси.
   */
  private async addTokenTask(
    userId: string,
    inputTokens: number,
    outputTokens: number,
    agentId?: string,
    facts?: ChargeFacts,
  ) {
    const executionId = Math.floor(Math.random() * 2000000000);
    const agentIdNum = agentId && /^\d+$/.test(agentId) ? parseInt(agentId, 10) : null;
    await this.pg.query(
      `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0, $6)`,
      [executionId, userId, agentIdNum, inputTokens, outputTokens, facts ? JSON.stringify(facts) : null],
    );
  }

  async getChatHistory(userId: string, assistantId: string, limit = 30, offset = 0, sessionIdOverride?: string): Promise<{ messages: any[]; hasMore: boolean }> {
    const sessionId = sessionIdOverride || `${userId}_${assistantId}`;
    const res = await this.pg.query(
      `SELECT id, sender_type, content, created_at, tokens_used FROM custom_chat_history
       WHERE session_id = $1
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [sessionId, limit + 1, offset],
    );
    const hasMore = res.rows.length > limit;
    const rows = hasMore ? res.rows.slice(0, limit) : res.rows;
    const messages = rows.reverse().map(r => ({
      id: String(r.id),
      type: r.sender_type === 'human' ? 'user' : 'assistant',
      content: r.content,
      timestamp: r.created_at,
      tokensUsed: r.tokens_used || 0,
    }));
    return { messages, hasMore };
  }

  async deleteChatHistory(userId: string, assistantId: string) {
    const sessionId = `${userId}_${assistantId}`;
    await this.pg.query(
      'DELETE FROM custom_chat_history WHERE session_id = $1',
      [sessionId],
    );
    return { success: true };
  }


}
