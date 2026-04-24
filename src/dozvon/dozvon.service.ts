import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { SipService } from './sip.service';
import { VoiceAgentService } from './voice-agent.service';
import { RecorderService } from './recorder.service';
import Anthropic from '@anthropic-ai/sdk';
import axios from 'axios';

@Injectable()
export class DozvonService {
  private readonly logger = new Logger(DozvonService.name);
  private readonly anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly sip: SipService,
    private readonly agent: VoiceAgentService,
    private readonly recorder: RecorderService,
  ) {}

  // ─── CAMPAIGNS ───────────────────────────────────────────────────

  async getCampaigns(userId: string) {
    const res = await this.pg.query(
      `SELECT c.*,
              COUNT(cl.id)::int AS total_calls,
              COUNT(cl.id) FILTER (WHERE cl.status = 'done')::int AS done_calls,
              (
                -- Вырезаем inline-маркер плана из превью — оставляем только человеческий текст.
                SELECT substring(
                  regexp_replace(content, '\[\[CAMPAIGN_PLAN\]\][\s\S]*?\[\[/CAMPAIGN_PLAN\]\]', '📋 План обзвона', 'g'),
                  1, 120
                )
                FROM custom_chat_history
                WHERE session_id = 'dozvon_camp_' || c.id
                ORDER BY created_at DESC LIMIT 1
              ) AS last_message_preview,
              (
                SELECT max(created_at)
                FROM custom_chat_history
                WHERE session_id = 'dozvon_camp_' || c.id
              ) AS last_message_at
       FROM dozvon_campaigns c
       LEFT JOIN dozvon_calls cl ON cl.campaign_id = c.id
       WHERE c.user_id = $1
       GROUP BY c.id
       ORDER BY COALESCE((SELECT max(created_at) FROM custom_chat_history WHERE session_id = 'dozvon_camp_' || c.id), c.created_at) DESC`,
      [userId],
    );
    return res.rows;
  }

  async getCampaign(userId: string, id: number) {
    const res = await this.pg.query(
      `SELECT c.*,
              COALESCE(json_agg(cl.* ORDER BY cl.created_at) FILTER (WHERE cl.id IS NOT NULL), '[]') AS calls
       FROM dozvon_campaigns c
       LEFT JOIN dozvon_calls cl ON cl.campaign_id = c.id
       WHERE c.id = $1 AND c.user_id = $2
       GROUP BY c.id`,
      [id, userId],
    );
    if (!res.rows[0]) throw new NotFoundException('Campaign not found');
    return res.rows[0];
  }

  async createCampaign(userId: string, body: { title?: string; task_text?: string }) {
    // Новый подход: кампания создаётся пустой в статусе planning.
    // План формирует LLM-чат через DozvonChatService при последующих сообщениях.
    const title = (body.title || body.task_text || 'Новая задача').trim().slice(0, 80) || 'Новая задача';
    const res = await this.pg.query(
      `INSERT INTO dozvon_campaigns (user_id, status, title, task_text)
       VALUES ($1, 'planning', $2, $3) RETURNING *`,
      [userId, title, body.task_text || null],
    );
    return res.rows[0];
  }

  async deleteCampaign(userId: string, id: number) {
    const res = await this.pg.query(
      `DELETE FROM dozvon_campaigns WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    if (!res.rows[0]) throw new NotFoundException('Campaign not found');
    return { deleted: true };
  }

  // ─── EXECUTE ─────────────────────────────────────────────────────

  async executeCampaign(userId: string, id: number) {
    const campaign = await this.getCampaign(userId, id);
    if (!['draft', 'scheduled', 'ready', 'planning'].includes(campaign.status)) {
      throw new BadRequestException(`Cannot execute campaign in status: ${campaign.status}`);
    }
    const plan: Array<{ name: string; phone: string }> = campaign.call_plan?.calls || [];
    if (!plan.length) {
      throw new BadRequestException('План обзвона пуст. Сначала обсудите задачу с ассистентом.');
    }

    await this.pg.query(
      `UPDATE dozvon_campaigns SET status = 'running', updated_at = now() WHERE id = $1`,
      [id],
    );

    // Системное сообщение в чат кампании — «обзвон начат».
    await this.appendChatMessage(id, 'ai',
      `▶️ Запускаю обзвон по плану: ${plan.length} ${plan.length === 1 ? 'звонок' : 'звонков'}.`);

    // Insert pending calls from plan
    for (const c of plan) {
      await this.pg.query(
        `INSERT INTO dozvon_calls (campaign_id, contact_name, phone, status) VALUES ($1, $2, $3, 'pending')`,
        [id, c.name || null, c.phone],
      );
    }

    // Fire-and-forget execution
    this.runCalls(id, campaign).catch(err =>
      this.logger.error(`Campaign ${id} failed: ${err.message}`),
    );

    return { status: 'running', campaign_id: id };
  }

  async scheduleCampaign(userId: string, id: number, scheduledAt: string) {
    const ts = new Date(scheduledAt);
    if (isNaN(ts.getTime())) throw new BadRequestException('Invalid scheduled_at');
    if (ts <= new Date()) throw new BadRequestException('scheduled_at must be in the future');
    await this.pg.query(
      `UPDATE dozvon_campaigns SET status = 'scheduled', scheduled_at = $1, updated_at = now()
       WHERE id = $2 AND user_id = $3`,
      [ts.toISOString(), id, userId],
    );
    return { status: 'scheduled', scheduled_at: ts.toISOString() };
  }

  // ─── CALL COMPLETE CALLBACK ───────────────────────────────────────

  /** Добавить сообщение в чат кампании (используется из handleCallComplete / executeCampaign). */
  private async appendChatMessage(
    campaignId: number,
    sender: 'human' | 'ai',
    content: string,
  ): Promise<void> {
    try {
      await this.pg.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type)
         VALUES ($1, $2, 0, $3, 'text')`,
        [`dozvon_camp_${campaignId}`, sender, content],
      );
    } catch (e: any) {
      this.logger.warn(`appendChatMessage campaign=${campaignId}: ${e.message}`);
    }
  }

  async handleCallComplete(payload: {
    call_id: number;
    campaign_id: number;
    status: string;
    transcript?: string;
    summary?: string;
    recording_url?: string;
    duration_sec?: number;
  }) {
    await this.pg.query(
      `UPDATE dozvon_calls
       SET status = $1, transcript = $2, summary = $3, recording_url = $4, duration_sec = $5
       WHERE id = $6`,
      [payload.status, payload.transcript || null, payload.summary || null,
       payload.recording_url || null, payload.duration_sec || null, payload.call_id],
    );

    // Пишем результат звонка в чат кампании (виден в sidebar + в основной панели).
    const callRow = await this.pg.query(
      `SELECT contact_name, phone FROM dozvon_calls WHERE id = $1`,
      [payload.call_id],
    );
    const { contact_name, phone } = callRow.rows[0] || {};
    const emojiByStatus: Record<string, string> = {
      done: '✅', failed: '❌', no_answer: '📵', busy: '⏳',
    };
    const emoji = emojiByStatus[payload.status] || 'ℹ️';
    const title = contact_name || phone || 'Звонок';
    const lines = [`${emoji} ${title} — ${payload.status}${payload.duration_sec ? `, ${payload.duration_sec}с` : ''}`];
    if (payload.summary) lines.push('', `**Резюме:** ${payload.summary}`);
    if (payload.transcript) lines.push('', '**Диалог:**', payload.transcript);
    if (payload.recording_url) lines.push('', `🎧 [Запись](${payload.recording_url})`);
    await this.appendChatMessage(payload.campaign_id, 'ai', lines.join('\n'));

    // Check if all calls in campaign finished
    const pending = await this.pg.query(
      `SELECT COUNT(*) FROM dozvon_calls
       WHERE campaign_id = $1 AND status NOT IN ('done','failed','no_answer','busy')`,
      [payload.campaign_id],
    );
    // Закрываем room конкретного звонка (если ещё не закрылась) — SIP hangup.
    await this.sip.deleteRoom(`dozvon_call_${payload.call_id}`);

    if (parseInt(pending.rows[0].count, 10) === 0) {
      const summary = await this.generateCampaignSummary(payload.campaign_id);
      await this.pg.query(
        `UPDATE dozvon_campaigns SET status = 'done', summary = $1, updated_at = now() WHERE id = $2`,
        [JSON.stringify(summary), payload.campaign_id],
      );
    }
  }

  // ─── PRIVATE HELPERS ─────────────────────────────────────────────

  private async runCalls(campaignId: number, campaign: any) {
    const callsRes = await this.pg.query(
      `SELECT id, contact_name, phone FROM dozvon_calls
       WHERE campaign_id = $1 AND status = 'pending' ORDER BY id`,
      [campaignId],
    );

    // Единый system_prompt из плана (goal + script_hint'ы). Имя агента и голос —
    // жёстко дефолтные, фича выбора из UI убрана.
    const agent_name = 'Иван';
    const planGoal = campaign.call_plan?.goal || campaign.task_text || '';
    const defaultPrompt = planGoal
      ? `Тебя зовут ${agent_name}, ты — ассистент, совершающий телефонный звонок по поручению пользователя. ` +
        `Цель звонка: ${planGoal}. ` +
        `Общайся вежливо и естественно, на русском. Представься именем "${agent_name}", коротко озвучь цель, ` +
        `задай нужные вопросы, дождись ответов и попрощайся. Не говори что ты AI или робот, просто ассистент.`
      : `Тебя зовут ${agent_name}, ты — ассистент. Представься именем "${agent_name}", озвучь цель звонка и попрощайся.`;
    const voice_id = 'default';
    const system_prompt = campaign.system_prompt || defaultPrompt;

    for (const call of callsRes.rows) {
      // Уникальная room на звонок — удаляется в finally, hangup гарантирован.
      const roomName = `dozvon_call_${call.id}`;
      if (!call.phone) {
        await this.pg.query(
          `UPDATE dozvon_calls SET status = 'failed', summary = 'Не указан номер телефона' WHERE id = $1`,
          [call.id],
        );
        continue;
      }

      try {
        await this.pg.query(
          `UPDATE dozvon_calls SET status = 'dialing' WHERE id = $1`, [call.id],
        );
        await this.appendChatMessage(campaignId, 'ai',
          `📞 Звоню ${call.contact_name || call.phone}…`);

        // Дополняем system_prompt конкретной подсказкой для текущего звонка.
        const hint = (campaign.call_plan?.calls || []).find(
          (c: any) => c.phone === call.phone,
        )?.script_hint;
        const callPrompt = hint ? `${system_prompt}\n\nФокус этого звонка: ${hint}` : system_prompt;

        const agentToken = await this.sip.createAgentToken(roomName, `agent-${call.id}`);

        await this.agent.dispatchCall({
          call_id: call.id,
          campaign_id: campaignId,
          room_name: roomName,
          agent_token: agentToken,
          phone: call.phone,
          voice_id,
          system_prompt: callPrompt,
          agent_name,
          contact_name: call.contact_name,
        });

        // Запускаем recorder (Taler :3100). Он начнёт писать через ~5с после connect.
        this.recorder.start(call.id, roomName).catch(() => {/* graceful */});

        await this.sip.dialOutbound(roomName, call.phone);

        // Poll for completion (max 5 min per call).
        await this.waitForCall(call.id, 5 * 60_000);
      } catch (err: any) {
        this.logger.error(`Call ${call.id} failed: ${err.message}`);
        await this.pg.query(
          `UPDATE dozvon_calls SET status = 'failed', summary = $1 WHERE id = $2`,
          [err.message, call.id],
        );
      } finally {
        // Просим recorder остановить запись и прислать MP3 к нам (upload endpoint).
        await this.recorder.stop(roomName);
        // deleteRoom чуть позже — recorder успеет finalize.
        setTimeout(() => { this.sip.deleteRoom(roomName).catch(() => {}); }, 2000);
      }
    }
  }

  /** Вызывается из upload endpoint'а при получении MP3 от recorder'а. */
  async attachRecording(callId: number, url: string): Promise<void> {
    const r = await this.pg.query(
      `SELECT campaign_id, contact_name, phone FROM dozvon_calls WHERE id = $1`, [callId],
    );
    const call = r.rows[0];
    if (!call) return;
    await this.appendChatMessage(call.campaign_id, 'ai',
      `🎧 Запись ${call.contact_name || call.phone}: [открыть/скачать](${url})`);
  }

  private waitForCall(callId: number, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(async () => {
        const res = await this.pg.query(
          `SELECT status FROM dozvon_calls WHERE id = $1`, [callId],
        );
        const status = res.rows[0]?.status;
        if (['done', 'failed', 'no_answer', 'busy'].includes(status)) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          clearInterval(interval);
          await this.pg.query(
            `UPDATE dozvon_calls SET status = 'failed', summary = 'Timeout' WHERE id = $1`,
            [callId],
          );
          resolve();
        }
      }, 5000);
    });
  }

  private async generateCampaignSummary(campaignId: number) {
    const res = await this.pg.query(
      `SELECT contact_name, phone, status, summary FROM dozvon_calls WHERE campaign_id = $1`,
      [campaignId],
    );
    if (!res.rows.length) return { text: 'Нет звонков' };

    const lines = res.rows.map(c =>
      `- ${c.contact_name || c.phone}: ${c.status} — ${c.summary || 'нет данных'}`,
    ).join('\n');

    const msg = await this.anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      messages: [{
        role: 'user',
        content: `Составь краткое резюме результатов звонков:\n${lines}\n\nВерни JSON: {"text":"...", "success_count":N, "failed_count":N}`,
      }],
    });

    const text = (msg.content[0] as any).text;
    try {
      const match = text.match(/\{[\s\S]*\}/);
      return match ? JSON.parse(match[0]) : { text };
    } catch {
      return { text };
    }
  }
}
