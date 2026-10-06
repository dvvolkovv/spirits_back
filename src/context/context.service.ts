import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TripService } from '../trip/trip.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { BusinessProfileService } from '../business-profile/business-profile.service';
import {
  BuiltContext, ConsumerProfile, FALLBACK_TZ, PROFILES, SectionName, SectionStat, TOTAL_BUDGET,
} from './context.types';

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

    const rendered: { name: SectionName; text: string }[] = [];
    for (const name of names) {
      let text = '';
      try {
        text = (await this.renderSection(name, userId, opts)) || '';
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
    for (const name of ['now', 'today'] as SectionName[]) {
      try {
        const t = (await this.renderSection(name, userId, { clientTz })) || '';
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
    opts: { clientTz?: string; device?: string; agentId?: number },
  ): Promise<string> {
    switch (name) {
      case 'now':           return this.sectionNow(opts.clientTz);
      case 'today':         return this.sectionToday(userId);
      case 'identity':      return this.sectionIdentity(userId);
      case 'cloud_profile': return this.sectionCloudProfile(userId);
      case 'business':      return this.sectionBusiness(userId);
      case 'balance':       return this.sectionBalance(userId);
      case 'history':       return this.sectionHistory(userId, opts.agentId);
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
  private async sectionNow(clientTz?: string): Promise<string> {
    const tz = clientTz && /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/.test(clientTz) ? clientTz : FALLBACK_TZ;
    let local: string;
    try {
      local = new Intl.DateTimeFormat('ru-RU', {
        timeZone: tz, dateStyle: 'full', timeStyle: 'short',
      }).format(new Date());
    } catch {
      // Незнакомый Intl-пояс — не повод ронять сборку.
      local = new Intl.DateTimeFormat('ru-RU', {
        timeZone: FALLBACK_TZ, dateStyle: 'full', timeStyle: 'short',
      }).format(new Date());
    }
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
  private async sectionToday(userId: string): Promise<string> {
    if (!this.trip) return '';
    const st = await this.trip.getState(userId);
    const lines: string[] = [];

    for (const e of (st.events || []).slice(0, 8)) {
      const at = String(e.at || '');
      const time = at.length >= 16 ? at.slice(11, 16) : at;
      const where = e.location ? ` (${e.location})` : '';
      lines.push(`${time} — ${e.title}${where}`);
    }

    const open = (st.tasks || []).filter((t) => t.status === 'pending');
    for (const t of open.slice(0, 8)) {
      lines.push(`дело: ${t.title}${t.overdue ? ' (просрочено)' : ''}`);
    }

    if (!lines.length) return '';

    const stamp = new Intl.DateTimeFormat('ru-RU', {
      timeZone: FALLBACK_TZ, timeStyle: 'short',
    }).format(new Date());
    return `--- День пользователя (данные на ${stamp}) ---\n${lines.join('\n')}\n` +
      'Если человек говорит, что на экране иначе, — верь ему: у него свежее.';
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
   */
  private async sectionHistory(userId: string, agentId = 12): Promise<string> {
    const res = await this.pg.query(
      `SELECT sender_type, content FROM custom_chat_history
       WHERE session_id = $1 ORDER BY created_at DESC LIMIT 20`,
      [`${userId}_${agentId}`],
    );
    if (!res.rows?.length) return '';
    const lines: string[] = [];
    for (const r of res.rows) {
      const who = r.sender_type === 'human' ? 'Пользователь' : 'Ассистент';
      const text = String(r.content || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      lines.push(`${who}: ${text.length > 400 ? text.slice(0, 400) + '…' : text}`);
    }
    return lines.length ? `--- Из переписки ---\n${lines.reverse().join('\n')}` : '';
  }
}
