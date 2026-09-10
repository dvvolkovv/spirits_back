import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { LiveKitClient } from '../voice-call/livekit.client';
import { VoiceCallService } from '../voice-call/voice-call.service';
import { SPECIALIST_ROLES, SPECIALISTS } from '../voice-call/voice-call.types';
import { RoomService } from './room.service';
import { TalerIdRoomClient } from './talerid-room.client';
import { AttendeeClient, attendeeConfigured } from './attendee.client';
import { MeetingProvider } from './meeting-link';

/** Провайдер встречи в voice_calls. Дальше сюда добавится 'zoom'. */
const PROVIDER = 'linkeon_room';
/** Он же для чужих комнат Taler ID. */
const PROVIDER_TALERID = 'talerid';
/** Он же для встреч Google Meet через Attendee. */
const PROVIDER_MEET = 'meet';

/**
 * Zoom. Для нашего кода отличается от Meet ровно двумя вещами: адрес входа
 * приходит целиком (из кода его не собрать) и мост надо просить о веб-адаптере
 * (см. attendee.client.ts). Всё остальное — тот же путь через Attendee.
 */
const PROVIDER_ZOOM = 'zoom';

/**
 * Площадки, которые ходят через мост Attendee и потому делят один потолок.
 *
 * Потолок общий не по продуктовым причинам, а по физическим: порт под звук
 * один (AttendeeAudioHub), и вторая встреча — всё равно какой площадки — не
 * найдёт свободного.
 */
const BRIDGED_PROVIDERS = [PROVIDER_MEET, PROVIDER_ZOOM];

/**
 * Сколько встреч Meet держим одновременно.
 *
 * Единица — не техническое ограничение нашего кода, а следствие режима
 * Attendee: в Celery-режиме боты делят аудиоустройства и звук встреч
 * перетекает. Поднимать только вместе с изоляцией ботов по поду и
 * одновременно с диапазоном портов в voice-host.
 */
const MEET_CONCURRENCY_LIMIT = Number(process.env.MEET_CONCURRENCY_LIMIT || 1);

/**
 * Вход ассистента во встречу.
 *
 * Комната живёт отдельно (RoomService) и принадлежит людям. Здесь только
 * жизненный цикл присутствия ассистента в ней: позвали — вошёл, попросили —
 * вышел, все разошлись — вышел сам.
 */
@Injectable()
export class MeetingService {
  private readonly logger = new Logger(MeetingService.name);

  constructor(
    private readonly pg: PgService,
    private readonly calls: VoiceCallService,
    private readonly livekit: LiveKitClient,
    private readonly rooms: RoomService,
    private readonly talerIdRooms: TalerIdRoomClient,
    private readonly attendee: AttendeeClient,
  ) {}

  /**
   * Имя владельца — из профиля, а не из токена.
   *
   * Раньше контроллер брал его как `u.name || 'пользователя'`, а guard кладёт
   * в request.user только { userId, sub, isAdmin }: поля name там нет и не
   * было. То есть фолбэк срабатывал ВСЕГДА, и на каждой встрече ассистент
   * представлялся «ассистент пользователя». Выглядело как случайный сбой,
   * было единственно возможным поведением — поймано на встрече 28.08.2026.
   */
  /**
   * Пускать ли в разговор при текущем балансе.
   *
   * До 03.09.2026 проверки не было нигде — ни у звонка, ни у встречи: списание
   * идёт по факту, после разговора. Пока звонить могли одни админы, риск был
   * нулевой. С открытием встреч всем пользователь с пустым балансом может
   * провести час Realtime, и узнаем мы об этом постфактум.
   *
   * Порог — ноль, а не «хватит на час»: заранее длительность неизвестна, а
   * отказывать человеку с непустым балансом нельзя. Задача проверки — отсечь
   * заведомо неплатёжеспособный вход, а не гарантировать оплату.
   */
  private async assertCanAfford(userId: string): Promise<void> {
    let balance = 0;
    try {
      const r = await this.pg.query(
        `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      balance = Number(r.rows[0]?.tokens ?? 0);
    } catch (e: any) {
      // База недоступна — не повод не пускать: отказ по технической причине
      // хуже, чем неоплаченная минута.
      this.logger.warn(`баланс ${userId} не проверен: ${e?.message}`);
      return;
    }
    if (balance <= 0) {
      throw new ConflictException({
        message: 'not enough tokens',
        reason: 'insufficient_tokens',
        balance,
      });
    }
  }

  private async resolveOwnerName(userId: string): Promise<string> {
    try {
      const res = await this.pg.query(
        `SELECT NULLIF(TRIM(profile_data->>'name'), '') AS name
           FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      return res.rows[0]?.name || 'пользователя';
    } catch (e: any) {
      // Без имени встреча состоится, без ассистента — нет.
      this.logger.warn(`имя владельца встречи не получено (${userId}): ${e?.message}`);
      return 'пользователя';
    }
  }

  async join(
    userId: string,
    agentId: number,
    code: string,
    provider: MeetingProvider = 'linkeon',
    /**
     * Полный адрес входа. Обязателен для Zoom и не нужен остальным: у них он
     * выводится из кода. Приходит уже нормализованным из meeting-link.ts.
     */
    url?: string,
  ): Promise<{ callId: string; title: string }> {
    const agentRes = await this.pg.query(
      `SELECT id, display_name, system_prompt, realtime_voice FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    const agent = agentRes.rows[0];
    if (!agent) throw new NotFoundException('agent not found');

    // Один активный вход на пользователя. Минута Realtime стоит реальных
    // денег, а без проверки N вкладок дают N оплачиваемых сессий. Тот же
    // индекс voice_calls_active_idx, что у звонка.
    const active = await this.pg.query(
      `SELECT id FROM voice_calls WHERE user_id = $1 AND status IN ('dialing','active') LIMIT 1`,
      [userId],
    );
    if (active.rows[0]) {
      throw new ConflictException({ message: 'call already in progress', callId: active.rows[0].id });
    }

    await this.assertCanAfford(userId);

    const isForeign = provider === 'talerid';
    const isMeet = provider === 'meet';
    const isZoom = provider === 'zoom';
    /** Площадка без LiveKit: звук ходит через мост Attendee. */
    const isBridged = isMeet || isZoom;
    const callId = randomUUID();

    // Куда идёт ассистент и как называется комната — единственное, чем
    // отличаются свои встречи от чужих. Всё остальное ниже общее.
    let title: string;
    let roomName: string;
    let external: { url: string; token: string } | undefined;

    if (isBridged && !attendeeConfigured()) {
      // Не настроен — входить некуда. Отказ ДО создания записи звонка:
      // иначе строка осталась бы в dialing и заперла пользователю его же
      // следующий вход до реапера.
      throw new ConflictException({ message: 'meeting bot is not configured', reason: 'meet_unavailable' });
    }

    if (isZoom && !url) {
      // Без адреса входить некуда: из числового id ссылку не собрать — нужен
      // хост аккаунта и хеш пароля. Отказ ДО создания записи, по той же
      // причине, что и отказ ненастроенного моста выше.
      throw new ConflictException({ message: 'zoom join url is required', reason: 'zoom_url_required' });
    }

    if (isBridged) {
      // Потолок одновременных встреч через мост — глобальный, а не на
      // пользователя, и ОБЩИЙ для Meet и Zoom.
      //
      // В Celery-режиме Attendee боты в одном контейнере делят аудиоустройства,
      // и звук разных встреч может перетекать. Это утечка между переговорами
      // разных клиентов, поэтому потолок держится здесь, а не надеждой на то,
      // что воркер не найдёт свободного порта: там отказ придёт через
      // несколько секунд и без внятной причины.
      //
      // Отдельная константа, а не жёсткая единица: снимается вместе с
      // переходом на изоляцию по поду, и тогда меняется в одном месте.
      const busy = await this.pg.query(
        `SELECT count(*)::int AS n FROM voice_calls
          WHERE provider = ANY($1) AND status IN ('dialing','active')`,
        [BRIDGED_PROVIDERS],
      );
      if ((busy.rows[0]?.n ?? 0) >= MEET_CONCURRENCY_LIMIT) {
        // Причина остаётся `meet_busy` при занятости любой из площадок: этот
        // ключ уже переведён во всех локалях фронта, а человеку важно не имя
        // площадки, занявшей мост, а то, что мост занят.
        throw new ConflictException({ message: 'meeting bridge capacity reached', reason: 'meet_busy' });
      }

      // За информацией о встрече идти некуда: публичной ручки «существует ли
      // такая встреча» у Meet нет. Значит и карточку мы показываем, не
      // проверив вход, и о неудаче узнаём из состояния бота уже после захода.
      // Название берём нейтральное — настоящего у нас нет.
      // Название нейтральное и по площадке: настоящего у нас нет ни там, ни
      // там — публичной ручки «что за встреча» нет ни у Meet, ни у Zoom.
      title = isZoom ? 'Встреча Zoom' : 'Встреча Google Meet';
      // По callId, а не по коду: одну встречу могут позвать дважды, а
      // room_name с уникальностью уже намучил (003_drop_room_name_unique).
      roomName = `${isZoom ? PROVIDER_ZOOM : PROVIDER_MEET}_${callId}`;
    } else if (isForeign) {
      const info = await this.talerIdRooms.info(code);
      if (!info || !info.isActive) throw new NotFoundException('room not found');
      // Пароль в v1 не поддержан. Отказ внятный: молчаливое падение в 500
      // выглядит как поломка, а это ожидаемое ограничение.
      if (info.requiresPassword) {
        throw new ConflictException({ message: 'password-protected room is not supported yet' });
      }
      title = info.title || info.creatorName || 'Встреча';
      // Наша комната пустая и нужна ровно ради job: жизненный цикл, учёт и
      // reaper завязаны на voice_calls и на disconnect из НАШЕЙ комнаты.
      // Разговор при этом идёт целиком в комнате Taler ID.
      roomName = `talerid_${code}`;
    } else {
      const room = await this.rooms.info(code);
      if (!room || !room.active) throw new NotFoundException('room not found');
      title = room.title;
      // Комната ВСТРЕЧИ, а не новая: ассистент идёт туда, где уже сидят люди.
      roomName = `room_${room.code}`;
    }

    await this.pg.query(
      `INSERT INTO voice_calls (id, user_id, agent_id, room_name, status, provider, external_room, external_url)
       VALUES ($1, $2, $3, $4, 'dialing', $5, $6, $7)`,
      [callId, userId, agentId, roomName,
       isZoom ? PROVIDER_ZOOM : isMeet ? PROVIDER_MEET : isForeign ? PROVIDER_TALERID : PROVIDER,
       code,
       // Адрес храним отдельной колонкой, а не поверх external_room: там у
       // всех остальных провайдеров лежит короткий код, и колонка с двумя
       // смыслами однажды была бы прочитана не тем способом.
       isZoom ? url : null],
    );

    try {
      const preamble = await this.calls.buildPreamble(userId, agentId);
      const ownerName = await this.resolveOwnerName(userId);

      // Бота Attendee здесь больше НЕ создаём. Порт под звук свой у каждого
      // задания (AttendeeAudioHub), и знает его только воркер — раньше он
      // читался бэкендом из общего env, что было несовместимо с процесс-
      // моделью @livekit/agents@1.7.0 (см. attendee-audio.ts). Бота теперь
      // создаёт attachBot() — уже после dispatchAgent, когда воркер поднял
      // приём звука и сообщил бэкенду свой wsUrl отдельной ручкой.

      if (isForeign) {
        // Токен берём здесь, а не выше: он живёт шесть часов, и отсчёт лучше
        // начинать как можно позже. Имя — то же, что мы показываем в своих
        // комнатах, чтобы участники Taler ID видели, кто к ним пришёл.
        const t = await this.talerIdRooms.join(code, `${agent.display_name} · ассистент ${ownerName}`);
        if (!t) throw new NotFoundException('room not found');
        external = { url: t.url, token: t.token };
      }

      // Наша комната при внешней встрече пуста, и LiveKit удалил бы её через
      // пять минут по дефолтному empty_timeout — ассистента выбрасывало
      // ровно на 301-й секунде. Заводим заранее с запасом на всю встречу.
      if (isForeign || isBridged) await this.livekit.ensureRoom(roomName, 2 * 60 * 60);

      await this.livekit.dispatchAgent(roomName, {
        callId,
        userId,
        preamble,
        mode: 'meeting',
        agentName: agent.display_name,
        agentPersona: agent.system_prompt || '',
        agentVoice: agent.realtime_voice || undefined,
        ownerName,
        // Внешняя комната: воркер повесит на неё вход и выход сессии.
        // Для своих встреч поля нет вовсе — поведение воркера не меняется.
        ...(external ? { provider: PROVIDER_TALERID, externalUrl: external.url, externalToken: external.token } : {}),
        // Воркеру важна не площадка, а то, что звук идёт через мост, — но
        // провайдера передаём настоящий: он попадает в логи задания, и
        // «meet» на встрече Zoom сбивал бы с толку при разборе.
        ...(isBridged ? { provider: isZoom ? PROVIDER_ZOOM : PROVIDER_MEET } : {}),
        // Все специалисты, кроме самого ведущего: спрашивать себя незачем, а
        // предложение это сделать модель однажды примет всерьёз.
        specialists: Object.keys(SPECIALISTS)
          .filter((n) => SPECIALISTS[n] !== agentId)
          .map((n) => ({ name: n, role: SPECIALIST_ROLES[n] || '' })),
        callbackUrl: `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/voice-call/internal`,
      });
    } catch (e: any) {
      // Бота Attendee убирать здесь не нужно: в момент отказа его ещё не
      // существует — join() дальше dispatchAgent его не создаёт (см. выше).
      // Запись, оставшаяся в 'dialing', намертво блокирует пользователю
      // следующую попытку — лимит «один активный вход» смотрит именно на неё.
      this.logger.error(`[join] call=${callId} не поднялся: ${e?.message}`);
      await this.pg.query(
        `UPDATE voice_calls SET status = 'failed', ended_at = now(), summary = $1 WHERE id = $2`,
        [`Вход во встречу не состоялся: ${e?.message}`, callId],
      );
      throw e;
    }

    this.logger.log(`[join] call=${callId} agent=${agentId} provider=${provider} room=${code}`);
    return { callId, title };
  }

  /**
   * Воркер узнал порт своего вебсокета — создаём бота Attendee.
   *
   * Порт у каждого задания свой (AttendeeAudioHub), и до этого момента его не
   * знает никто, кроме самого воркера. Поэтому вход во встречу (`join`)
   * бота больше не создаёт: он появляется здесь, уже ПОСЛЕ dispatchAgent,
   * когда воркер поднял приём звука и сообщил бэкенду свой wsUrl отдельной
   * подписанной ручкой. Ответ синхронный: воркеру нужно знать, есть ли смысл
   * ждать подключения Attendee, а не тарифицировать Realtime в пустоту.
   */
  async attachBot(callId: string, wsUrl: string): Promise<{ status: 'ok' | 'failed' }> {
    let call: any;
    try {
      call = await this.calls.load(callId);
    } catch (e: any) {
      this.logger.error(`[attachBot] call=${callId} не найден: ${e?.message}`);
      return { status: 'failed' };
    }
    // Id бота держим в переменной шире try: если упадёт запись в базу, бот в
    // встрече уже будет, а в базе его не будет — и реапер, ищущий по
    // непустому external_bot_id, такого не найдёт никогда.
    //
    // Это НЕ гипотеза: ровно так и случилось на стенде 09.09.2026, когда
    // миграция с колонкой ещё не была накатана. Бот создался, UPDATE упал,
    // бот остался сиротой в чужом сервисе. Та же ловушка была в join(), там
    // она закрыта раньше — а здесь метод отдельный, и защиты не было.
    let botId: string | null = null;
    try {
      const ownerName = await this.resolveOwnerName(call.user_id);
      const agentRes = await this.pg.query(
        `SELECT display_name FROM agents WHERE id = $1 LIMIT 1`,
        [call.agent_id],
      );
      // Тем же способом, что раньше в join(): участники должны видеть, кто к
      // ним пришёл и от кого.
      const botName = `${agentRes.rows[0]?.display_name || 'Ассистент'} · ассистент ${ownerName}`;
      // Адрес входа: у Zoom он лежит в базе целиком, у Meet собирается из
      // кода. `external_url` — единственный признак, по которому здесь
      // отличается площадка, и он же страхует от рассинхрона с provider.
      const meetingUrl = call.external_url
        ? String(call.external_url)
        : `https://meet.google.com/${call.external_room}`;
      const bot = await this.attendee.createBot({
        meetingUrl,
        botName,
        callId,
        wsUrl,
        provider: call.provider === PROVIDER_ZOOM ? 'zoom' : 'meet',
      });
      if (!bot) {
        // Причина уже в логе клиента. Звонок помечаем failed сами: join()
        // об этом отказе узнать не может — он давно вернул ответ.
        this.logger.error(`[attachBot] call=${callId} бот Attendee не создан`);
        await this.calls.fail(callId, 'meeting bot is unavailable');
        return { status: 'failed' };
      }
      botId = bot.botId;
      await this.pg.query(`UPDATE voice_calls SET external_bot_id = $1 WHERE id = $2`, [botId, callId]);
      return { status: 'ok' };
    } catch (e: any) {
      this.logger.error(`[attachBot] call=${callId} упал: ${e?.message}`);
      // Бот мог уже сидеть в встрече — убираем его по значению из памяти, а
      // не по тому, что успело уехать в базу: упасть мог именно UPDATE.
      if (botId) {
        this.logger.warn(`[attachBot] убираю осиротевшего бота ${botId}`);
        await this.attendee.removeBot(botId).catch(() => {});
      }
      await this.calls.fail(callId, e?.message || 'attach bot failed').catch(() => {});
      return { status: 'failed' };
    }
  }

  /**
   * Во встрече появился первый живой участник.
   *
   * COALESCE обязателен: участники входят и выходят, и повторный вызов не
   * должен сдвигать момент начала — на него опирается ожидание в воркере.
   */
  async noteFirstHuman(callId: string): Promise<void> {
    await this.pg.query(
      `UPDATE voice_calls
          SET status = 'active', first_human_at = COALESCE(first_human_at, now())
        WHERE id = $1 AND status = 'dialing'`,
      [callId],
    );
  }

  /**
   * Пользователь попросил ассистента выйти.
   *
   * Комнату НЕ закрываем: она не наша по смыслу — в ней люди, и они продолжают
   * встречу без ассистента. Этим встреча принципиально отличается от звонка,
   * где markInterrupted закрывает комнату вместе с разговором.
   *
   * Ассистент вышел — бот обязан выйти вместе с ним.
   *
   * Загрузка и уборка обёрнуты в catch: выход ассистента важнее уборки
   * бота. Если Attendee недоступен, звонок всё равно обязан закрыться —
   * иначе запись останется активной и запрёт пользователю следующий вход.
   * Забытого бота подберёт реапер.
   */
  async leave(callId: string): Promise<void> {
    try {
      const call = await this.calls.load(callId);
      if (call?.external_bot_id) await this.attendee.removeBot(call.external_bot_id);
    } catch (e: any) {
      // Причиной может быть и calls.load() (звонка нет вовсе), а не только
      // removeBot — сообщение про «бота» тогда сбивает с толку тем, что
      // звонок вообще не найден. Формулировка нейтральна к обеим причинам.
      this.logger.warn(`[leave] уборка бота для call=${callId} не состоялась: ${e?.message}`);
    }
    await this.calls.markInterruptedKeepingRoom(callId);
  }
}
