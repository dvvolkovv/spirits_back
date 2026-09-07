import { Injectable, Logger } from '@nestjs/common';

/**
 * Attendee — мост в встречи площадок без LiveKit.
 *
 * Живёт на отдельном хосте: каждый бот — полный Chrome со страницей Meet, и
 * рядом с LiveKit ему не место. Мы его самохостим, то есть недоступность —
 * наша проблема, а не чужая; всё равно ведём себя как с чужим сервисом:
 * короткий таймаут, любая неожиданность → null и строка в лог. Вход во встречу
 * не должен падать 500-й из-за того, что контейнер перезапускается.
 */

/** Дольше вход во встречу не ждём: человек смотрит на кнопку. */
const TIMEOUT_MS = 10_000;

/**
 * Частота звука. 24 кГц — родная для OpenAI Realtime, поэтому на всём пути
 * нет ни одного ресемпла. Attendee принимает 8000, 16000 или 24000.
 */
export const ATTENDEE_SAMPLE_RATE = 24_000;

/**
 * Что слушаем.
 *
 * `speech_start_stop` — не украшение: в LiveKit-комнате участников нет вовсе,
 * и без него пропала бы разметка говорящего, которая в своих комнатах берётся
 * из ActiveSpeakersChanged. `join_leave` держит правила выхода и гейт по имени.
 */
const TRIGGERS = [
  'bot.state_change',
  'participant_events.join_leave',
  'participant_events.speech_start_stop',
];

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  callId: string;
}

@Injectable()
export class AttendeeClient {
  private readonly logger = new Logger(AttendeeClient.name);

  private base(): string {
    return (process.env.ATTENDEE_BASE_URL || '').replace(/\/+$/, '');
  }

  private async call(path: string, init: RequestInit): Promise<any | null> {
    const base = this.base();
    const key = process.env.ATTENDEE_API_KEY;
    // Без настроек молчим, а не бьёмся в пустой адрес: на стендах без Attendee
    // встречи Meet просто недоступны, и это не повод падать.
    if (!base || !key) {
      this.logger.warn('attendee не настроен (ATTENDEE_BASE_URL / ATTENDEE_API_KEY)');
      return null;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        this.logger.warn(`attendee ${path}: HTTP ${res.status}`);
        return null;
      }
      return await res.json().catch(() => ({}));
    } catch (e: any) {
      this.logger.warn(`attendee ${path}: ${e?.name === 'AbortError' ? 'таймаут' : e?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправить бота во встречу. `null` — не получилось, причина уже в логе. */
  async createBot(p: CreateBotParams): Promise<{ botId: string } | null> {
    const ws = process.env.ATTENDEE_AUDIO_WS_URL || '';
    const hook = process.env.ATTENDEE_WEBHOOK_URL || '';
    const d = await this.call('/api/v1/bots', {
      method: 'POST',
      body: JSON.stringify({
        meeting_url: p.meetingUrl,
        bot_name: p.botName,
        // callId в метаданных — так вебхук находит звонок, не заводя своей
        // таблицы соответствий bot_id → call. Attendee возвращает metadata
        // обратно в каждом событии полем bot_metadata.
        metadata: { callId: p.callId },
        websocket_settings: {
          // callId в query — воркер по нему узнаёт, чей это звук, ещё до
          // первого сообщения. Одного вебсокет-сервера хватает на все встречи.
          audio: { url: `${ws}?callId=${encodeURIComponent(p.callId)}`, sample_rate: ATTENDEE_SAMPLE_RATE },
        },
        webhooks: [{ url: hook, triggers: TRIGGERS }],
      }),
    });
    if (!d || typeof d.id !== 'string' || !d.id) return null;
    return { botId: d.id };
  }

  /**
   * Вывести бота из встречи.
   *
   * Обязательно при любом выходе ассистента: без этого Chrome остаётся сидеть
   * в встрече и после того, как ассистент ушёл. `false` — бота уже не было,
   * это нормальный исход, реапер и leave могут прийти одновременно.
   */
  async removeBot(botId: string): Promise<boolean> {
    const d = await this.call(`/api/v1/bots/${encodeURIComponent(botId)}/leave`, { method: 'POST' });
    return d !== null;
  }
}
