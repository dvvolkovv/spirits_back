import {
  Body, Controller, Headers, Logger, Post, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { canonicalJson, verifyAttendeeSignature } from './attendee-signature';
import { TERMINAL_BOT_STATES } from './attendee.client';

/**
 * Вебхуки Attendee.
 *
 * Через них в воркер попадает то, чего он на встрече Meet не видит сам: состав
 * участников и кто говорит. В нашей LiveKit-комнате при такой встрече никого
 * нет, `remoteParticipants` всегда пуст, и без этого канала гейт по имени
 * срывался бы в solo, отметка «встреча началась» не ставилась бы, а правила
 * выхода уводили ассистента из живой встречи через LOBBY_MS.
 *
 * Тело разбирается обычным JSON-парсером, в отличие от `voice-call/internal`:
 * подпись Attendee считается по КАНОНИЗИРОВАННОМУ JSON, а не по сырым байтам,
 * поэтому сырое тело здесь не нужно и в main.ts ничего вешать не требуется.
 *
 * Ручка всегда отвечает `{ok: true}` на всё, что прошло подпись, — даже когда
 * событие некуда доставить. Ошибка в ответе заставила бы Attendee ретраить
 * до 30 раз впустую.
 */

/**
 * Состояния бота, после которых встречи не будет.
 *
 * Список сверен с исходниками Attendee 09.09.2026
 * (`bots/models.py`, `BotStates._get_state_to_api_code_mapping`). Полный
 * набор кодов: `ready`, `joining`, `joined_not_recording`,
 * `joined_recording`, `joined_recording_paused`,
 * `joined_recording_permission_denied`, `leaving`, `post_processing`,
 * `fatal_error`, `waiting_room`, `ended`, `data_deleted`, `scheduled`,
 * `staged`, `joining_breakout_room`, `leaving_breakout_room`, `connecting`,
 * `connected`, `disconnecting`.
 *
 * ⚠️ Первая редакция содержала `denied_entry` и `removed_from_meeting` —
 * таких состояний у Attendee НЕТ, они были выдуманы при планировании и
 * уехали в код. Отказ во входе Attendee сообщает как `fatal_error`, а
 * удаление из встречи — переходом в `ended`, так что поведение не страдало,
 * но два элемента набора были мёртвым кодом, вводящим в заблуждение.
 *
 * `waiting_room` сюда НЕ входит: это не отказ, а ожидание впуска — то самое
 * состояние, ради которого в карточке чата живёт плашка «ждём, пока
 * впустят». Считать его смертельным значило бы выходить из встречи ровно
 * тогда, когда хозяин собирается нас впустить.
 *
 * Сам набор живёт в attendee.client.ts: там он нужен, чтобы отличить «бота
 * выводить уже некого» от «состояние неизвестно, повторим». Факт один и тот
 * же, и два списка однажды разошлись бы.
 */
const FATAL_STATES = TERMINAL_BOT_STATES;

/**
 * Сколько ключей идемпотентности держим.
 *
 * Память процесса, а не Redis: событие живёт секунды, а рестарт означает, что
 * и звонка уже нет. Но потолок обязателен — без него множество растёт всю
 * жизнь процесса, а воркер живёт неделями.
 */
const SEEN_LIMIT = 5_000;

/**
 * Форма вебхука Attendee.
 *
 * ЭТО ОБЯЗАНО ОСТАТЬСЯ ИНТЕРФЕЙСОМ, а не классом.
 *
 * Подпись считается по канонизации того объекта, который доехал до
 * обработчика. Глобальный ValidationPipe в main.ts стоит с `transform: true`,
 * но интерфейс он пропускает нетронутым: интерфейсы стираются при
 * компиляции, в метаданные параметра уезжает `Object`, и `toValidate()`
 * возвращает false (проверено по @nestjs/common@10.4.22).
 *
 * Стоит превратить это в класс с декораторами class-validator — включатся
 * plainToClass и whitelist, объект разойдётся с подписанным, и ручка начнёт
 * молча отвечать 401. Юнит-тесты этого не поймают: они зовут receive()
 * напрямую, минуя пайп.
 */
interface AttendeeHook {
  idempotency_key?: string;
  bot_id?: string;
  bot_metadata?: { callId?: string };
  trigger: string;
  data: Record<string, any>;
}

@Controller('meet')
export class MeetWebhookController {
  private readonly logger = new Logger(MeetWebhookController.name);
  private readonly seen = new Set<string>();

  constructor(
    private readonly livekit: LiveKitClient,
    private readonly calls: VoiceCallService,
  ) {}

  @Post('attendee')
  async receive(
    @Headers('x-webhook-signature') signature: string,
    @Body() body: AttendeeHook,
  ): Promise<{ ok: true }> {
    // Секрет читаем на КАЖДОМ запросе: process.env наполняется ConfigModule
    // позже вычисления module-level констант. На звонках эта ошибка уже
    // оставляла внутренние ручки мёртвыми при заданном секрете.
    const secret = process.env.ATTENDEE_WEBHOOK_SECRET;
    if (!secret) throw new ServiceUnavailableException('attendee webhooks are not configured');
    if (!verifyAttendeeSignature(secret, body, signature)) {
      // Логируем канонизацию: иначе расхождение неотличимо от подделки.
      // Дробное число в payload делает совпадение невозможным (Python пишет
      // «1.0», JS после JSON.parse — «1»), и без этой строки сбой выглядел бы
      // как молчаливые 401, то есть как отсутствие присутствия.
      this.logger.warn(
        `[meet] подпись не сошлась, trigger=${body?.trigger} канонизация=${canonicalJson(body).slice(0, 500)}`,
      );
      throw new UnauthorizedException('bad signature');
    }

    const callId = body.bot_metadata?.callId;
    // Без callId событие адресовать некуда. Молча, а не ошибкой: это могут
    // быть события бота, заведённого не нами — например, вручную в UI.
    if (!callId) return { ok: true };

    const key = body.idempotency_key ? `${callId}:${body.idempotency_key}` : '';
    if (key && this.seen.has(key)) return { ok: true };
    if (key) this.remember(key);

    const msg = this.toDataMessage(body);
    if (!msg) return { ok: true };

    const call = await this.calls.load(callId).catch(() => null);
    // Звонок уже закрыт или не найден — отправлять некуда, комната удалена.
    if (!call || !this.calls.isActive(call)) return { ok: true };

    await this.livekit.send(call.room_name, msg as any).catch((e: any) => {
      this.logger.warn(`[meet] событие ${body.trigger} не доехало: ${e?.message}`);
    });
    return { ok: true };
  }

  private remember(key: string): void {
    // Простейшее вытеснение: при переполнении сбрасываем половину самых
    // старых. Set в JS сохраняет порядок вставки, этого достаточно.
    //
    // Множество общее на все одновременные встречи, поэтому одна очень
    // активная встреча теоретически может вытеснить ключи тихой раньше, чем
    // у Attendee истечёт окно ретраев — тогда вытесненный ключ вернётся и
    // событие обработается повторно. Это осознанная защита вторым эшелоном,
    // а не умолчание: Presence в воркере идемпотентен к повторным
    // join/leave/speech (повторный join того же uuid не удваивает состав),
    // то есть повтор деградирует мягко, а не портит состояние встречи.
    if (this.seen.size >= SEEN_LIMIT) {
      let drop = Math.floor(SEEN_LIMIT / 2);
      for (const k of this.seen) {
        this.seen.delete(k);
        if (--drop <= 0) break;
      }
    }
    this.seen.add(key);
  }

  private toDataMessage(body: AttendeeHook): Record<string, unknown> | null {
    const d = body.data || {};
    switch (body.trigger) {
      case 'participant_events.join_leave':
        return {
          v: 1, type: 'meet_participant',
          event: d.event_type === 'leave' ? 'leave' : 'join',
          uuid: String(d.participant_uuid ?? ''),
          name: String(d.participant_name ?? ''),
        };
      case 'participant_events.speech_start_stop':
        return {
          v: 1, type: 'meet_speaking',
          uuid: String(d.participant_uuid ?? ''),
          name: String(d.participant_name ?? ''),
          speaking: d.event_type === 'speech_start',
        };
      case 'bot.state_change': {
        // Код причины: `event_sub_type` точнее, `event_type` — если подтипа
        // нет. Без него в базе оказывалось «бот Attendee: fatal_error», а
        // настоящая причина («никто не ответил на просьбу впустить») лежала
        // только в логах контейнера. Живой прогон 09.09.2026: payload несёт
        // `event_type: could_not_join_meeting`,
        // `event_sub_type: request_to_join_denied`.
        const sub = String(d.event_sub_type ?? d.event_type ?? '');
        return {
          v: 1, type: 'meet_bot_state',
          state: String(d.new_state ?? ''),
          fatal: FATAL_STATES.has(String(d.new_state ?? '')),
          ...(sub ? { sub } : {}),
        };
      }
      default:
        return null;
    }
  }
}
