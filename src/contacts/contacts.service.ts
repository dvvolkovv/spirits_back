import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { safeErrorCode } from '../common/llm-error';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { canReceiveNewProposal, readProfileAccess, readProfileAccessBatch, type ProfileAccess } from '../privacy/profile-privacy';

const CONTACT_ENTITY_KEYS = [
  'values', 'beliefs', 'desires', 'intents', 'interests', 'skills',
  'valuesRich', 'beliefsRich', 'desiresRich', 'intentsRich', 'interestsRich', 'skillsRich',
] as const;

/**
 * Контакты и политика раскрытия phone:
 *   public     — phone видно всем залогиненным (поиск/compat возвращает, UserProfileModal показывает).
 *   matchOnly  — phone скрыт; чтобы получить — сделать contact-request и получить approve от target.
 *   private    — phone скрыт; contact-request автоматически отклоняется (профиль не принимает заявок).
 *
 * Дефолт для новых юзеров — matchOnly (privacy-first). Существующие без поля — тоже matchOnly при чтении.
 */
export type ContactVisibility = 'public' | 'matchOnly' | 'private';

/**
 * K6b — единый fail-closed порог contacts: аккаунт-владелец номера считается
 * живым, только когда у него state='active'. Нет строки user_id, state NULL,
 * 'blocked', 'deleted' — нет. Один фрагмент на все пути, где это решает:
 * одобрение заявки и чтение телефона после него (resolve), телефоны в
 * списках (listIncoming/listOutgoing), телефон/email/аватар публичного
 * профиля (getPublicProfile) и получатель новой заявки (createRequest).
 *
 * ownerExpr — SQL-выражение internal_id владельца из кода сервиса
 * ('$1', 'ap.user_id'), не пользовательский ввод. Колонки без алиаса
 * резолвятся во внутреннем FROM user_id.
 */
export const activeOwnerSql = (ownerExpr: string): string =>
  `EXISTS (SELECT 1 FROM user_id WHERE internal_id = ${ownerExpr} AND state = 'active')`;

export interface ContactRequest {
  id: number;
  requester_id: number;
  target_id: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
  resolved_at: string | null;
  // Заполняется только при approved (для target side); null — владелец номера
  // перестал быть активным между одобрением и чтением телефона (K6/K6b).
  requester_phone?: string | null;
}

@Injectable()
export class ContactsService {
  private readonly logger = new Logger(ContactsService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
  ) {}

  /** surrogate id (ai_profiles_consolidated.id) ↔ phone (user_id). */
  async phoneById(userId: number): Promise<string | null> {
    const r = await this.pg.query('SELECT user_id FROM ai_profiles_consolidated WHERE id = $1', [userId]);
    return r.rows[0]?.user_id ?? null;
  }

  async idByPhone(phone: string): Promise<number | null> {
    const r = await this.pg.query('SELECT id FROM ai_profiles_consolidated WHERE user_id = $1', [phone]);
    return r.rows[0]?.id ?? null;
  }

  /**
   * K6b: владелец номера активен (activeOwnerSql). Неактивному — ни телефона
   * в публичном профиле, ни новой заявки. Ошибка чтения — fail-closed
   * (считаем неактивным) с записью в журнал: только код ошибки
   * (safeErrorCode — SQLSTATE или имя класса), без номера и без текста
   * ошибки, который может цитировать параметры.
   */
  private async ownerActive(phone: string): Promise<boolean> {
    try {
      const r = await this.pg.query(`SELECT 1 WHERE ${activeOwnerSql('$1')}`, [phone]);
      return (r.rowCount ?? r.rows?.length ?? 0) > 0;
    } catch (error) {
      this.logger.warn(
        `contacts: owner state unreadable (${safeErrorCode(error)}), treated as inactive`,
      );
      return false;
    }
  }

  async contactVisibility(phone: string): Promise<ContactVisibility> {
    const r = await this.pg.query(
      `SELECT profile_data->>'contactVisible' AS v FROM ai_profiles_consolidated WHERE user_id = $1`,
      [phone],
    );
    const v = r.rows[0]?.v;
    return v === 'public' || v === 'private' ? v : 'matchOnly';
  }

  async setContactVisibility(phone: string, visibility: ContactVisibility): Promise<void> {
    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = jsonb_set(coalesce(profile_data, '{}'::jsonb), '{contactVisible}', to_jsonb($1::text), true),
           updated_at = now()
       WHERE user_id = $2`,
      [visibility, phone],
    );
  }

  /**
   * Публичная карточка профиля по surrogate id.
   * Phone возвращается только если:
   *   - target.contactVisible = 'public', или
   *   - между requester и target есть approved contact_request (в любую сторону).
   */
  async getPublicProfile(requesterPhone: string, targetId: number): Promise<any | null> {
    const targetPhone = await this.phoneById(targetId);
    if (!targetPhone) return null;
    const access = await readProfileAccess(this.pg, requesterPhone, targetPhone).catch(() => null);
    if (!access?.visible) return null;

    const visibility = await this.contactVisibility(targetPhone);
    const self = targetPhone === requesterPhone;
    let phoneDisclosed = visibility === 'public' || self || access.approvedContact || access.peer;
    const includeProfile = access.visible && (self || access.automaticProfiling);
    const entities = includeProfile && this.neo4j
      ? await this.neo4j.getProfileEntities(targetPhone).catch(() => null)
      : null;
    const meta = await this.pg.query(
      `SELECT email, profile_data FROM ai_profiles_consolidated WHERE id = $1`,
      [targetId],
    );

    // Финальные access и contactVisible образуют одну точку сериализации:
    // отзыв связи, блок, paused или public→private не остаются в старом ответе.
    const [finalAccess, finalVisibility, targetActive] = await Promise.all([
      readProfileAccess(this.pg, requesterPhone, targetPhone).catch(() => null),
      this.contactVisibility(targetPhone),
      self ? Promise.resolve(true) : this.ownerActive(targetPhone),
    ]);
    if (!finalAccess?.visible) return null;
    const stillIncludeProfile = finalAccess.visible && (self || finalAccess.automaticProfiling);
    // K6/K6b: телефон (и email/аватар) — только активного владельца: открытый
    // до удаления/блокировки контакт или переписка его не раскрывают.
    phoneDisclosed = targetActive
      && (finalVisibility === 'public' || self || finalAccess.approvedContact || finalAccess.peer);

    const profileData = meta.rows[0]?.profile_data || {};
    const serializedEntities: Record<string, any> = {};
    for (const key of CONTACT_ENTITY_KEYS) {
      serializedEntities[key] = stillIncludeProfile ? entities?.[key] ?? [] : [];
    }

    return {
      userId: targetId,
      name: stillIncludeProfile ? entities?.name || profileData.name : profileData.name,
      family_name: stillIncludeProfile ? entities?.family_name || profileData.family_name : profileData.family_name,
      avatar_url: phoneDisclosed ? profileData.avatar_url ?? null : null,
      email: phoneDisclosed ? meta.rows[0]?.email ?? null : null,
      phone: phoneDisclosed ? targetPhone : null,
      contactVisible: finalVisibility,
      phoneDisclosed,
      ...serializedEntities,
    };
  }

  /** Task 17B: удалённый аккаунт не создаёт новых заявок (прецедент — tg-config.service assertActiveAccount). */
  private async assertActiveAccount(phone: string): Promise<void> {
    const active = await this.pg.query(
      `SELECT 1 FROM user_id WHERE internal_id = $1 AND state = 'active'`,
      [phone],
    );
    if ((active.rowCount ?? active.rows?.length ?? 0) === 0) {
      throw new BadRequestException('account is not active');
    }
  }

  async createRequest(requesterPhone: string, targetId: number, message: string | null): Promise<ContactRequest> {
    await this.assertActiveAccount(requesterPhone);
    const requesterId = await this.idByPhone(requesterPhone);
    if (!requesterId) throw new Error('Requester profile not found');
    if (requesterId === targetId) throw new Error('Cannot request own contact');

    const targetPhone = await this.phoneById(targetId);
    if (!targetPhone || !(await canReceiveNewProposal(this.pg, targetPhone))) {
      throw new NotFoundException({ code: 'PROFILE_NOT_AVAILABLE' });
    }

    const visibility = await this.contactVisibility(targetPhone);
    if (visibility === 'private') throw new Error('Пользователь не принимает запросы на контакт');
    if (visibility === 'public') {
      // Phone открыт — запрос не нужен. Создаём сразу approved (для истории).
      const r = await this.pg.query(
        `INSERT INTO contact_requests(requester_id, target_id, message, status, resolved_at)
         VALUES ($1, $2, $3, 'approved', now())
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [requesterId, targetId, message],
      );
      return r.rows[0] || (await this.findExisting(requesterId, targetId));
    }

    // matchOnly — создаём pending. UNIQUE-индекс предотвратит дубли pending.
    const r = await this.pg.query(
      `INSERT INTO contact_requests(requester_id, target_id, message, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [requesterId, targetId, message],
    );
    return r.rows[0] || (await this.findExisting(requesterId, targetId));
  }

  private async findExisting(requesterId: number, targetId: number): Promise<ContactRequest> {
    const r = await this.pg.query(
      `SELECT * FROM contact_requests
       WHERE requester_id = $1 AND target_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [requesterId, targetId],
    );
    return r.rows[0];
  }

  async listIncoming(targetPhone: string): Promise<ContactRequest[]> {
    const targetId = await this.idByPhone(targetPhone);
    if (!targetId) return [];
    const r = await this.pg.query(
      `SELECT cr.*, ap.user_id AS requester_phone, ap.profile_data AS requester_profile_data,
              ${activeOwnerSql('ap.user_id')} AS requester_active
       FROM contact_requests cr
       JOIN ai_profiles_consolidated ap ON ap.id = cr.requester_id
       WHERE cr.target_id = $1
       ORDER BY CASE WHEN cr.status = 'pending' THEN 0 ELSE 1 END, cr.created_at DESC`,
      [targetId],
    );
    if (r.rows.length === 0) return [];
    const phones = [...new Set<string>(r.rows.map((row: any) => row.requester_phone).filter(Boolean))];
    const accessByPhone = await readProfileAccessBatch(this.pg, targetPhone, phones)
      .catch(() => new Map<string, ProfileAccess>());

    const rows = await Promise.all(r.rows.map(async (row: any) => {
      const access = accessByPhone.get(row.requester_phone);
      if (!access?.visible) return null;

      const out: any = { ...row };
      const profileData = out.requester_profile_data || {};
      delete out.requester_profile_data;
      // K6/K6b: телефон — только у approved и только активного контрагента
      // (activeOwnerSql): контакт, открытый до удаления/блокировки, номер
      // больше не выдаёт; нет строки user_id — тоже нет.
      const requesterActive = out.requester_active === true;
      delete out.requester_active;
      if (row.status !== 'approved' || !requesterActive) delete out.requester_phone;

      const includeProfile = access.visible && access.automaticProfiling;
      const entities = includeProfile && this.neo4j
        ? await this.neo4j.getProfileEntities(row.requester_phone).catch(() => null)
        : null;
      const name = includeProfile ? entities?.name : profileData.name;
      const familyName = includeProfile ? entities?.family_name : profileData.family_name;
      out.requester_name = name ? `${name}${familyName ? ' ' + familyName : ''}`.trim() : null;
      return out;
    }));
    return rows.filter(Boolean) as ContactRequest[];
  }

  async listOutgoing(requesterPhone: string): Promise<ContactRequest[]> {
    const requesterId = await this.idByPhone(requesterPhone);
    if (!requesterId) return [];
    const r = await this.pg.query(
      `SELECT cr.*, ap.user_id AS target_phone, ap.profile_data AS target_profile_data,
              ${activeOwnerSql('ap.user_id')} AS target_active
       FROM contact_requests cr
       JOIN ai_profiles_consolidated ap ON ap.id = cr.target_id
       WHERE cr.requester_id = $1
       ORDER BY cr.created_at DESC`,
      [requesterId],
    );
    if (r.rows.length === 0) return [];
    const phones = [...new Set<string>(r.rows.map((row: any) => row.target_phone).filter(Boolean))];
    const accessByPhone = await readProfileAccessBatch(this.pg, requesterPhone, phones)
      .catch(() => new Map<string, ProfileAccess>());

    const rows = await Promise.all(r.rows.map(async (row: any) => {
      const access = accessByPhone.get(row.target_phone);
      if (!access?.visible) return null;

      const out: any = { ...row };
      const profileData = out.target_profile_data || {};
      delete out.target_profile_data;
      // K6/K6b: см. listIncoming — номер неактивного контрагента не выдаётся.
      const targetActive = out.target_active === true;
      delete out.target_active;
      if (row.status !== 'approved' || !targetActive) delete out.target_phone;

      const includeProfile = access.visible && access.automaticProfiling;
      const entities = includeProfile && this.neo4j
        ? await this.neo4j.getProfileEntities(row.target_phone).catch(() => null)
        : null;
      const name = includeProfile ? entities?.name : profileData.name;
      const familyName = includeProfile ? entities?.family_name : profileData.family_name;
      out.target_name = name ? `${name}${familyName ? ' ' + familyName : ''}`.trim() : null;
      return out;
    }));
    return rows.filter(Boolean) as ContactRequest[];
  }

  async resolve(
    targetPhone: string,
    requestId: number,
    decision: 'approved' | 'rejected',
  ): Promise<ContactRequest | null> {
    const targetId = await this.idByPhone(targetPhone);
    if (!targetId) return null;
    // K6: одобрение раскрывает телефон отправителя, поэтому одобрить можно
    // только заявку АКТИВНОГО аккаунта. Гейт — в самом UPDATE (EXISTS по
    // user_id отправителя), без отдельной проверки до него: заявка
    // удалённого (contacts.stop ещё не прошёл или его не было) или
    // заблокированного не одобряется, и живой партнёр получает тот же null
    // (404 not_found_or_not_pending), что и на обработанную заявку.
    // Отклонение телефона не раскрывает и разрешено для любого отправителя.
    const r = await this.pg.query(
      `UPDATE contact_requests
       SET status = $1, resolved_at = now()
       WHERE id = $2 AND target_id = $3 AND status = 'pending'
         AND (NOT $4::boolean OR EXISTS (
           SELECT 1 FROM ai_profiles_consolidated ap
            WHERE ap.id = contact_requests.requester_id
              AND ${activeOwnerSql('ap.user_id')}))
       RETURNING *`,
      [decision, requestId, targetId, decision === 'approved'],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    // Если approved — вытаскиваем phone requester'а для возврата. Тот же
    // active-гейт: отправителя могли удалить между UPDATE и этим чтением —
    // тогда телефон не выдаётся (null), а не уходит живому партнёру.
    if (row.status === 'approved') {
      const rr = await this.pg.query(
        `SELECT ap.user_id FROM ai_profiles_consolidated ap
          WHERE ap.id = $1 AND ${activeOwnerSql('ap.user_id')}`,
        [row.requester_id],
      );
      row.requester_phone = rr.rows[0]?.user_id ?? null;
    }
    return row;
  }
}
