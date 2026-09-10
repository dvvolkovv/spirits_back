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
 * Состояния, из которых бот уже не вернётся.
 *
 * Один и тот же факт про бота нужен в двух местах, и держать два списка
 * значило бы однажды их разойтись: здесь — «выводить уже некого» (Attendee
 * отвечает на leave 400, и только по состоянию видно, мёртв бот или ещё
 * стучится), в вебхуке — «встречи не будет».
 *
 * Набор — из `bots/models.py`, `BotStates`. `waiting_room` сюда НЕ входит:
 * это ожидание впуска, а не отказ.
 */
export const TERMINAL_BOT_STATES = new Set(['fatal_error', 'ended', 'data_deleted']);

/**
 * Что слушаем.
 *
 * Только состояние бота. Состав встречи и разметку говорящего раньше
 * приходилось брать вебхуками, потому что в LiveKit-комнате участников не было
 * вовсе; с синхронизацией они приезжают настоящими событиями комнаты
 * (ParticipantConnected, ActiveSpeakersChanged) — теми же, что в своих
 * комнатах и у Taler ID.
 *
 * Состояние бота вебхуком остаётся, и заменить его нечем: «бота не пустили» и
 * «встречу закрыли» в комнате никак не видно — там просто не появляется
 * участников, что неотличимо от «люди ещё не собрались».
 */
const TRIGGERS = ['bot.state_change'];

/**
 * Настроен ли Attendee.
 *
 * Отдельной функцией, а не методом класса: проверку делает ещё и
 * `chat.service.ts`, чтобы не показывать карточку встречи там, где входить
 * некуда. Тащить туда зависимость ради двух переменных окружения незачем —
 * файл и так на 140 КБ.
 *
 * Нужна потому, что без Attendee фича бесполезна, но не безобидна: карточка
 * «Зайти» появлялась бы и всегда отказывала. Так выкатка становится
 * изменением конфигурации, а не деплоем.
 */
export function attendeeConfigured(): boolean {
  return !!process.env.ATTENDEE_BASE_URL && !!process.env.ATTENDEE_API_KEY;
}

export interface CreateBotParams {
  meetingUrl: string;
  botName: string;
  callId: string;
  /**
   * Комната LiveKit, в которую мост зеркалит встречу.
   *
   * Та же самая, где сидит задание воркера: раньше она была пустой по замыслу
   * и нужна была только ради job и дата-канала, а теперь в неё приезжают
   * участники встречи — каждый отдельным участником со своей дорожкой.
   */
  roomName: string;
  /**
   * Личность воркера в этой комнате: у неё мост берёт звук ассистента.
   *
   * Знает её только воркер — идентичность агенту назначает фреймворк
   * (`agent-AJ_xxx`), и до подключения её не знает никто. Отсюда порядок:
   * воркер подключается, сообщает личность подписанной ручкой, и только тогда
   * создаётся бот. Раньше тем же путём сообщался адрес вебсокета — поменялось
   * содержимое, не порядок.
   */
  agentIdentity: string;
  /**
   * Площадка. Нужна ровно ради `zoom_settings` — см. createBot.
   *
   * По умолчанию `meet`: он был первым, и вызовы без этого поля должны
   * продолжать работать как раньше.
   */
  provider?: 'meet' | 'zoom';
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
        // Звук ходит через комнату LiveKit, а не через наш вебсокет.
        //
        // Мост зеркалит КАЖДОГО участника встречи отдельным участником
        // комнаты с моно-дорожкой, чат кладёт текстовым потоком на топик
        // lk.chat, а звук ассистента берёт у участника из source_participant.
        // Проверено спайком 10.09.2026 (см. infra/attendee/README.md): это
        // снимает наш вебсокет-хаб, порт на задание, переподключения и
        // отсутствие диаризации разом.
        room_sync_settings: {
          sync_to_room: true,
          livekit: {
            room_name: p.roomName,
            // По identity, а не publish_on_behalf: воркер публикует сам за
            // себя, а второй вариант нужен агенту, публикующему за другого.
            source_participant: { identity: p.agentIdentity },
          },
        },
        webhooks: [{ url: hook, triggers: TRIGGERS }],
        // Записи не храним, и это не экономия, а решение о данных.
        //
        // По умолчанию Attendee пишет встречу в mp4 и грузит её в S3. Нам это
        // не нужно дважды: транскрипт мы ведём сами (`voice_calls.transcript`,
        // а `recording_url` в нашей схеме всегда NULL), а видеозапись
        // переговоров клиента в чужом хранилище — лишняя утечка. Проверено по
        // исходникам 09.09.2026: допустимы 'mp4', 'mp3' и 'none'.
        recording_settings: { format: 'none' },
        // Правила выхода — НАШИ, а не Attendee.
        //
        // Дефолты Attendee строже наших и потому решают за нас: 09.09.2026 на
        // живой встрече хозяин исчез из списка участников Meet (`status: 8`),
        // Attendee через 60 секунд одиночества сам нажал «выйти» —
        // `AUTO_LEAVE_ONLY_PARTICIPANT_IN_MEETING` в его логе, — и встреча
        // оборвалась на 95-й секунде. Мы увидели только обрыв вебсокета и
        // причину назвать не смогли.
        //
        // Наши правила живут в voice-host/src/occupancy.ts: опустевшую
        // встречу мы покидаем сразу по событию, а не по таймеру, поэтому
        // таймеры Attendee должны быть ЗАПАСОМ, а не первым срабатывающим
        // условием. Иначе причина выхода в логах и в базе всегда чужая.
        //
        // Значения (дефолты Attendee — в bots/automatic_leave_configuration.py):
        // - одиночество 300 с вместо 60: наш выход по событию быстрее, а этот
        //   таймер остаётся страховкой на случай, если вебхук не доехал;
        // - тишина 1800 с вместо 600: люди в переговорах молчат подолгу, и
        //   молчание — не повод уводить ассистента;
        // - потолок 7500 с — чуть выше нашего двухчасового HARD_CAP_MS, чтобы
        //   причину называли мы, но Chrome не мог пережить нас, если воркер
        //   умрёт до реапера;
        // - комната ожидания 900 с оставлена как есть: столько же ждёт впуска
        //   и воркер (CONNECT_TIMEOUT_MS), см. комментарий там.
        automatic_leave_settings: {
          only_participant_in_meeting_timeout_seconds: 300,
          silence_timeout_seconds: 1800,
          max_uptime_seconds: 7500,
        },
        // Zoom: ТОЛЬКО веб-адаптер, и это не предпочтение, а условие работы.
        //
        // У моста два адаптера Zoom, и `native` — значение ПО УМОЛЧАНИЮ.
        // Проверено подряд на одной живой встрече 10.09.2026: нативный
        // принимает наш звук с SDKERR_SUCCESS и не отдаёт его во встречу
        // (бот не приглушён, `can_unmute_by_self=True`, в голосовом канале —
        // и тишина), а веб-адаптер отдаёт звук той же браузерной машинерией,
        // что Meet, и слышен сразу.
        //
        // Забыть это поле — значит выпустить ассистента во встречу немым,
        // причём молча: ни ошибки, ни предупреждения не будет.
        ...(p.provider === 'zoom' ? { zoom_settings: { sdk: 'web' } } : {}),
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
    const path = `/api/v1/bots/${encodeURIComponent(botId)}`;
    const r = await this.call(`${path}/leave`, { method: 'POST' });
    if (!r) return null;
    if (r.status === 404) return false;
    if (r.status >= 200 && r.status < 300) return true;
    if (r.status === 400) {
      // Attendee отвечает 400, а НЕ 404, когда выводить уже некого: «Event
      // leave_requested not allowed when bot is in state ended. It is only
      // allowed in these states: joined_recording, …». Проверено на стенде
      // 09.09.2026 запросом к живому сервису.
      //
      // Прежняя редакция считала такой ответ «состояние неизвестно», и три
      // давно завершённых бота реапер перебирал каждый тик, не очищая
      // external_bot_id никогда. Хуже безобидного шума: настоящее «не знаю»
      // в этом шуме терялось.
      //
      // Но 400 сам по себе НЕ значит «бот мёртв»: leave не разрешён и в
      // joining, и в комнате ожидания, а такой бот ещё может войти в встречу.
      // Поэтому спрашиваем состояние и убираем запись только на терминальном.
      const st = await this.call(path, { method: 'GET' });
      const state = st?.status === 200 ? st.data?.state : undefined;
      if (typeof state === 'string' && TERMINAL_BOT_STATES.has(state)) return false;
      return null;
    }
    return null;
  }
}
