import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TripService } from '../trip/trip.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import {
  BuiltContext, ConsumerProfile, FALLBACK_TZ, PROFILES, SectionName, SectionStat, TOTAL_BUDGET,
} from './context.types';

/**
 * Насколько свежим должен быть прошлый разговор, чтобы считаться продолжаемым.
 *
 * Полчаса: перезвон после обрыва случается в пределах минут, а за этим порогом
 * человек начинает новый разговор, и дословный хвост прошлого ему только мешал
 * бы. Что было раньше, ассистент по-прежнему видит — карточкой в переписке.
 */
const CONTINUATION_WINDOW_MS = 30 * 60 * 1000;

/**
 * Единственное место, где собирается контекст для облачных поверхностей.
 *
 * Все источники необязательные и каждый под своим catch: звонок начат
 * пользователем и стоит реальных денег, ронять его из-за недоступного Neo4j
 * или календаря нельзя. Нет источника — Роман просто знает меньше.
 *
 * Спека: cases/my.linkeon/spec-context-sovereignty.md, раздел 4.
 */
@Injectable()
export class ContextService {
  private readonly logger = new Logger(ContextService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly trip?: TripService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly businessProfile?: BusinessProfileService,
  ) {}

  async build(
    userId: string,
    profile: ConsumerProfile,
    opts: { clientTz?: string; device?: string; agentId?: number } = {},
  ): Promise<BuiltContext> {
    const specs = PROFILES[profile] || {};
    const names = (Object.keys(specs) as SectionName[])
      .sort((a, b) => specs[b]!.rank - specs[a]!.rank);

    // Пояс резолвится ОДИН раз на сборку и уходит во все секции сразу. Пока
    // каждая секция решала это сама, «Сейчас» шло по поясу клиента, а день —
    // по UTC, и один контекст нёс два разных времени.
    const tz = ContextService.safeTz(opts.clientTz);

    const rendered: { name: SectionName; text: string }[] = [];
    for (const name of names) {
      let text = '';
      try {
        // Потолок уходит В СЕКЦИЮ, а не применяется поверх неё. Слепой slice
        // режет текст с конца, и секции, у которых ценен именно конец
        // (переписка, хвост разговора), теряли самое свежее. Разбор
        // ниже, в sectionHistory.
        text = (await this.renderSection(name, userId, { ...opts, tz }, specs[name]!.budget)) || '';
      } catch (e: any) {
        this.logger.warn(`секция ${name} для ${userId} не собралась: ${e?.message}`);
        text = '';
      }
      const cap = specs[name]!.budget;
      if (text.length > cap) text = text.slice(0, cap) + '…';
      if (text.trim()) rendered.push({ name, text: text.trim() });
    }

    const stats: SectionStat[] = [];
    const kept: string[] = [];
    let left = TOTAL_BUDGET;
    for (const r of rendered) {
      if (r.text.length <= left) {
        left -= r.text.length;
        kept.push(r.text);
        stats.push({ name: r.name, chars: r.text.length, dropped: false });
      } else {
        stats.push({ name: r.name, chars: r.text.length, dropped: true });
      }
    }

    // ⚠️ Только имена и размеры. Содержимое контекста в логи не попадает НИКОГДА:
    // это личные данные человека, а логи читаются и хранятся иначе, чем профиль.
    this.logger.log(
      `[context] user=${userId} profile=${profile} ` +
        stats.map((s) => `${s.name}=${s.chars}${s.dropped ? '✂' : ''}`).join(' '),
    );

    return { text: kept.join('\n\n'), sections: stats };
  }

  /**
   * Свежее «сейчас и сегодня» — для запроса посреди разговора.
   *
   * Системный промпт Realtime ставится один раз на старте и дальше не
   * меняется, поэтому длинный звонок живёт с замороженным снимком: начатый
   * в 13:55 разговор через сорок минут всё ещё считает встречу в 14:00
   * предстоящей. Досылать это в контекст НЕЛЬЗЯ — `updateChatCtx` в SDK
   * замещает контекст целиком и может откатить живой разговор (живая встреча
   * 11.09.2026, разбор в voice-host/src/agent.ts:244). Поэтому модель берёт
   * свежее сама, инструментом, — тем же способом, которым уже зовёт коллег.
   */
  async scheduleText(userId: string, clientTz?: string): Promise<string> {
    const parts: string[] = [];
    const tz = ContextService.safeTz(clientTz);
    for (const name of ['now', 'today'] as SectionName[]) {
      try {
        const t = (await this.renderSection(name, userId, { tz })) || '';
        if (t.trim()) parts.push(t.trim());
      } catch (e: any) {
        this.logger.warn(`секция ${name} для ${userId} не собралась: ${e?.message}`);
      }
    }
    return parts.join('\n\n');
  }

  private renderSection(
    name: SectionName,
    userId: string,
    opts: { tz?: string; device?: string; agentId?: number },
    budget = TOTAL_BUDGET,
  ): Promise<string> {
    const tz = opts.tz || FALLBACK_TZ;
    switch (name) {
      case 'now':           return this.sectionNow(tz);
      case 'today':         return this.sectionToday(userId, tz);
      case 'identity':      return this.sectionIdentity(userId);
      case 'continuation':  return this.sectionContinuation(userId, budget);
      case 'cloud_profile': return this.sectionCloudProfile(userId);
      case 'business':      return this.sectionBusiness(userId);
      case 'balance':       return this.sectionBalance(userId);
      case 'history':       return this.sectionHistory(userId, opts.agentId, budget);
      case 'device':        return Promise.resolve(opts.device || '');
      default:              return Promise.resolve('');
    }
  }

  /**
   * Время ГЛАЗАМИ ПОЛЬЗОВАТЕЛЯ.
   *
   * У голоса этого блока не было вовсе, и модель считала «сегодня» от UTC
   * сервера. В текстовом чате такой блок есть с 11.08.2026 — там разница в пять
   * часов однажды разбиралась с пользовательницей вручную посреди разговора.
   */
  private async sectionNow(tz: string): Promise<string> {
    const local = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, dateStyle: 'full', timeStyle: 'short',
    }).format(new Date());
    return `--- Сейчас ---\nУ пользователя ${local} (пояс ${tz}).\n` +
      'Считай «сегодня», «завтра» и сроки от ЭТОГО времени, а не от своего системного.';
  }

  /**
   * День пользователя из того же источника, что рисует лаунчер.
   *
   * Отметка времени снимка нужна, чтобы при расхождении с экраном Роман мог
   * честно сказать, на какой момент у него данные, а не спорить с человеком,
   * который смотрит на свой телефон (спека §4.4).
   */
  private async sectionToday(userId: string, tz: string): Promise<string> {
    if (!this.trip) return '';
    const st = await this.trip.getState(userId);
    const lines: string[] = [];
    const now = new Date();

    for (const e of (st.events || []).slice(0, 8)) {
      const where = e.location ? ` (${e.location})` : '';
      lines.push(`${ContextService.whenText(String(e.at || ''), tz, now)} — ${e.title}${where}`);
    }

    const open = (st.tasks || []).filter((t) => t.status === 'pending');
    for (const t of open.slice(0, 8)) {
      lines.push(`дело: ${t.title}${t.overdue ? ' (просрочено)' : ''}`);
    }

    if (!lines.length) return '';

    const stamp = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, timeStyle: 'short' }).format(now);
    return `--- День пользователя (данные на ${stamp}, время местное) ---\n${lines.join('\n')}\n` +
      'Если человек говорит, что на экране иначе, — верь ему: у него свежее.';
  }

  /**
   * Пояс собеседника — один на всю сборку.
   *
   * Проверяется не формой строки, а попыткой отформатировать: `Atlantis/Nowhere`
   * форму проходит, а Intl на нём кидает. Раньше проверка была по форме, а
   * падение ловилось ниже и подменяло время молча — в промпт уходило местное
   * время Екатеринбурга под именем чужого пояса.
   */
  private static safeTz(clientTz?: string): string {
    if (!clientTz || !/^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(clientTz)) return FALLBACK_TZ;
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: clientTz }).format(new Date());
      return clientTz;
    } catch {
      return FALLBACK_TZ;
    }
  }

  /**
   * Когда событие — часами собеседника, и с днём, если это не сегодня.
   *
   * ⚠️ Отметка приходит из календаря в UTC (`toISOString()`), и до 30.10.2026
   * из неё просто вырезались знаки 11–16. Для 8:30 по Екатеринбургу это «03:30»
   * — ровно так Роман и сказал владельцу 29.10.2026: «завтра утром у тебя йога
   * в 3:30, дальше с 6 утра уже рабочие дела». На экране лаунчера то же
   * событие рисуется через Intl и показывает верное время: расходились не
   * данные, а только то, что видел ассистент.
   *
   * День обязателен: горизонт «твоего сегодня» — сегодня И ЗАВТРА целиком
   * (trip.service.ts), поэтому голое «08:30» в списке читается как сегодняшнее
   * даже тогда, когда событие завтрашнее.
   *
   * Отметка без пояса (ни Z, ни смещения) печатается как есть: сдвигать её
   * некуда — такую строку слой дня трактует как местную.
   */
  private static whenText(at: string, tz: string, now: Date): string {
    if (!/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(at)) return at.length >= 16 ? at.slice(11, 16) : at;
    const when = new Date(at);
    if (!Number.isFinite(when.getTime())) return at;

    const day = (d: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(d);
    const time = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(when);

    const on = day(when);
    if (on === day(now)) return time;
    if (on === day(new Date(now.getTime() + 86_400_000))) return `завтра ${time}`;
    const date = new Intl.DateTimeFormat('ru-RU', {
      timeZone: tz, day: '2-digit', month: '2-digit',
    }).format(when);
    return `${date} ${time}`;
  }

  private async sectionIdentity(userId: string): Promise<string> {
    const r = await this.pg.query(
      `SELECT profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    const name = r.rows?.[0]?.name;
    return name ? `--- Собеседник ---\nИмя: ${name}.` : '';
  }

  /**
   * Neo4j помечается явно: это НЕ полный профиль человека, а то, что он сам
   * рассказывал в облачных чатах. Полный живёт на его устройстве и сюда не
   * выгружается (спека §2.3).
   */
  private async sectionCloudProfile(userId: string): Promise<string> {
    if (!this.neo4j) return '';
    const text = (await this.neo4j.getProfileDescription(userId))?.trim();
    return text ? `--- Что ты знаешь по облачным чатам ---\n${text}` : '';
  }

  private async sectionBusiness(userId: string): Promise<string> {
    if (!this.businessProfile) return '';
    return (await this.businessProfile.renderForPrompt(userId, 'assistant'))?.trim() || '';
  }

  private async sectionBalance(userId: string): Promise<string> {
    const r = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const t = r.rows?.[0]?.tokens;
    return t == null ? '' : `--- Энергия ---\nОстаток: ${t}.`;
  }

  /**
   * «Ассистент», а не «Роман»: контекст уходит модели, которая сама и есть этот
   * ассистент, и чужое имя в её собственных репликах сбивает.
   *
   * ⚠️ Набираем ОТ СВЕЖИХ К СТАРЫМ, пока хватает потолка, и только потом
   * разворачиваем. Это не стилистика, а условие работоспособности.
   *
   * До 29.10.2026 двадцать сообщений выкладывались от старых к новым, и
   * получившийся текст обрезался потолком секции с конца. У владельца так
   * собиралось 7663 знака при потолке 1800: выживали первые четыре строки —
   * переписка 10–11 октября, — а всё новее отрезалось. 28.10 разговор
   * оборвался на 4-й минуте, человек перезвонил через 20 секунд; карточка
   * прерванного разговора была записана за 13 секунд до нового звонка и
   * оказалась двадцатой по счёту, то есть отрезанной. Ассистент честно
   * пересказал то, что ему дали, — октябрь десятого числа, — и попросил
   * рассказать всё заново.
   *
   * Так же набирал старый сборщик в voice-call.service.ts; при переезде на
   * общий ContextService это потерялось.
   */
  private async sectionHistory(userId: string, agentId = 12, budget = TOTAL_BUDGET): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [`${userId}_${agentId}`],
    );
    if (!res.rows?.length) return '';
    const head = '--- Из переписки ---\n';
    let left = budget - head.length;
    const lines: string[] = [];
    for (const r of res.rows) {
      const who = r.sender_type === 'human' ? 'Пользователь' : 'Ассистент';
      const text = String(r.content || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const line = `${who}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`;
      // +1 на перевод строки: считаем с запасом, чтобы потолок не превысить.
      if (line.length + 1 > left) break;
      left -= line.length + 1;
      lines.push(line);
    }
    return lines.length ? head + lines.reverse().join('\n') : '';
  }

  /**
   * Чем кончился разговор, который только что оборвался.
   *
   * Карточка звонка в переписке — ПЕРЕСКАЗ в третьем лице («Пользователь
   * сказал, что ему было тяжело») и лежит наравне с перепиской месячной
   * давности. Когда человек перезванивает через двадцать секунд, ему нужно не
   * это: нужен хвост разговора дословно и в самом верху контекста, иначе
   * продолжать приходится ему самому — пересказывая то, что он уже сказал.
   *
   * Сервер не отличает обрыв от прощания: воркер и в том, и в другом случае
   * сообщает `participant_disconnected`. Поэтому в заголовке не утверждается,
   * что связь порвалась, — сказано только, когда разговор кончился, а
   * оборвался он или закончился, видно по самому хвосту.
   *
   * Берётся последний ЗАВЕРШЁННЫЙ звонок: у текущего ended_at ещё пуст, и
   * условие в запросе не даёт подхватить самого себя. Прерванные звонки сюда
   * тоже попадают — реплики лежат в transcript, который воркер флашит по ходу
   * разговора, даже если резюме так и не собралось.
   */
  private async sectionContinuation(userId: string, budget = TOTAL_BUDGET): Promise<string> {
    const res = await this.pg.query(
      `SELECT ended_at, transcript FROM voice_calls
        WHERE user_id = $1 AND ended_at IS NOT NULL
        ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );
    const row = res.rows?.[0];
    const turns = Array.isArray(row?.transcript) ? row.transcript : [];
    if (!turns.length) return '';

    const endedMs = new Date(row.ended_at).getTime();
    if (!Number.isFinite(endedMs)) return '';
    // Отрицательный возраст — расхождение часов, а не будущее: считаем «только что».
    const ageMs = Math.max(0, Date.now() - endedMs);
    if (ageMs > CONTINUATION_WINDOW_MS) return '';

    const head =
      `--- Чем кончился прошлый разговор (${ContextService.agoText(ageMs)}) ---\n` +
      'Это конец ТОГО ЖЕ разговора, дословно, а не пересказ. Он мог оборваться на ' +
      'полуслове. Продолжай с этого места и не проси человека повторять сказанное.\n';

    let left = budget - head.length;
    const lines: string[] = [];
    // С конца: если не всё влезает, терять надо начало разговора, а не его хвост.
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i] || {};
      const who = t.role === 'user' ? 'Пользователь' : 'Ассистент';
      const text = String(t.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const line = `${who}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`;
      if (line.length + 1 > left) break;
      left -= line.length + 1;
      lines.push(line);
    }
    // Один заголовок без единой реплики модели ничего не даёт.
    return lines.length ? head + lines.reverse().join('\n') : '';
  }

  /** «минуту назад», «3 минуты назад», «11 минут назад» — согласование вручную. */
  private static agoText(ms: number): string {
    const min = Math.round(ms / 60_000);
    if (min < 1) return 'меньше минуты назад';
    if (min === 1) return 'минуту назад';
    const tail = min % 100 > 10 && min % 100 < 20 ? 0 : min % 10;
    const word = tail >= 2 && tail <= 4 ? 'минуты' : 'минут';
    return `${min} ${word} назад`;
  }
}
