import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';

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

    const requesterId = await this.idByPhone(requesterPhone);
    const visibility = await this.contactVisibility(targetPhone);

    // Self — всегда раскрываем.
    let phoneDisclosed = visibility === 'public' || targetPhone === requesterPhone;
    if (!phoneDisclosed && requesterId !== null) {
      const appr = await this.pg.query(
        `SELECT 1 FROM contact_requests
         WHERE status = 'approved'
           AND ((requester_id = $1 AND target_id = $2) OR (requester_id = $2 AND target_id = $1))
         LIMIT 1`,
        [requesterId, targetId],
      );
      if (appr.rowCount > 0) phoneDisclosed = true;
    }
    // Раскрываем, если между юзерами уже есть peer-переписка — контакт фактически установлен.
    if (!phoneDisclosed) {
      try {
        const conv = await this.pg.query(
          `SELECT 1 FROM peer_conversations
           WHERE (user_a_id = $1 AND user_b_id = $2) OR (user_a_id = $2 AND user_b_id = $1)
           LIMIT 1`,
          [requesterPhone, targetPhone],
        );
        if (conv.rowCount > 0) phoneDisclosed = true;
      } catch { /* peer_conversations может отсутствовать в dev — игнорируем */ }
    }

    const entities = this.neo4j ? await this.neo4j.getProfileEntities(targetPhone).catch(() => null) : null;
    const meta = await this.pg.query(
      `SELECT email, profile_data FROM ai_profiles_consolidated WHERE id = $1`,
      [targetId],
    );

    return {
      userId: targetId,
      name: entities?.name,
      family_name: entities?.family_name,
      email: phoneDisclosed ? meta.rows[0]?.email ?? null : null,
      phone: phoneDisclosed ? targetPhone : null,
      contactVisible: visibility,
      phoneDisclosed,
      values:        entities?.values ?? [],
      beliefs:       entities?.beliefs ?? [],
      desires:       entities?.desires ?? [],
      intents:       entities?.intents ?? [],
      interests:     entities?.interests ?? [],
      skills:        entities?.skills ?? [],
      valuesRich:    entities?.valuesRich ?? [],
      beliefsRich:   entities?.beliefsRich ?? [],
      desiresRich:   entities?.desiresRich ?? [],
      intentsRich:   entities?.intentsRich ?? [],
      interestsRich: entities?.interestsRich ?? [],
      skillsRich:    entities?.skillsRich ?? [],
    };
  }

  async createRequest(requesterPhone: string, targetId: number, message: string | null): Promise<ContactRequest> {
    const requesterId = await this.idByPhone(requesterPhone);
    if (!requesterId) throw new Error('Requester profile not found');
    if (requesterId === targetId) throw new Error('Cannot request own contact');

    const targetPhone = await this.phoneById(targetId);
    if (!targetPhone) throw new Error('Target profile not found');

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
      `SELECT cr.*, ap.user_id AS requester_phone
       FROM contact_requests cr
       JOIN ai_profiles_consolidated ap ON ap.id = cr.requester_id
       WHERE cr.target_id = $1
       ORDER BY CASE WHEN cr.status = 'pending' THEN 0 ELSE 1 END, cr.created_at DESC`,
      [targetId],
    );
    // Phone requester'а раскрываем только для approved. В pending — только имя (имя в neo4j).
    const rows = await Promise.all(r.rows.map(async (row: any) => {
      const out: any = { ...row };
      if (row.status !== 'approved') delete out.requester_phone;
      // Добавим short-name для UX.
      const entities = this.neo4j
        ? await this.neo4j.getProfileEntities(row.requester_phone).catch(() => null)
        : null;
      out.requester_name = entities?.name
        ? `${entities.name}${entities.family_name ? ' ' + entities.family_name : ''}`.trim()
        : null;
      return out;
    }));
    return rows;
  }

  async listOutgoing(requesterPhone: string): Promise<ContactRequest[]> {
    const requesterId = await this.idByPhone(requesterPhone);
    if (!requesterId) return [];
    const r = await this.pg.query(
      `SELECT cr.*, ap.user_id AS target_phone
       FROM contact_requests cr
       JOIN ai_profiles_consolidated ap ON ap.id = cr.target_id
       WHERE cr.requester_id = $1
       ORDER BY cr.created_at DESC`,
      [requesterId],
    );
    const rows = await Promise.all(r.rows.map(async (row: any) => {
      const out: any = { ...row };
      if (row.status !== 'approved') delete out.target_phone;
      const entities = this.neo4j
        ? await this.neo4j.getProfileEntities(row.target_phone).catch(() => null)
        : null;
      out.target_name = entities?.name
        ? `${entities.name}${entities.family_name ? ' ' + entities.family_name : ''}`.trim()
        : null;
      return out;
    }));
    return rows;
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
