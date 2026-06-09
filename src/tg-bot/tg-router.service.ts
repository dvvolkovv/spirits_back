import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import { AgentsService } from '../agents/agents.service';
import { TgGrammyClient } from './tg-grammy.client';
import { TgConfigService, TgBotConfigRow } from './tg-config.service';

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
  ) {}

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
   * Resolve system prompt: либо custom_agent (по custom_agent_id), либо preset из agents table.
   */
  private async resolveSystemPrompt(cfg: TgBotConfigRow): Promise<{ name: string; systemPrompt: string }> {
    if (cfg.custom_agent_id) {
      const r = await this.pg.query(
        `SELECT name, system_prompt FROM custom_agents WHERE id = $1 LIMIT 1`,
        [cfg.custom_agent_id],
      );
      if (r.rows[0]) return { name: r.rows[0].name, systemPrompt: r.rows[0].system_prompt };
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
  async generateReply(cfg: TgBotConfigRow, ownerFirstName: string): Promise<{ text: string; costUsd: number }> {
    const { systemPrompt } = await this.resolveSystemPrompt(cfg);
    const history = await this.loadHistory(cfg.id);

    const systemWithCtx = `Ты в Telegram-группе. Владелец бота, который платит за твою работу: ${ownerFirstName}. Текущая дата/время: ${new Date().toISOString()}.

${systemPrompt}`;

    const userPrompt = history.length > 0
      ? history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n')
      : '(пустая переписка — поздоровайся первым)';

    const { text, costUsd } = await this.claudeCli.textWithCost(userPrompt, {
      system: systemWithCtx,
      model: 'claude-sonnet-4-6',
      timeoutMs: 90_000,
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
