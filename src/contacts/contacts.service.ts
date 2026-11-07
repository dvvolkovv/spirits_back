import { Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
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

export interface ContactRequest {
  id: number;
  requester_id: number;
  target_id: number;
  message: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
  resolved_at: string | null;
  requester_phone?: string;  // заполняется только при approved (для target side)
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
    const [finalAccess, finalVisibility] = await Promise.all([
      readProfileAccess(this.pg, requesterPhone, targetPhone).catch(() => null),
      this.contactVisibility(targetPhone),
    ]);
    if (!finalAccess?.visible) return null;
    const stillIncludeProfile = finalAccess.visible && (self || finalAccess.automaticProfiling);
    phoneDisclosed = finalVisibility === 'public' || self || finalAccess.approvedContact || finalAccess.peer;

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

  async createRequest(requesterPhone: string, targetId: number, message: string | null): Promise<ContactRequest> {
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
      `SELECT cr.*, ap.user_id AS requester_phone, ap.profile_data AS requester_profile_data
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
      if (row.status !== 'approved') delete out.requester_phone;

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
      `SELECT cr.*, ap.user_id AS target_phone, ap.profile_data AS target_profile_data
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
      if (row.status !== 'approved') delete out.target_phone;

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
    const r = await this.pg.query(
      `UPDATE contact_requests
       SET status = $1, resolved_at = now()
       WHERE id = $2 AND target_id = $3 AND status = 'pending'
       RETURNING *`,
      [decision, requestId, targetId],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    // Если approved — вытаскиваем phone requester'а для возврата.
    if (row.status === 'approved') {
      const rr = await this.pg.query(
        `SELECT user_id FROM ai_profiles_consolidated WHERE id = $1`,
        [row.requester_id],
      );
      row.requester_phone = rr.rows[0]?.user_id ?? null;
    }
    return row;
  }
}
