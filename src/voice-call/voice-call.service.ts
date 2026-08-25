import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { ChatService } from '../chat/chat.service';
import { LiveKitClient } from './livekit.client';
import { CompletePayload, HOST_AGENT_ID, SPECIALISTS } from './voice-call.types';

/** Ставки OpenAI Realtime за 1M аудио-токенов, флагман. */
const AUDIO_IN_USD_PER_1M = 32;
const AUDIO_OUT_USD_PER_1M = 64;

const PREAMBLE_MSG_LIMIT = 20;
const PREAMBLE_CHAR_LIMIT = 4000;

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
   * с ним же. Если их много — сжимаем, иначе съедим контекст Realtime-сессии,
   * а он и без того переотправляется на каждый ход.
   */
  async buildPreamble(userId: string): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [`${userId}_${HOST_AGENT_ID}`, PREAMBLE_MSG_LIMIT],
    );
    const rows = [...res.rows].reverse();
    if (!rows.length) return '';

    const flat = rows
      .map((r: any) => `${r.sender_type === 'human' ? 'Пользователь' : 'Роман'}: ${r.content}`)
      .join('\n');
    if (flat.length <= PREAMBLE_CHAR_LIMIT) return flat;

    const prompt =
      `Сожми переписку в один абзац до 1500 символов: о чём говорили, что решили, ` +
      `что осталось открытым. Только сам абзац, без вступлений.\n\n${flat}`;
    const short = await this.chat.generateAgentReply(
      userId, String(HOST_AGENT_ID), prompt, `voice_preamble_${randomUUID()}`,
    );
    return (short || '').trim().slice(0, 1500);
  }

  async start(userId: string): Promise<{ callId: string; roomName: string; token: string; wsUrl: string }> {
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

  costUsd(audioIn: number, audioOut: number): number {
    return (audioIn / 1e6) * AUDIO_IN_USD_PER_1M + (audioOut / 1e6) * AUDIO_OUT_USD_PER_1M;
  }

  async complete(callId: string, payload: CompletePayload): Promise<void> {
    const call = await this.load(callId);
    const durationSec = Math.max(0, Math.round((Date.now() - new Date(call.started_at).getTime()) / 1000));
    const cost = this.costUsd(payload.usage.audioInputTokens, payload.usage.audioOutputTokens);

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

    // Учитываем, но не списываем: тариф назначать пока не из чего.
    await this.pg.query(
      `INSERT INTO token_consumption_tasks (execution_id, user_id, status, agent_id, input_tokens, output_tokens, tokens_to_consume, metadata)
       VALUES ($1, $2, 'pending', $3, $4, $5, 0, $6)`,
      [
        Math.floor(Math.random() * 2_000_000_000), call.user_id, HOST_AGENT_ID,
        payload.usage.audioInputTokens, payload.usage.audioOutputTokens,
        JSON.stringify({ kind: 'voice_call', callId, costUsd: cost, durationSec, model: payload.usage.model }),
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

  async markInterrupted(callId: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls SET status = 'interrupted', ended_at = now() WHERE id = $1 AND status IN ('dialing','active')`,
      [callId],
    );
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
