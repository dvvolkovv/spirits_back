import {
  Body, Controller, Headers, Logger, Post, ServiceUnavailableException, UnauthorizedException,
} from '@nestjs/common';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { canonicalJson, verifyAttendeeSignature } from './attendee-signature';
import { TERMINAL_BOT_STATES } from './attendee.client';
import { MeetingWebhookDeliveryService } from './meet-webhook-delivery.service';
import { MeetingWebhookInboxStore } from './meet-webhook-inbox.store';

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
 * Приём durable: событие сначала кладётся в inbox (PostgreSQL), и только потом
 * подтверждается; в LiveKit его доставляет фоновый DeliveryService с ретраями.
 *
 * `{ok: true}` означает «событие надёжно принято» (вставка или дубликат) либо
 * «осознанно отфильтровано» (нет callId, неизвестный триггер, пустой чат,
 * звонок не найден или закрыт). 503 отдаётся только там, где повтор от
 * Attendee имеет смысл: не прочитался звонок или недоступен inbox. Ошибки
 * подписи — 401, как раньше.
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

  constructor(
    private readonly calls: VoiceCallService,
    private readonly inbox: MeetingWebhookInboxStore,
    private readonly delivery: MeetingWebhookDeliveryService,
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

    const msg = this.toDataMessage(body);
    if (!msg) return { ok: true };

    let call: Awaited<ReturnType<VoiceCallService['load']>> | null;
    try {
      call = await this.calls.load(callId);
    } catch (e: any) {
      // Не смогли прочитать звонок — это не «звонка нет». Ack потерял бы
      // событие, а Attendee ретраит именно на 5xx. Payload не логируем.
      this.logger.error(`[meet] не удалось загрузить звонок, trigger=${body.trigger}: ${e?.message}`);
      throw new ServiceUnavailableException('voice calls unavailable');
    }
    // Звонок уже закрыт или не найден — отправлять некуда, комната удалена.
    if (!call || !this.calls.isActive(call)) return { ok: true };

    try {
      await this.inbox.enqueue({
        callId,
        idempotencyKey: body.idempotency_key || null,
        trigger: body.trigger,
        message: msg,
      });
    } catch (e: any) {
      // FK: звонок удалён между load и INSERT — доставлять некуда.
      if (e?.code === '23503') return { ok: true };
      this.logger.error(`[meet] inbox недоступен, trigger=${body.trigger}: ${e?.message}`);
      throw new ServiceUnavailableException('webhook inbox unavailable');
    }
    // И вставка, и дубликат: прошлая доставка могла не состояться, подтолкнуть
    // pump безвредно. Не ждём результата.
    this.delivery.kick();
    return { ok: true };
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
      case 'chat_messages.update': {
        const text = String(d.text ?? '').trim();
        // Пустое сообщение слать незачем: в контексте оно только мешает.
        if (!text) return null;
        return {
          v: 1, type: 'meet_chat',
          text,
          sender: String(d.sender_name ?? 'участник'),
          uuid: String(d.sender_uuid ?? ''),
          // `only_bot` — это личное сообщение АССИСТЕНТУ, то есть прямая
          // просьба, а не реплика встречи. Различать обязательно: на личное
          // отвечаем всегда, общее по умолчанию только слушаем.
          private: String(d.to ?? '') === 'only_bot',
        };
      }
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
