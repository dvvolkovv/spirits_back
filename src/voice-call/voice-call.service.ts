import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { CompletePayload, HOST_AGENT_ID, SPECIALISTS } from './voice-call.types';

/**
 * Ставки OpenAI Realtime за 1M аудио-токенов, по моделям.
 *
 * Захардкоженный флагман завышал бы цену mini в 3.2 раза — а ради измерения
 * реальной цены минуты фича и катится в v1, так что врать тут нельзя.
 */
const AUDIO_RATES_USD_PER_1M: Record<string, { in: number; out: number }> = {
  flagship: { in: 32, out: 64 },
  mini: { in: 10, out: 20 },
};

function ratesFor(model: string | undefined): { in: number; out: number } {
  return /mini/i.test(model || '') ? AUDIO_RATES_USD_PER_1M.mini : AUDIO_RATES_USD_PER_1M.flagship;
}

const PREAMBLE_MSG_LIMIT = 20;
const PREAMBLE_CHAR_LIMIT = 1800;

@Injectable()
export class VoiceCallService {
  private readonly logger = new Logger(VoiceCallService.name);

  constructor(
    private readonly pg: PgService,
    private readonly chat: ChatService,
    private readonly livekit: LiveKitClient,
  ) {}

  /**
   * Контекст, с которым Роман входит в разговор: последние сообщения из чата
   * с ним же.
   *
   * Собирается ТОЛЬКО из базы, без похода в LLM. Раньше при истории длиннее
   * 4000 символов здесь вызывался generateAgentReply за сжатием — и, поскольку
   * preamble считается до dispatchAgent, пользователь сорок секунд слушал
   * тишину, прежде чем Роман вообще входил в комнату. У реального юзера в
   * последних 20 сообщениях оказалось 22 000 символов, так что срабатывало
   * это всегда. Живой звонок 25.08.2026.
   *
   * Берём с конца, пока укладываемся в бюджет: свежие реплики важнее старых.
   */
  async buildPreamble(userId: string): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [`${userId}_${HOST_AGENT_ID}`, PREAMBLE_MSG_LIMIT],
    );
    if (!res.rows.length) return '';

    const lines: string[] = [];
    let budget = PREAMBLE_CHAR_LIMIT;
    for (const r of res.rows) {
      const who = r.sender_type === 'human' ? 'Пользователь' : 'Роман';
      const text = String(r.content || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const line = `${who}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`;
      if (line.length > budget) break;
      budget -= line.length;
      lines.push(line);
    }
    return lines.reverse().join('\n');
  }

  async start(userId: string): Promise<{ callId: string; roomName: string; token: string; wsUrl: string }> {
    // Один активный звонок на пользователя. Минута разговора стоит реальных
    // денег, а без этой проверки N вкладок (или цикл curl с админским
    // токеном) дают N комнат и N оплачиваемых Realtime-сессий, погасить
    // которые нечем. Индекс voice_calls_active_idx заведён ровно под неё.
    const active = await this.pg.query(
      `SELECT id FROM voice_calls WHERE user_id = $1 AND status IN ('dialing','active') LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ConflictException({ message: 'call already in progress', callId: active.rows[0].id });
    }

    const callId = randomUUID();
    const roomName = `voice_${callId}`;

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status) VALUES ($1, $2, $3, $4, 'dialing')`,
      [callId, userId, HOST_AGENT_ID, roomName],
    );

    const [token, preamble] = await Promise.all([
      this.livekit.userToken(roomName, `user_${userId}`),
      this.buildPreamble(userId),
    ]);

    await this.livekit.dispatchAgent(roomName, {
      callId,
      userId,
      preamble,
      specialists: Object.keys(SPECIALISTS),
      callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
    });

    return { callId, roomName, token, wsUrl: process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_URL || 'ws://localhost:7880' };
  }

  costUsd(audioIn: number, audioOut: number, model?: string): number {
    const r = ratesFor(model);
    return (audioIn / 1e6) * r.in + (audioOut / 1e6) * r.out;
  }

  async complete(callId: string, payload: CompletePayload): Promise<void> {
    const call = await this.load(callId);
    // Идемпотентность: воркер может ретрайнуть, а подписанный запрос —
    // прийти дважды. Без этой проверки получаем вторую карточку в ленте
    // и вторую строку учёта на тот же звонок.
    if (call.status === 'completed') {
      this.logger.warn(`[complete] call=${callId} уже завершён — повтор проигнорирован`);
      return;
    }
    const durationSec = Math.max(0, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
    const cost = this.costUsd(payload.usage.audioInputTokens, payload.usage.audioOutputTokens, payload.usage.model);

    const summary = await this.summarize(call.user_id, payload.transcript);

    await this.pg.query(
      `UPDATE voice_calls SET status = 'completed', ended_at = now(), duration_sec = $1,
         transcript = $2, summary = $3, cost_usd = $4, model = $5 WHERE id = $6`,
      [durationSec, JSON.stringify(payload.transcript), summary, cost, payload.usage.model, callId],
    );

    // Карточка в ленте. Схема истории не меняется: это обычное сообщение,
    // фронт узнаёт его по тегу.
    const minutes = Math.max(1, Math.round(durationSec / 60));
    const content = `{{voice_call: id=${callId}}}\n\nРазговор ${minutes} мин.\n\n${summary}`;
    await this.pg.query(
      `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
       VALUES ($1, 'ai', $2, $3, 'text', 0)`,
      [`${call.user_id}_${HOST_AGENT_ID}`, HOST_AGENT_ID, content],
    );

    // Учитываем, но НЕ списываем: тариф назначать пока не из чего.
    //
    // Статус обязан быть 'completed', а не 'pending'. TokenAccountingService
    // раз в 5 секунд забирает все 'pending' и при tokens_to_consume = 0 не
    // пропускает строку, а считает сумму сам — фолбэк
    // `input_tokens + output_tokens` (token-accounting.service.ts:74-76).
    // Со 'pending' с баланса уходило бы 1800 токенов за минуту разговора.
    // Тот же приём с тем же обоснованием — в claude-agent.service.ts:231.
    await this.pg.query(
      `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata, completed_at)
       VALUES ($1, $2, 'completed', $3, $4, $5, 0, $6, now())`,
      [
        Math.floor(Math.random() * 2_000_000_000), call.user_id, HOST_AGENT_ID,
        payload.usage.audioInputTokens, payload.usage.audioOutputTokens,
        JSON.stringify({ kind: 'voice_call', callId, costUsd: cost, durationSec, durationMs: durationSec * 1000, model: payload.usage.model }),
      ],
    );

    this.logger.log(`[complete] call=${callId} ${durationSec}s cost=$${cost.toFixed(4)}`);
  }

  async fail(callId: string, reason: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1, cost_usd = 0 WHERE id = $2`,
      [`Звонок не состоялся: ${reason}`, callId],
    );
  }

  /**
   * Положить трубку. Красить строку в БД недостаточно: воркер остаётся в
   * комнате один и продолжает жечь Realtime-сессию. Комнату надо закрыть —
   * тогда воркер получит disconnect и отправит complete.
   */
  async markInterrupted(callId: string): Promise<void> {
    const res = await this.pg.query(
      `UPDATE voice_calls SET status = 'interrupted', ended_at = now()
       WHERE id = $1 AND status IN ('dialing','active') RETURNING room_name`,
      [callId],
    );
    const roomName = res.rows[0]?.room_name;
    if (roomName) await this.livekit.closeRoom(roomName);
  }

  /** Живой ли звонок — job'ы по завершённому создавать незачем. */
  isActive(call: { status: string }): boolean {
    return call.status === 'dialing' || call.status === 'active';
  }

  async load(callId: string): Promise<any> {
    const res = await this.pg.query(`SELECT * FROM voice_calls WHERE id = $1`, [callId]);
    if (!res.rows[0]) throw new NotFoundException('call not found');
    return res.rows[0];
  }

  private async summarize(userId: string, transcript: CompletePayload['transcript']): Promise<string> {
    if (!transcript?.length) return 'Разговор без реплик.';
    const flat = transcript.map((t) => `${t.role === 'user' ? 'Пользователь' : 'Роман'}: ${t.text}`).join('\n');
    const prompt =
      `Ниже расшифровка голосового разговора. Напиши краткое резюме: о чём говорили, ` +
      `какие решения приняты, что осталось сделать. До 800 символов, без вступлений.\n\n${flat}`;
    try {
      const s = await this.chat.generateAgentReply(userId, String(HOST_AGENT_ID), prompt, `voice_summary_${randomUUID()}`);
      return (s || '').trim() || 'Резюме не сформировано.';
    } catch (e: any) {
      this.logger.warn(`summarize failed: ${e?.message}`);
      return 'Резюме не сформировано.';
    }
  }
}
