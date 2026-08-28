import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { ClaudeCliService, ClaudeCliProgressEvent } from '../common/services/claude-cli.service';
import { AgentsService } from '../agents/agents.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgConfigService, TgBotConfigRow } from './tg-config.service';
import { isPrivateConfig } from './tg-chat-kind';

/**
 * Дефолтный ассистент для лички, когда preferred_agent пуст или указывает на
 * несуществующего. 12 — Роман: он стоит у девяти из десяти боевых конфигов,
 * то есть это уже сложившийся выбор, а не новый.
 */
const DEFAULT_AGENT_ID = '12';

export interface IncomingMessageContext {
  chatId: number;
  msgId: number;
  fromTgUserId: number;
  fromTgUserName: string | null;
  text: string;
  replyToBotMessageId?: number;
  replyToFromBot?: boolean;
  isVoice: boolean;
  voiceFileId?: string;
  /** Локальные пути к скачанным attachment-ам (фото, docs). Передаются в Claude. */
  attachmentPaths?: string[];
}

@Injectable()
export class TgRouterService {
  private readonly logger = new Logger(TgRouterService.name);

  constructor(
    private readonly pg: PgService,
    private readonly grammy: TgGrammyClient,
    private readonly configs: TgConfigService,
    private readonly agents: AgentsService,
    private readonly claudeCli: ClaudeCliService,
    @Optional() private readonly neo4j?: Neo4jService,
  ) {}

  /**
   * «Сольный» чат — тот, где писал ровно один человек. Формально это группа, но
   * фактически личный кабинет владельца: на 22.08.2026 у трёх боевых ботов из
   * четырёх ровно один участник. В таком чате бот получает полный профиль из
   * графа; как только появляется второй собеседник, приватные разделы
   * (Desires/Beliefs/Intents/Values) из промпта исчезают.
   *
   * Ограничение честное: молчаливого читателя, который ни разу не написал, эта
   * проверка не видит.
   */
  private async isSoloChat(cfg: TgBotConfigRow): Promise<boolean> {
    // tg_chat_id пуст — конфиг ещё не подключён к группе (pending) или
    // заархивирован; отвечать он не может, сюда попасть не должен. Это НЕ личка:
    // бот в приватном чате вообще не отвечает, там живут только /start, /help и
    // /balance (см. handleUpdate — в handleGroupMessage уходят только group и
    // supergroup). Страхуемся консервативно.
    if (!cfg.tg_chat_id) return false;
    const r = await this.pg.query(
      `SELECT count(DISTINCT tg_user_id) AS n
         FROM tg_bot_messages
        WHERE tg_chat_id = $1 AND role = 'user' AND tg_user_id IS NOT NULL`,
      [cfg.tg_chat_id],
    );
    return Number(r.rows[0]?.n ?? 0) <= 1;
  }

  /**
   * Память о владельце — из того же графа Neo4j, которым пользуется веб-чат.
   * Без неё бот знал только имя и переспрашивал то, что человек уже рассказывал
   * в вебке.
   */
  private async loadOwnerProfile(cfg: TgBotConfigRow): Promise<string> {
    if (!this.neo4j) return '';
    try {
      const solo = await this.isSoloChat(cfg);
      return (await this.neo4j.getProfileDescription(cfg.owner_user_id, { includePrivate: solo })).trim();
    } catch (e: any) {
      this.logger.warn(`profile for tg bot ${cfg.id} not loaded: ${e?.message}`);
      return '';
    }
  }

  /**
   * Обратная сторона: записываем разговор в тот же граф. Без этого бот не
   * учится вообще — рассказанное ему в Telegram нигде не оседает и в вебке не
   * видно. Только в сольном чате: в общей группе в профиль владельца попали бы
   * чужие слова.
   */
  async consolidateAfterReply(cfg: TgBotConfigRow, userMessage: string, assistantResponse: string): Promise<void> {
    if (!this.neo4j || !userMessage || !assistantResponse) return;
    try {
      if (!(await this.isSoloChat(cfg))) return;
      const agentId = cfg.custom_agent_id ?? cfg.preset_agent_id ?? 'tg-bot';
      await this.neo4j.consolidateFromChat(cfg.owner_user_id, String(agentId), userMessage, assistantResponse);
    } catch (e: any) {
      this.logger.warn(`neo4j consolidate for tg bot ${cfg.id} failed: ${e?.message}`);
    }
  }

  /**
   * Triggers ответа в режиме A (strict):
   * - @-mention бота
   * - reply на сообщение бота
   * - display_name конфига встречается в тексте (case-insensitive substring)
   * - команда из набора /help|balance|silent|resume
   */
  private shouldRespondStrict(
    text: string,
    botUsername: string,
    displayName: string,
    replyToFromBot: boolean,
  ): boolean {
    const lo = text.toLowerCase();
    if (!lo) return false;
    if (lo.includes(`@${botUsername.toLowerCase()}`)) return true;
    if (replyToFromBot) return true;
    if (displayName && lo.includes(displayName.toLowerCase())) return true;
    if (/^\/(help|balance|silent|resume)(\s|@|$)/.test(lo)) return true;
    return false;
  }

  /**
   * Main entry point. Возвращает true если бот должен ответить на это сообщение.
   * Mode A (strict) — детектор триггеров.
   * Mode B (always) — отвечает на каждое (rate-limit 3 сек).
   * Mode C (smart) — Phase 5 добавит Haiku-гейт. Пока fallback на strict.
   */
  async shouldRespond(
    cfg: TgBotConfigRow,
    ctx: IncomingMessageContext,
  ): Promise<boolean> {
    if (cfg.status === 'silent') return false;
    const botUsername = process.env.TG_BOT_USERNAME || 'LinkeonAgentBot';

    if (cfg.addressing_mode === 'strict') {
      return this.shouldRespondStrict(ctx.text, botUsername, cfg.display_name, !!ctx.replyToFromBot);
    }

    if (cfg.addressing_mode === 'always') {
      if (cfg.last_reply_at) {
        const elapsed = Date.now() - new Date(cfg.last_reply_at).getTime();
        if (elapsed < 3000) return false;
      }
      return true;
    }

    if (cfg.addressing_mode === 'smart') {
      if (cfg.last_reply_at) {
        const elapsed = Date.now() - new Date(cfg.last_reply_at).getTime();
        if (elapsed < 60_000) return false;
      }
      // 1. Если триггер сработал явно (как в strict) — пускаем сразу, без гейта
      if (this.shouldRespondStrict(ctx.text, botUsername, cfg.display_name, !!ctx.replyToFromBot)) {
        return true;
      }
      // 2. Иначе — гейт через Haiku
      return await this.smartGate(cfg, ctx);
    }

    return false;
  }

  /**
   * Haiku-гейт для режима smart: per-message «стоит ли вмешаться?».
   * Гейт-вызовы — БЕСПЛАТНЫЕ для пользователя (мы не плюсуем costUsd в billing
   * согласно спеку: «STT и smart-gate не списываются с владельца»).
   */
  private async smartGate(cfg: TgBotConfigRow, ctx: IncomingMessageContext): Promise<boolean> {
    let systemPrompt = '';
    try {
      const resolved = await this.resolveSystemPrompt(cfg);
      systemPrompt = resolved.systemPrompt;
    } catch {
      // no resolvable agent — gate говорит no
      return false;
    }

    const history = await this.loadHistory(cfg.id);
    const recent = history.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n');

    const gatePrompt = `Роль ассистента: ${systemPrompt.substring(0, 500)}...

Последние сообщения группы:
${recent}

Новое сообщение от ${ctx.fromTgUserName || 'user'}: "${ctx.text}"

Должен ли этот ассистент вмешаться сейчас? Ответь строго "yes" или "no" — больше ничего.`;

    try {
      const text = await this.claudeCli.text(gatePrompt, {
        model: 'claude-haiku-4-5',
        timeoutMs: 15_000,
      });
      return text.trim().toLowerCase().startsWith('yes');
    } catch (e: any) {
      this.logger.warn(`smart-gate failed, defaulting to no: ${e.message}`);
      return false;
    }
  }

  /**
   * Кто отвечает в этом чате.
   *
   * Для ЛИЧНОГО чата источник правды — preferred_agent владельца, то самое
   * поле, которое пишут веб и мини-апп. cfg.preset_agent_id в приватной
   * строке инертен: он заполнен только чтобы удовлетворить констрейнт
   * tg_bot_configs_check, и намеренно НЕ синхронизируется при переключении —
   * иначе вернулась бы двойная запись, из-за которой мини-апп и бот
   * разъезжались (см. спек 2026-08-28).
   *
   * Для группового чата всё по-прежнему: ассистент привязан к чату, потому
   * что смена одним участником сбивала бы разговор остальных.
   */
  private async resolveSystemPrompt(cfg: TgBotConfigRow): Promise<{ name: string; systemPrompt: string }> {
    if (cfg.custom_agent_id) {
      const r = await this.pg.query(
        `SELECT name, system_prompt FROM custom_agents WHERE id = $1 LIMIT 1`,
        [cfg.custom_agent_id],
      );
      if (r.rows[0]) return { name: r.rows[0].name, systemPrompt: r.rows[0].system_prompt };
    }

    if (isPrivateConfig(cfg)) {
      const prof = await this.pg.query(
        `SELECT preferred_agent FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [cfg.owner_user_id],
      );
      const preferred = prof.rows[0]?.preferred_agent;
      if (preferred) {
        const agent = await this.agents.getAgentByName(preferred);
        if (agent) return { name: agent.name, systemPrompt: agent.system_prompt };
        this.logger.warn(
          `preferred_agent "${preferred}" владельца ${cfg.owner_user_id} не найден в agents — откатываюсь на дефолтного`,
        );
      }
      const fallback = await this.agents.getAgentById(DEFAULT_AGENT_ID);
      if (fallback) return { name: fallback.name, systemPrompt: fallback.system_prompt };
    }

    if (cfg.preset_agent_id) {
      const preset = await this.agents.getAgentById(cfg.preset_agent_id);
      if (preset) return { name: preset.name, systemPrompt: preset.system_prompt };
    }
    throw new Error(`Config ${cfg.id} has no resolvable agent`);
  }

  async persistUserMessage(cfg: TgBotConfigRow, ctx: IncomingMessageContext): Promise<void> {
    await this.pg.query(
      `INSERT INTO tg_bot_messages (config_id, tg_chat_id, tg_message_id, tg_user_id, tg_user_name, role, content, content_type, tokens_charged)
       VALUES ($1, $2, $3, $4, $5, 'user', $6, $7, 0)`,
      [
        cfg.id,
        ctx.chatId,
        ctx.msgId,
        ctx.fromTgUserId,
        ctx.fromTgUserName,
        ctx.text,
        ctx.isVoice ? 'voice_transcript' : 'text',
      ],
    );
  }

  /**
   * Пометить сообщение как «ответ обязателен». Ставится там, где решение уже
   * принято — после shouldRespond()===true и в busy-skip, где юзеру обещана
   * «минутка». По этой отметке monitoring/TgHealthService ловит тихие отказы:
   * ответ не пришёл, а исключения никто не увидел (всё логируется в warn).
   *
   * Без отметки детектор пришлось бы строить на «user-строка без assistant-
   * строки», а это ложная тревога на каждом групповом чате — persistUserMessage
   * сохраняет и те сообщения, которые бот игнорирует намеренно.
   *
   * Ошибка здесь не должна ронять ответ пользователю: мониторинг вторичен по
   * отношению к работе бота, поэтому вызывающий заворачивает в try/catch.
   */
  async markAnswerExpected(chatId: number, msgId: number): Promise<void> {
    await this.pg.query(
      `UPDATE tg_bot_messages SET answer_expected_at = now()
        WHERE tg_chat_id = $1 AND tg_message_id = $2 AND role = 'user'`,
      [chatId, msgId],
    );
  }

  /**
   * Последние 20 сообщений группы. Формат для prompt: chronological строки
   * "USER [Vasya]: ..." / "ASSISTANT: ...".
   */
  private async loadHistory(configId: string): Promise<Array<{ role: 'user' | 'assistant'; content: string }>> {
    const r = await this.pg.query(
      `SELECT role, tg_user_name, content
         FROM tg_bot_messages
        WHERE config_id = $1 AND role IN ('user','assistant')
        ORDER BY created_at DESC
        LIMIT 20`,
      [configId],
    );
    const rows = r.rows.reverse();
    return rows.map((row: any) => ({
      role: row.role === 'assistant' ? 'assistant' : 'user',
      content: row.role === 'user' ? `[${row.tg_user_name || 'user'}]: ${row.content}` : row.content,
    }));
  }

  /**
   * Вызов Claude через ClaudeCliService (OAuth, без API key).
   * История склеивается в одну user-prompt; system prompt идёт отдельно.
   */
  async generateReply(
    cfg: TgBotConfigRow,
    ownerFirstName: string,
    attachmentPaths?: string[],
    onProgress?: (event: ClaudeCliProgressEvent) => void,
    sandboxDir?: string,
  ): Promise<{ text: string; costUsd: number }> {
    const { systemPrompt } = await this.resolveSystemPrompt(cfg);
    const history = await this.loadHistory(cfg.id);
    const ownerProfile = await this.loadOwnerProfile(cfg);

    // В системный промпт добавляем инструкцию про markup для отправки файлов
    // и про доступные инструменты. Если есть sandboxDir — даём Claude Bash/Write/
    // и сообщаем что любые артефакты в cwd авто-прикрепятся к ответу.
    const sandboxBlock = sandboxDir ? `
- ТЫ В BASH-ОКРУЖЕНИИ. cwd = ${sandboxDir} (изолированная пустая папка только для тебя).
- Доступные инструменты: Bash, Write, Edit, Read, Glob, Grep.
- Pre-installed: python3, pip, ffmpeg, ImageMagick, LibreOffice (для конвертации в PDF), poppler-utils, curl.
- Если нужна Python-библиотека — \`pip install --user <name>\`.
- Любой файл, который ты создашь в cwd с расширением pdf/docx/xlsx/pptx/csv/txt/md/html/json/png/jpg/mp3/mp4/zip и т.п. — авто-прикрепится к ответу как документ (до 5 файлов). Скрипты (.py/.sh) не прикрепляются — используй их как рабочий код.
- НЕ зашивай в имена файлов кириллицу/пробелы — только [a-z0-9_-]. Telegram плохо переваривает не-ASCII в filename.
- Большие задачи (PDF из нескольких страниц, диаграммы, таблицы) — пиши Python-скрипт (reportlab/openpyxl/python-pptx) и запускай через Bash.` : '';

    const ioInstructions = `
ВОЗМОЖНОСТИ:
- Ты видишь приложенные пользователем файлы (фото, PDF, txt) если они есть.
- У тебя есть интернет: WebSearch (поиск) и WebFetch (открыть страницу по URL). Если вопрос про актуальное — курсы, новости, цены, расписания, свежие релизы — проверяй в сети, а не отвечай по памяти. Обычные вопросы, где сеть не нужна, ищи не надо.${sandboxBlock}
- Медиа-маркеры для прикрепления изображений и файлов к ответу:
  • {{image: КРАТКИЙ_ПРОМПТ}} — сгенерирует и пришлёт новую картинку (Imagen 4.0 Ultra)
  • {{image_edit: source=<url> | prompt=<что изменить>}} — отредактирует существующую (Gemini Nano Banana Pro)
  • {{image_compose: sources=<url1>,<url2>[,<url3>] | prompt=<инструкция>}} — склеит 2-3 картинки в одну
  • {{upscale: source=<url>}} — улучшит качество до 4K
  • {{video: prompt=<описание> | mode=text2video|image2video | source=<url>? | duration=5|10}} — сгенерирует видео (Kling, 1-3 минуты). Юзер получит сообщение "видео в очереди" сразу, а сам ролик придёт автоматически когда готов. Для image2video передавай source=<url> картинки.
  • {{file: url=<https://...> | caption=<подпись> | name=<имя>}} — приложит файл по https-URL
- Маркеры пиши на отдельной строке. Не больше 3 за ответ. source/sources — это URL картинок из предыдущих сообщений в чате.
- Сам по себе текст до/после маркера тоже отправится — пиши коротко.`;

    // Профиль владельца из графа — та же память, которой пользуется веб-чат.
    // Без неё бот знал только имя и переспрашивал уже рассказанное.
    const profileBlock = ownerProfile ? `

ЧТО ТЫ УЖЕ ЗНАЕШЬ О ВЛАДЕЛЬЦЕ (накоплено из его разговоров в Linkeon):
${ownerProfile}
Пользуйся этим молча: не переспрашивай то, что здесь есть, и не зачитывай этот список вслух.` : '';

    const systemWithCtx = `Ты в Telegram-группе. Владелец бота, который платит за твою работу: ${ownerFirstName}. Текущая дата/время: ${new Date().toISOString()}.
${ioInstructions}${profileBlock}

${systemPrompt}`;

    const userPrompt = history.length > 0
      ? history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
      : '(пустая переписка — поздоровайся первым)';

    // timeoutMs: 0 — без таймаута. Юзер видит реальный прогресс через onProgress
    // (status-сообщение в чате), так что молчания в TG больше нет, и обрывать
    // Claude по часам не нужно.
    // В sandbox-режиме разрешаем агентные tools — Claude может сам писать скрипты,
    // запускать их и читать результаты. В песочнице — только в её cwd.
    //
    // Веб — во всех режимах. allowedTools=undefined в claude-cli.service значит
    // «built-in тулы выключены полностью» (или только Read при вложениях), из-за
    // чего бот отвечал по обучающим данным и выдавал устаревшее за актуальное,
    // молча и без ошибок в логе. Передавая список явно, мы отключаем тот дефолт,
    // поэтому Read при вложениях приходится дописывать руками.
    //
    // Цена: поиск заметно дороже обычного хода (замер 22.08.2026 — $0.24 и 48 с
    // на один вопрос с 5 поисковыми запросами). Отдельного учёта не нужно —
    // costUsd из textWithCost уже уходит в биллинг, но на счёт владельца бота
    // такие ходы ложатся ощутимее.
    const WEB_TOOLS = 'WebSearch,WebFetch';
    const allowedTools = sandboxDir
      ? `Bash,Write,Edit,Read,Glob,Grep,${WEB_TOOLS}`
      : attachmentPaths?.length
        ? `Read,${WEB_TOOLS}`
        : WEB_TOOLS;

    // Та же модель, что и в вебе. Веб уводит всех ассистентов кроме Маши на
    // relay r.linkeon.io, где claude крутится на рекомендованной моделью CLI
    // (сейчас Opus 5). Здесь путь локальный, и Sonnet стоял просто потому, что
    // TG-ветку с Phase 4 строили на своём CLI-вызове — из-за этого один и тот
    // же ассистент в телеге отвечал заметно слабее, чем в вебе.
    //
    // 'default', а не 'claude-opus-5': default сам даунгрейдится при исчерпании
    // лимита подписки, хардкод — падает, и бот молча замолкает.
    //
    // Цена: тяжёлые агентные ходы (сгенерировать договор, собрать финмодель)
    // стоили 30-65k токенов владельца ещё на Sonnet. Опус их умножает, поэтому
    // в tg-bot.service рядом со списанием стоит алерт на дорогой ход.
    const { text, costUsd } = await this.claudeCli.textWithCost(userPrompt, {
      system: systemWithCtx,
      model: 'default',
      timeoutMs: 0,
      attachments: attachmentPaths?.length ? attachmentPaths : undefined,
      onProgress,
      cwd: sandboxDir,
      allowedTools,
    });

    return { text: text.trim() || '...', costUsd };
  }

  async persistAssistantReply(cfg: TgBotConfigRow, content: string, contentType: 'text' | 'voice_reply', tokensCharged: number): Promise<void> {
    await this.pg.query(
      `INSERT INTO tg_bot_messages (config_id, tg_chat_id, role, content, content_type, tokens_charged)
       VALUES ($1, $2, 'assistant', $3, $4, $5)`,
      [cfg.id, Number(cfg.tg_chat_id), content, contentType, tokensCharged],
    );
    await this.pg.query(
      `UPDATE tg_bot_configs SET last_reply_at = now() WHERE id = $1`,
      [cfg.id],
    );
  }
}
