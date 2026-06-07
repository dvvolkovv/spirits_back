import {
  Injectable, Logger, BadRequestException, NotFoundException, OnModuleInit, Optional,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { PgService } from '../common/services/pg.service';
import {
  SupportTicketRow, SupportMessageRow, PostUserMessageDto, LIMITS, SenderType,
} from './support.dto';
import { TelegramNotifierService } from './telegram-notifier.service';
import { VideoService } from '../video/video.service';
import { CreateVideoJobDto } from '../video/video.dto';

@Injectable()
export class SupportService implements OnModuleInit {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly telegram?: TelegramNotifierService,
    @Optional() private readonly video?: VideoService,
  ) {}

  async onModuleInit() {
    const candidates = [
      path.join(__dirname, 'migrations', '001_support.sql'),
      path.join(__dirname, '..', '..', 'src', 'support', 'migrations', '001_support.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`support migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`support migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('support migration sql not found, skipping');
  }

  // -------------------- Ticket lifecycle --------------------

  async getOrCreateActiveTicket(userId: string): Promise<SupportTicketRow> {
    const existing = await this.pg.query(
      `SELECT * FROM support_tickets
       WHERE user_id = $1 AND status IN ('ai_handling','escalated','owner_handling')
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (existing.rows[0]) return existing.rows[0] as SupportTicketRow;

    const ins = await this.pg.query(
      `INSERT INTO support_tickets (user_id, status) VALUES ($1, 'ai_handling') RETURNING *`,
      [userId],
    );
    return ins.rows[0] as SupportTicketRow;
  }

  /**
   * Returns the most recent ticket of the user (any status), or creates a fresh one if none exist.
   * Use this for displaying support chat — keeps closed tickets visible until user sends a new message.
   *
   * Prefers tickets that have at least one user-visible message — empty active tickets (created
   * speculatively by old code) shouldn't hide a previously-resolved ticket with real conversation.
   */
  async getLatestOrCreateTicket(userId: string): Promise<SupportTicketRow> {
    const withMessages = await this.pg.query(
      `SELECT t.* FROM support_tickets t
       WHERE t.user_id = $1
         AND EXISTS (
           SELECT 1 FROM support_messages m
           WHERE m.ticket_id = t.id AND m.visible_to_user = true
         )
       ORDER BY t.created_at DESC
       LIMIT 1`,
      [userId],
    );
    if (withMessages.rows[0]) return withMessages.rows[0] as SupportTicketRow;

    const latest = await this.pg.query(
      `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    if (latest.rows[0]) return latest.rows[0] as SupportTicketRow;

    const ins = await this.pg.query(
      `INSERT INTO support_tickets (user_id, status) VALUES ($1, 'ai_handling') RETURNING *`,
      [userId],
    );
    return ins.rows[0] as SupportTicketRow;
  }

  /**
   * Returns user's last `limit` tickets (any status) in chronological order (oldest → newest),
   * each with its visible-to-user messages embedded. Used for rendering full support history.
   */
  async listUserTicketsWithMessages(userId: string, limit = 10): Promise<any[]> {
    const t = await this.pg.query(
      `SELECT * FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [userId, Math.min(Math.max(limit, 1), 20)],
    );
    if (t.rows.length === 0) return [];

    const ids = t.rows.map((r: any) => r.id);
    const m = await this.pg.query(
      `SELECT * FROM support_messages
       WHERE ticket_id = ANY($1::uuid[]) AND visible_to_user = true
       ORDER BY created_at ASC`,
      [ids],
    );
    const byTicket = new Map<string, any[]>();
    for (const row of m.rows) {
      if (!byTicket.has(row.ticket_id)) byTicket.set(row.ticket_id, []);
      byTicket.get(row.ticket_id)!.push({
        id: row.id,
        senderType: row.sender_type,
        content: row.content,
        createdAt: row.created_at,
      });
    }

    const out = t.rows.map((row: any) => ({
      id: row.id,
      status: row.status,
      urgency: row.urgency,
      topic: row.topic,
      createdAt: row.created_at,
      lastMessageAt: row.last_message_at,
      messages: byTicket.get(row.id) || [],
    })).filter((tk: any) => tk.messages.length > 0); // hide empty placeholder tickets
    out.reverse();
    return out;
  }

  async listMessages(
    userId: string, ticketId: string, includeInternal = false,
  ): Promise<SupportMessageRow[]> {
    const t = await this.pg.query(`SELECT user_id FROM support_tickets WHERE id = $1`, [ticketId]);
    if (!t.rows[0]) throw new NotFoundException('ticket not found');
    if (!includeInternal && t.rows[0].user_id !== userId) {
      throw new BadRequestException('not your ticket');
    }
    const visClause = includeInternal ? '' : 'AND visible_to_user = true';
    const res = await this.pg.query(
      `SELECT * FROM support_messages
       WHERE ticket_id = $1 ${visClause}
       ORDER BY created_at ASC LIMIT 500`,
      [ticketId],
    );
    return res.rows as SupportMessageRow[];
  }

  // -------------------- User → AI flow --------------------

  async postUserMessage(userId: string, dto: PostUserMessageDto): Promise<{ ticketId: string }> {
    const content = (dto.content || '').trim();
    if (!content) throw new BadRequestException('content required');
    if (content.length > LIMITS.MESSAGE_MAX) {
      throw new BadRequestException(`message too long (max ${LIMITS.MESSAGE_MAX})`);
    }

    // Rate limit
    const rate = await this.pg.query(
      `SELECT count(*)::int AS n FROM support_messages m
       JOIN support_tickets t ON t.id = m.ticket_id
       WHERE t.user_id = $1 AND m.sender_type = 'user'
         AND m.created_at > now() - interval '10 minutes'`,
      [userId],
    );
    if ((rate.rows[0]?.n ?? 0) >= LIMITS.RATE_MESSAGES_PER_10MIN) {
      throw new BadRequestException('too many messages, try again in a few minutes');
    }

    const ticket = await this.getOrCreateActiveTicket(userId);

    await this.pg.query(
      `INSERT INTO support_messages (ticket_id, sender_type, sender_id, content)
       VALUES ($1, 'user', $2, $3)`,
      [ticket.id, userId, content],
    );
    await this.pg.query(
      `UPDATE support_tickets SET last_message_at = now(), updated_at = now() WHERE id = $1`,
      [ticket.id],
    );

    // Generate AI response only if ticket is still AI-handled.
    if (ticket.status === 'ai_handling') {
      this.generateAiResponse(ticket.id, userId).catch((e) =>
        this.logger.error(`AI response failed for ticket ${ticket.id}: ${e.message}`),
      );
    }

    // Notify owner if the ticket is already human-handled so the message doesn't sit unseen.
    if (ticket.status === 'escalated' || ticket.status === 'owner_handling') {
      this.notifyOwnerOfUserReply(ticket.id, userId, content, ticket.status).catch(() => {});
    }

    return { ticketId: ticket.id };
  }

  private async notifyOwnerOfUserReply(
    ticketId: string, userId: string, text: string, status: string,
  ): Promise<void> {
    if (!this.telegram) return;
    // Debounce: if we've already pushed a user-reply ping in the last 30s for this ticket, skip.
    const recent = await this.pg.query(
      `SELECT 1 FROM support_events
       WHERE ticket_id = $1 AND action = 'user_reply_ping'
         AND created_at > now() - interval '30 seconds'
       LIMIT 1`,
      [ticketId],
    );
    if (recent.rows.length > 0) return;

    const p = await this.pg.query(
      `SELECT profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const name = p.rows[0]?.name || this.maskPhone(userId);
    await this.telegram.notifyUserReply({ ticketId, userName: name, userText: text, ticketStatus: status });
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'system', NULL, 'user_reply_ping', $2::jsonb)`,
      [ticketId, JSON.stringify({ preview: text.slice(0, 200) })],
    );
  }

  private maskPhone(userId: string): string {
    const d = String(userId).replace(/\D/g, '');
    if (d.length < 6) return 'Пользователь';
    return `+${d.slice(0, 1)} *** *** ${d.slice(-2)}`;
  }

  // -------------------- AI response (tool-loop) --------------------

  private async generateAiResponse(ticketId: string, userId: string): Promise<void> {
    const history = await this.listMessages(userId, ticketId, true);
    const profile = await this.getUserContextData(userId);
    const health = await this.getServiceHealth();

    const systemPrompt = this.buildSystemPrompt(profile, health);
    const conversation = history
      .filter((m) => m.sender_type === 'user' || m.sender_type === 'ai' || m.sender_type === 'owner')
      .map((m) => ({
        role: m.sender_type === 'user' ? 'user' : 'assistant',
        content: m.content,
      }));

    if (conversation.length === 0 || conversation[conversation.length - 1].role !== 'user') {
      // nothing to respond to
      return;
    }

    // Свернём conversation в plain-text prompt: Agent SDK не принимает messages-array
    // напрямую. История prior turns + последняя реплика пользователя.
    const lastUser = conversation[conversation.length - 1].content;
    const priorTurns = conversation.slice(0, -1)
      .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
      .join('\n\n');
    const prompt = priorTurns ? `${priorTurns}\n\nUSER: ${lastUser}` : `USER: ${lastUser}`;

    const mcp = this.buildSupportMcp(ticketId, userId);
    let finalText = '';
    let escalated = false;
    const toolInvocations: any[] = [];

    try {
      for await (const event of query({
        prompt,
        options: {
          model: 'claude-haiku-4-5',
          systemPrompt,
          mcpServers: { 'support-tools': mcp },
          permissionMode: 'bypassPermissions',
          settingSources: [],
          maxTurns: LIMITS.AI_MAX_TURNS,
        } as any,
      })) {
        if (event.type === 'assistant') {
          for (const block of ((event as any).message?.content || []) as any[]) {
            if (block.type === 'text' && typeof block.text === 'string') {
              finalText += block.text;
            }
            if (block.type === 'tool_use') {
              // Сохраняем имя без mcp__ префикса для удобства чтения в БД.
              const name = String(block.name || '').replace(/^mcp__[^_]+__/, '');
              toolInvocations.push({ name, input: block.input });
              if (name === 'escalate_to_owner') escalated = true;
            }
          }
        }
      }
    } catch (e: any) {
      this.logger.error(`support OAuth error: ${e.message}`);
      await this.insertMessage(ticketId, 'ai', null,
        'Извините, у меня сейчас временные проблемы со связью. Попробуйте переформулировать или напишите ещё раз через минуту — если не получится, я передам команде.',
        { error: e.message });
      return;
    }

    finalText = finalText.trim();
    if (!finalText) {
      finalText = escalated
        ? 'Передал вопрос команде. С вами свяжутся отсюда в этом же чате, как только разберутся.'
        : 'Извините, мне нужно больше информации, чтобы помочь. Опишите подробнее, пожалуйста.';
    }

    await this.insertMessage(ticketId, 'ai', null, finalText, { tools: toolInvocations });
  }

  // MCP-сервер для tool-loop: 1:1 порт SUPPORT_TOOLS на zod-схемы Agent SDK.
  // Handlers закрывают замыкания на ticketId/userId, дальше делегируют в
  // существующий executeTool — тот ничего не знает про MCP, остаётся как был.
  private buildSupportMcp(ticketId: string, userId: string): any {
    const dispatch = async (name: string, args: any) => {
      const result = await this.executeTool(ticketId, userId, name, args || {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    };
    return createSdkMcpServer({
      name: 'support-tools',
      tools: [
        tool(
          'get_user_context',
          'Fetch current user context: token balance, isAdmin flag, email, preferred agent, profile name, account age.',
          {},
          async (a: any) => dispatch('get_user_context', a),
        ),
        tool(
          'get_recent_jobs',
          "List the user's most recent image/video generation jobs (last 10). Useful if they complain about a generation that failed, was slow, or returned wrong result.",
          { kind: z.enum(['video', 'image', 'all']).optional() },
          async (a: any) => dispatch('get_recent_jobs', a),
        ),
        tool(
          'check_service_health',
          'Return current status of platform services (backend, database, LLM, Kling, payments). Call this when the user reports something is broken or you need to verify availability before answering.',
          {},
          async (a: any) => dispatch('check_service_health', a),
        ),
        tool(
          'refund_tokens',
          'Credit tokens back to the user when there is a clear, verifiable reason (failed job tied to upstream issue, confirmed double-charge, service was down at charge time). DO NOT use just because user wants more tokens or is unhappy with quality. Hard limits: ≤10k per call, ≤20k per ticket, ≤30k per user/day — exceeding fails the call, then escalate.',
          {
            amount: z.number().int(),
            reason: z.string(),
            reference: z.string().optional(),
          },
          async (a: any) => dispatch('refund_tokens', a),
        ),
        tool(
          'rerun_failed_job',
          'Re-queue a failed video-generation job: refunds tokens + queues identical new job. Verify failure tied to upstream issue first. Supported modes: text2video, image2video. Not yet supported: extend, lipsync — refund and tell user to re-submit manually.',
          { job_id: z.string() },
          async (a: any) => dispatch('rerun_failed_job', a),
        ),
        tool(
          'escalate_to_owner',
          'Flag the ticket for a human owner to pick up. Use when: user explicitly asks for a human, you cannot solve the issue with available tools, you detect a payment/refund dispute, refund_tokens failed due to limits, or you have asked clarifying questions 3+ times without progress.',
          {
            reason: z.string(),
            urgency: z.enum(['low', 'normal', 'high', 'critical']).optional(),
            summary: z.string(),
          },
          async (a: any) => dispatch('escalate_to_owner', a),
        ),
      ],
    });
  }

  private buildSystemPrompt(profile: any, health?: { services: any[] }): string {
    const healthSummary = (() => {
      if (!health?.services?.length) return 'нет данных (мониторинг не запускался)';
      return health.services
        .map((s) => {
          const badge = s.status === 'healthy' ? '✓' : s.status === 'degraded' ? '⚠' : s.status === 'down' ? '✗' : '?';
          const lat = s.latency_ms != null ? ` ${s.latency_ms}мс` : '';
          const err = s.last_error ? ` — ${String(s.last_error).slice(0, 80)}` : '';
          return `${badge} ${s.service}: ${s.status}${lat}${err}`;
        })
        .join('\n');
    })();

    return `Ты — ИИ-поддержка платформы LINKEON.IO. Отвечай кратко, по делу, по-русски.

ПЛАТФОРМА. LINKEON.IO — AI-ассистенты для бизнеса и личного роста, нетворкинг (поиск людей + совместимость + запросы на общение + чаты между пользователями), генерация изображений и видео (Kling), реферальная программа.

ТВОЯ РОЛЬ.
- Помогай юзеру решать вопросы по использованию платформы.
- Если что-то технически сломано — сначала вызови check_service_health, потом сообщи честно.
- Если речь о конкретной генерации — вызови get_recent_jobs, чтобы увидеть статус.
- Если юзер хочет рефанд, уточнения по оплате, баги которые ты не можешь исправить или явно просит человека — вызови escalate_to_owner.
- Не обещай возврат денег/токенов без эскалации — у тебя пока нет такого тула.
- Не выдумывай фичи, которых нет. Не раскрывай внутренние ID или email других пользователей.

КОНТЕКСТ ЮЗЕРА.
Баланс: ${profile?.tokens ?? '?'} токенов.
Email: ${profile?.email ?? 'не указан'}.
Имя: ${profile?.name ?? 'не указано'}.
Создан: ${profile?.created_at ?? '?'}.

СТАТУС СЕРВИСОВ (актуальный снимок, обновляется каждую минуту):
${healthSummary}

Если пользователь жалуется на конкретный сервис — ссылайся на статус выше. Не вызывай повторно check_service_health, если ответ уже виден. Если сервис degraded/down и жалоба совпадает — извинись, подтверди факт сбоя и предложи подождать или повторить позже (если это решит проблему); в остальных случаях эскалируй команде.

Отвечай только текстом в финальном турне. Никогда не ставь tool-use и финальный ответ одновременно — сначала вызови нужные тулы, потом дай финальный ответ.`;
  }

  private async executeTool(
    ticketId: string, userId: string, name: string, input: any,
  ): Promise<any> {
    try {
      if (name === 'get_user_context') {
        return await this.getUserContextData(userId);
      }
      if (name === 'get_recent_jobs') {
        return await this.getRecentJobs(userId, input?.kind || 'all');
      }
      if (name === 'check_service_health') {
        return await this.getServiceHealth();
      }
      if (name === 'refund_tokens') {
        return await this.performRefund(ticketId, userId, input);
      }
      if (name === 'rerun_failed_job') {
        return await this.performRerun(ticketId, userId, input);
      }
      if (name === 'escalate_to_owner') {
        const reason = String(input?.reason || '').slice(0, 500);
        const urgency = ['low', 'normal', 'high', 'critical'].includes(input?.urgency)
          ? input.urgency
          : 'normal';
        const summary = String(input?.summary || '').slice(0, 2000);
        await this.escalate(ticketId, userId, reason, urgency as any, summary);
        return { ok: true, escalated: true };
      }
      return { ok: false, error: `unknown tool ${name}` };
    } catch (e: any) {
      this.logger.error(`tool ${name} failed: ${e.message}`);
      return { ok: false, error: e.message };
    }
  }

  private async getUserContextData(userId: string) {
    const res = await this.pg.query(
      `SELECT user_id, tokens, email, preferred_agent, profile_data, created_at, updated_at, isadmin
       FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const row = res.rows[0];
    if (!row) return { error: 'user not found' };
    return {
      user_id: row.user_id,
      tokens: Number(row.tokens || 0),
      email: row.email,
      is_admin: row.isadmin === true || row.isadmin === 'true',
      preferred_agent: row.preferred_agent,
      name: row.profile_data?.name || null,
      family_name: row.profile_data?.family_name || null,
      created_at: row.created_at,
    };
  }

  private async getRecentJobs(userId: string, kind: string) {
    const result: any = {};
    if (kind === 'all' || kind === 'video') {
      const r = await this.pg.query(
        `SELECT id, mode, model, quality, status, error_message, tokens_spent, created_at
         FROM video_jobs WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
        [userId],
      );
      result.video_jobs = r.rows;
    }
    if (kind === 'all' || kind === 'image') {
      try {
        const r = await this.pg.query(
          `SELECT id, prompt, tokens_spent, created_at
           FROM generated_images WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10`,
          [userId],
        );
        result.image_jobs = r.rows;
      } catch {
        // table may not exist in older envs
        result.image_jobs = [];
      }
    }
    return result;
  }

  async getServiceHealth() {
    const r = await this.pg.query(
      `SELECT service, status, latency_ms, last_check_at, last_error FROM service_health ORDER BY service`,
    );
    return { services: r.rows, checked_at: new Date().toISOString() };
  }

  private async performRefund(
    ticketId: string, userId: string, input: any,
  ): Promise<{ ok: boolean; [k: string]: any }> {
    const amount = Math.floor(Number(input?.amount || 0));
    const reason = String(input?.reason || '').slice(0, 500);
    const reference = input?.reference ? String(input.reference).slice(0, 200) : null;

    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, error: 'invalid_amount' };
    }
    if (!reason) {
      return { ok: false, error: 'reason_required' };
    }
    if (amount > LIMITS.REFUND_MAX_PER_CALL) {
      return { ok: false, error: 'per_call_limit_exceeded', limit: LIMITS.REFUND_MAX_PER_CALL };
    }

    // Per-ticket cumulative limit.
    const ticketSum = await this.pg.query(
      `SELECT COALESCE(SUM((payload->>'amount')::bigint), 0)::bigint AS total
       FROM support_events
       WHERE ticket_id = $1 AND action = 'refund'`,
      [ticketId],
    );
    const ticketSoFar = Number(ticketSum.rows[0]?.total || 0);
    if (ticketSoFar + amount > LIMITS.REFUND_MAX_PER_TICKET) {
      return {
        ok: false, error: 'per_ticket_limit_exceeded',
        already: ticketSoFar, attempted: amount, limit: LIMITS.REFUND_MAX_PER_TICKET,
      };
    }

    // Per-user daily limit (last 24h across all tickets).
    const daySum = await this.pg.query(
      `SELECT COALESCE(SUM((e.payload->>'amount')::bigint), 0)::bigint AS total
       FROM support_events e
       JOIN support_tickets t ON t.id = e.ticket_id
       WHERE t.user_id = $1 AND e.action = 'refund'
         AND e.created_at > now() - interval '24 hours'`,
      [userId],
    );
    const daySoFar = Number(daySum.rows[0]?.total || 0);
    if (daySoFar + amount > LIMITS.REFUND_MAX_DAILY_PER_USER) {
      return {
        ok: false, error: 'daily_limit_exceeded',
        already: daySoFar, attempted: amount, limit: LIMITS.REFUND_MAX_DAILY_PER_USER,
      };
    }

    // Apply credit atomically.
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE ai_profiles_consolidated
         SET tokens = tokens + $1, updated_at = now()
         WHERE user_id = $2
         RETURNING tokens`,
        [amount, userId],
      );
      if (upd.rowCount === 0) {
        await client.query('ROLLBACK');
        return { ok: false, error: 'user_not_found' };
      }
      await client.query(
        `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
         VALUES ($1, 'ai', NULL, 'refund', $2::jsonb)`,
        [ticketId, JSON.stringify({ amount, reason, reference })],
      );
      await client.query('COMMIT');
      const newBalance = Number(upd.rows[0].tokens);
      this.logger.log(`refund ${amount} to ${userId} (ticket ${ticketId}): ${reason}`);

      // Post a system message visible to user so they see the confirmation in-chat.
      await this.insertMessage(
        ticketId, 'system', null,
        `💳 Начислено ${amount.toLocaleString('ru-RU')} токенов. Новый баланс: ${newBalance.toLocaleString('ru-RU')}.`,
        { refund: true, amount, reference }, true,
      );
      return { ok: true, amount, new_balance: newBalance, ticket_total: ticketSoFar + amount, day_total: daySoFar + amount };
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger.error(`refund failed: ${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      client.release();
    }
  }

  private async performRerun(
    ticketId: string, userId: string, input: any,
  ): Promise<{ ok: boolean; [k: string]: any }> {
    if (!this.video) return { ok: false, error: 'video_service_unavailable' };
    const jobId = String(input?.job_id || '').trim();
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) return { ok: false, error: 'invalid_job_id' };

    const r = await this.pg.query(
      `SELECT * FROM video_jobs WHERE id = $1 AND user_id = $2`,
      [jobId, userId],
    );
    const job = r.rows[0];
    if (!job) return { ok: false, error: 'job_not_found' };
    if (job.status !== 'failed') return { ok: false, error: 'job_not_failed', status: job.status };
    if (job.mode === 'extend' || job.mode === 'lipsync') {
      return { ok: false, error: 'mode_not_supported', mode: job.mode };
    }

    // Guard against double-rerun.
    const prior = await this.pg.query(
      `SELECT 1 FROM support_events
       WHERE action = 'rerun_job' AND payload->>'original_job_id' = $1 LIMIT 1`,
      [jobId],
    );
    if (prior.rows.length > 0) return { ok: false, error: 'already_rerun' };

    // Step 1: createJob — it validates params, charges current price, dispatches to Kling.
    const dto: CreateVideoJobDto = {
      mode: job.mode,
      model: job.model,
      quality: job.quality,
      duration: job.duration_sec as 5 | 10,
      prompt: job.prompt || undefined,
      negativePrompt: job.negative_prompt || undefined,
      cfgScale: job.cfg_scale ? Number(job.cfg_scale) : undefined,
      sourceImageUrl: job.source_image_url || undefined,
      sourceVideoId: job.source_video_id || undefined,
      cameraType: job.camera_type || undefined,
      cameraConfig: job.camera_config || undefined,
      audioUrl: job.audio_url || undefined,
    };

    let created: { jobId: string; status: string; tokensSpent: number };
    try {
      created = await this.video.createJob(userId, dto);
    } catch (e: any) {
      this.logger.error(`rerun createJob failed: ${e.message}`);
      return { ok: false, error: 'create_failed', details: e.message };
    }

    // Step 2: in one transaction, credit back exactly what createJob charged AND the original
    // failed job's cost (user gets a free retry — the original charge stays covered by the
    // refund, new charge is zeroed out). Bypasses refund_tokens safe-limits by design: this is
    // a verified upstream-failure workflow, idempotent per job.
    const totalCredit = Number(created.tokensSpent) + Number(job.tokens_spent);
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const upd = await client.query(
        `UPDATE ai_profiles_consolidated
         SET tokens = tokens + $1, updated_at = now()
         WHERE user_id = $2 RETURNING tokens`,
        [totalCredit, userId],
      );
      await client.query(
        `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
         VALUES ($1, 'ai', NULL, 'rerun_job', $2::jsonb)`,
        [ticketId, JSON.stringify({
          original_job_id: jobId, original_cost: Number(job.tokens_spent),
          new_job_id: created.jobId, new_cost: Number(created.tokensSpent),
          total_credited: totalCredit,
        })],
      );
      await client.query('COMMIT');
      const newBalance = Number(upd.rows[0]?.tokens || 0);

      await this.insertMessage(
        ticketId, 'system', null,
        `🔁 Видео перезапущено. Новый job id: ${created.jobId.slice(0, 8)}. Следите за статусом в разделе «Видео». Токены не списаны (возврат ${totalCredit.toLocaleString('ru-RU')}).`,
        { rerun: true, originalJobId: jobId, newJobId: created.jobId, credited: totalCredit }, true,
      );
      return { ok: true, new_job_id: created.jobId, status: created.status, credited: totalCredit, new_balance: newBalance };
    } catch (e: any) {
      try { await client.query('ROLLBACK'); } catch {}
      this.logger.error(`rerun credit failed: ${e.message}`);
      return { ok: false, error: 'credit_failed', details: e.message };
    } finally {
      client.release();
    }
  }

  private async escalate(
    ticketId: string, userId: string, reason: string, urgency: 'low' | 'normal' | 'high' | 'critical', summary: string,
  ) {
    await this.pg.query(
      `UPDATE support_tickets SET status = 'escalated', urgency = $1, escalation_reason = $2, notes = $3, updated_at = now() WHERE id = $4`,
      [urgency, reason, summary, ticketId],
    );
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'ai', NULL, 'escalate', $2)`,
      [ticketId, JSON.stringify({ reason, urgency, summary })],
    );
    // Internal system message visible only to owner
    await this.insertMessage(ticketId, 'system', null,
      `🚨 Escalated to owner: ${reason}\n${summary}`,
      { urgency }, false);
    this.logger.warn(`ticket ${ticketId} escalated (${urgency}): ${reason}`);

    // Telegram push to owner with context
    if (this.telegram) {
      try {
        const u = await this.pg.query(
          `SELECT tokens, email, profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id = $1`,
          [userId],
        );
        const lastUser = await this.pg.query(
          `SELECT content FROM support_messages
           WHERE ticket_id = $1 AND sender_type = 'user'
           ORDER BY created_at DESC LIMIT 1`,
          [ticketId],
        );
        await this.telegram.notifyEscalation({
          ticketId,
          userId,
          userName: u.rows[0]?.name || null,
          userEmail: u.rows[0]?.email || null,
          userTokens: Number(u.rows[0]?.tokens || 0),
          urgency,
          reason,
          summary,
          lastUserMessage: lastUser.rows[0]?.content || null,
        });
      } catch (e: any) {
        this.logger.error(`telegram notify failed: ${e.message}`);
      }
    }
  }

  // -------------------- Admin (owner) operations --------------------

  async adminListTickets(opts: { status?: string; limit?: number } = {}) {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
    const params: any[] = [];
    let whereStatus = '';
    if (opts.status && opts.status !== 'all') {
      params.push(opts.status);
      whereStatus = `WHERE t.status = $1`;
    }
    const rows = await this.pg.query(
      `SELECT t.*,
              p.profile_data->>'name' AS user_name,
              p.tokens AS user_tokens,
              (SELECT content FROM support_messages m
                WHERE m.ticket_id = t.id AND m.visible_to_user = true
                ORDER BY m.created_at DESC LIMIT 1) AS last_visible_msg,
              (SELECT count(*)::int FROM support_messages m WHERE m.ticket_id = t.id) AS msg_count
         FROM support_tickets t
         LEFT JOIN ai_profiles_consolidated p ON p.user_id = t.user_id
         ${whereStatus}
         ORDER BY
           CASE t.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
           t.updated_at DESC
         LIMIT ${limit}`,
      params,
    );
    return rows.rows.map((r: any) => ({
      id: r.id,
      userId: r.user_id,
      userName: r.user_name,
      userTokens: Number(r.user_tokens || 0),
      status: r.status,
      urgency: r.urgency,
      topic: r.topic,
      escalationReason: r.escalation_reason,
      notes: r.notes,
      lastMessage: r.last_visible_msg,
      messageCount: r.msg_count,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastMessageAt: r.last_message_at,
    }));
  }

  async adminGetTicket(ticketId: string) {
    const t = await this.pg.query(`SELECT * FROM support_tickets WHERE id = $1`, [ticketId]);
    const row = t.rows[0];
    if (!row) throw new NotFoundException('ticket not found');
    const messages = await this.pg.query(
      `SELECT * FROM support_messages WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 500`,
      [ticketId],
    );
    const events = await this.pg.query(
      `SELECT * FROM support_events WHERE ticket_id = $1 ORDER BY created_at ASC LIMIT 200`,
      [ticketId],
    );
    const profile = await this.pg.query(
      `SELECT profile_data, tokens, email, isadmin, created_at FROM ai_profiles_consolidated WHERE user_id = $1`,
      [row.user_id],
    );
    return {
      ticket: row,
      messages: messages.rows,
      events: events.rows,
      user: profile.rows[0] || null,
    };
  }

  async adminReply(ticketId: string, ownerId: string, content: string, visibleToUser = true) {
    const trimmed = (content || '').trim();
    if (!trimmed) throw new BadRequestException('content required');
    if (trimmed.length > LIMITS.MESSAGE_MAX) {
      throw new BadRequestException(`message too long (max ${LIMITS.MESSAGE_MAX})`);
    }
    const t = await this.pg.query(`SELECT status FROM support_tickets WHERE id = $1`, [ticketId]);
    if (!t.rows[0]) throw new NotFoundException('ticket not found');
    await this.insertMessage(ticketId, 'owner', ownerId, trimmed, null, visibleToUser);
    // Any visible owner reply implies human is handling it.
    if (visibleToUser) {
      await this.pg.query(
        `UPDATE support_tickets SET status = 'owner_handling', updated_at = now() WHERE id = $1 AND status IN ('escalated','ai_handling')`,
        [ticketId],
      );
    }
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'owner', $2, 'reply', $3)`,
      [ticketId, ownerId, JSON.stringify({ visibleToUser, length: trimmed.length })],
    );
  }

  async adminSetStatus(ticketId: string, ownerId: string, status: string, note?: string) {
    const allowed = ['ai_handling', 'escalated', 'owner_handling', 'resolved', 'closed'];
    if (!allowed.includes(status)) throw new BadRequestException('invalid status');
    const resolvedAt = (status === 'resolved' || status === 'closed') ? 'now()' : 'NULL';
    await this.pg.query(
      `UPDATE support_tickets
         SET status = $1,
             resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $2`,
      [status, ticketId],
    );
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'owner', $2, 'status_change', $3)`,
      [ticketId, ownerId, JSON.stringify({ status, note })],
    );
    if (note) {
      await this.insertMessage(ticketId, 'system', ownerId, note, { from: 'owner', status }, false);
    }
  }

  // -------------------- Internal helpers --------------------

  // -------------------- Telegram webhook path --------------------

  /**
   * Find an active ticket by its short id prefix (first 8 hex chars of the uuid).
   * Used when owner replies in Telegram — only the prefix is embedded in the escalation text.
   */
  async findTicketByPrefix(prefix: string): Promise<SupportTicketRow | null> {
    const clean = prefix.toLowerCase().replace(/[^a-f0-9]/g, '').slice(0, 8);
    if (clean.length !== 8) return null;
    const r = await this.pg.query(
      `SELECT * FROM support_tickets WHERE id::text LIKE $1 ORDER BY created_at DESC LIMIT 1`,
      [`${clean}%`],
    );
    return r.rows[0] || null;
  }

  /**
   * Post an owner reply into a ticket — same semantics as adminReply but sender_id comes from Telegram.
   */
  async postOwnerReplyFromTelegram(
    ticketId: string, telegramUserId: string, displayName: string, content: string, visibleToUser = true,
  ): Promise<void> {
    await this.insertMessage(
      ticketId, 'owner', `tg:${telegramUserId}`, content,
      { via: 'telegram', author: displayName }, visibleToUser,
    );
    if (visibleToUser) {
      await this.pg.query(
        `UPDATE support_tickets SET status = 'owner_handling', updated_at = now()
         WHERE id = $1 AND status IN ('escalated','ai_handling')`,
        [ticketId],
      );
    }
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'owner', $2, 'reply', $3)`,
      [ticketId, `tg:${telegramUserId}`, JSON.stringify({ via: 'telegram', author: displayName, length: content.length })],
    );
  }

  async adminStats(windowDays = 7) {
    const window = Math.max(1, Math.min(90, windowDays));
    // Active breakdown
    const active = await this.countActiveTickets();

    // Volume + resolution breakdown over the window
    const vol = await this.pg.query(
      `SELECT
          count(*) FILTER (WHERE created_at > now() - ($1 || ' days')::interval)::int AS created_in_window,
          count(*) FILTER (WHERE resolved_at > now() - ($1 || ' days')::interval)::int AS resolved_in_window,
          count(*) FILTER (WHERE resolved_at > now() - ($1 || ' days')::interval
                             AND NOT EXISTS (SELECT 1 FROM support_events e
                                             WHERE e.ticket_id = support_tickets.id AND e.action = 'escalate'))::int AS ai_only_in_window
       FROM support_tickets`,
      [String(window)],
    );
    const v = vol.rows[0] || {};

    // Avg time to first owner reply (escalation → first owner message)
    const tt = await this.pg.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (om.created_at - e.created_at)))::int AS avg_seconds
       FROM support_events e
       JOIN LATERAL (
         SELECT created_at FROM support_messages
         WHERE ticket_id = e.ticket_id AND sender_type = 'owner'
         ORDER BY created_at ASC LIMIT 1
       ) om ON true
       WHERE e.action = 'escalate'
         AND e.created_at > now() - ($1 || ' days')::interval`,
      [String(window)],
    );
    const avgSec = tt.rows[0]?.avg_seconds != null ? Number(tt.rows[0].avg_seconds) : null;

    // Total refunds issued in window
    const ref = await this.pg.query(
      `SELECT count(*)::int AS refund_count,
              COALESCE(SUM((payload->>'amount')::bigint), 0)::bigint AS refund_sum
       FROM support_events
       WHERE action = 'refund' AND created_at > now() - ($1 || ' days')::interval`,
      [String(window)],
    );

    return {
      window_days: window,
      active,
      created_in_window: Number(v.created_in_window || 0),
      resolved_in_window: Number(v.resolved_in_window || 0),
      ai_only_in_window: Number(v.ai_only_in_window || 0),
      avg_first_owner_reply_seconds: avgSec,
      refund_count: Number(ref.rows[0]?.refund_count || 0),
      refund_sum: Number(ref.rows[0]?.refund_sum || 0),
    };
  }

  async countActiveTickets(): Promise<{ escalated: number; owner_handling: number; ai_handling: number }> {
    const r = await this.pg.query(
      `SELECT status, count(*)::int AS n FROM support_tickets
       WHERE status IN ('escalated','owner_handling','ai_handling') GROUP BY status`,
    );
    const out: any = { escalated: 0, owner_handling: 0, ai_handling: 0 };
    r.rows.forEach((row: any) => { out[row.status] = row.n; });
    return out;
  }

  async setStatusFromTelegram(ticketId: string, telegramUserId: string, status: string) {
    const allowed = ['resolved', 'closed', 'owner_handling', 'ai_handling'];
    if (!allowed.includes(status)) throw new BadRequestException('invalid status');
    await this.pg.query(
      `UPDATE support_tickets
         SET status = $1,
             resolved_at = CASE WHEN $1 IN ('resolved','closed') THEN now() ELSE NULL END,
             updated_at = now()
         WHERE id = $2`,
      [status, ticketId],
    );
    await this.pg.query(
      `INSERT INTO support_events (ticket_id, actor_type, actor_id, action, payload)
       VALUES ($1, 'owner', $2, 'status_change', $3)`,
      [ticketId, `tg:${telegramUserId}`, JSON.stringify({ status, via: 'telegram' })],
    );
  }

  async insertMessage(
    ticketId: string, senderType: SenderType, senderId: string | null,
    content: string, metadata: any = null, visibleToUser = true,
  ): Promise<SupportMessageRow> {
    const r = await this.pg.query(
      `INSERT INTO support_messages (ticket_id, sender_type, sender_id, content, metadata, visible_to_user)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING *`,
      [ticketId, senderType, senderId, content, metadata ? JSON.stringify(metadata) : null, visibleToUser],
    );
    await this.pg.query(
      `UPDATE support_tickets SET last_message_at = now(), updated_at = now() WHERE id = $1`,
      [ticketId],
    );
    return r.rows[0];
  }
}
