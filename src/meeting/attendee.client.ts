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
  /**
   * Адрес НАШЕГО вебсокета, куда Attendee пришлёт звук.
   *
   * Знает его только воркер: порт свой на задание (AttendeeAudioHub), а не
   * общий на процесс, — поэтому адрес приходит параметром, а не собирается
   * здесь из env. Тот же довод, по которому createBot теперь зовётся не из
   * join(), а из MeetingService.attachBot() уже после того, как воркер
   * сообщил бэкенду свой wsUrl.
   */
  wsUrl: string;
}

@Injectable()
export class AttendeeClient {
  private readonly logger = new Logger(AttendeeClient.name);

  private base(): string {
    return (process.env.ATTENDEE_BASE_URL || '').replace(/\/+$/, '');
  }

  /**
   * Результат вызова: статус и разобранное тело.
   *
   * `null` означает «не дозвонились» — таймаут, сеть, отсутствующая настройка.
   * Это принципиально отличается от «сервис ответил, но отказал»: во втором
   * случае мы знаем состояние бота, в первом — нет.
   */
  private async call(path: string, init: RequestInit): Promise<{ status: number; data: any } | null> {
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
        // Свои заголовки мёржим поверх переданных, а не затираем их целиком:
        // сегодня никто своих не передаёт, но затирание — тихая ловушка.
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Token ${key}`, 'Content-Type': 'application/json' },
      });
      // Тело разбираем терпимо и отдельно от решения об успехе: у `leave` его
      // может не быть вовсе, а `createBot` сам проверит наличие id.
      let data: any = null;
      try { data = await res.json(); } catch { data = null; }
      // 404 не шумит в логе: для removeBot это штатный исход, а не сбой —
      // так же, как в talerid-room.client.ts.
      if (!res.ok && res.status !== 404) {
        this.logger.warn(`attendee ${path}: HTTP ${res.status}`);
      }
      return { status: res.status, data };
    } catch (e: any) {
      this.logger.warn(`attendee ${path}: ${e?.name === 'AbortError' ? 'таймаут' : e?.message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Отправить бота во встречу. `null` — не получилось, причина уже в логе. */
  async createBot(p: CreateBotParams): Promise<{ botId: string } | null> {
    const hook = process.env.ATTENDEE_WEBHOOK_URL || '';
    const r = await this.call('/api/v1/bots', {
      method: 'POST',
      body: JSON.stringify({
        meeting_url: p.meetingUrl,
        bot_name: p.botName,
        // callId в метаданных — так вебхук находит звонок, не заводя своей
        // таблицы соответствий bot_id → call. Attendee возвращает metadata
        // обратно в каждом событии полем bot_metadata.
        metadata: { callId: p.callId },
        websocket_settings: {
          // wsUrl приходит от вызывающего КАК ЕСТЬ, уже с callId в query:
          // его целиком собрал воркер (AttendeeAudioHub.publicUrl), потому
          // что порт свой на задание, и здесь узнать его неоткуда.
          audio: { url: p.wsUrl, sample_rate: ATTENDEE_SAMPLE_RATE },
        },
        webhooks: [{ url: hook, triggers: TRIGGERS }],
      }),
    });
    if (!r || r.status < 200 || r.status >= 300) return null;
    const id = r.data?.id;
    if (typeof id !== 'string' || !id) return null;
    return { botId: id };
  }

  /**
   * Вывести бота из встречи.
   *
   * Обязательно при любом выходе ассистента: иначе Chrome остаётся сидеть в
   * встрече и после того, как ассистент ушёл — лишний участник в чужих
   * переговорах, которого никто не звал.
   *
   * Три исхода, и различать их обязательно:
   *   `true`  — Attendee подтвердил вывод;
   *   `false` — бота уже не было (404). Штатный случай: реапер и leave могут
   *             прийти одновременно;
   *   `null`  — не дозвонились или сервис ответил ошибкой. Состояние бота
   *             НЕИЗВЕСТНО, и считать встречу убранной нельзя — иначе при
   *             перезапуске контейнера Attendee бот тихо остаётся в чужой
   *             встрече. Вызывающий обязан оставить запись реаперу на
   *             повторную попытку.
   */
  async removeBot(botId: string): Promise<boolean | null> {
    const r = await this.call(`/api/v1/bots/${encodeURIComponent(botId)}/leave`, { method: 'POST' });
    if (!r) return null;
    if (r.status === 404) return false;
    if (r.status >= 200 && r.status < 300) return true;
    return null;
  }
}
