import { Injectable, NotFoundException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class ContactsService {
  constructor(private readonly pg: PgService) {}

  async getContacts(userId: string) {
    const res = await this.pg.query(
      `SELECT * FROM dozvon_contacts WHERE user_id = $1 ORDER BY name ASC`,
      [userId],
    );
    return res.rows;
  }

  async createContact(userId: string, body: { name: string; phone: string; notes?: string }) {
    const res = await this.pg.query(
      `INSERT INTO dozvon_contacts (user_id, name, phone, notes)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [userId, body.name, body.phone, body.notes || null],
    );
    return res.rows[0];
  }

  async updateContact(userId: string, id: number, body: { name?: string; phone?: string; notes?: string }) {
    const fields: string[] = [];
    const values: any[] = [];
    let idx = 1;
    if (body.name !== undefined) { fields.push(`name = $${idx++}`); values.push(body.name); }
    if (body.phone !== undefined) { fields.push(`phone = $${idx++}`); values.push(body.phone); }
    if (body.notes !== undefined) { fields.push(`notes = $${idx++}`); values.push(body.notes); }
    if (fields.length === 0) return this.getContact(userId, id);
    values.push(id, userId);
    const res = await this.pg.query(
      `UPDATE dozvon_contacts SET ${fields.join(', ')}
       WHERE id = $${idx++} AND user_id = $${idx} RETURNING *`,
      values,
    );
    if (!res.rows[0]) throw new NotFoundException('Contact not found');
    return res.rows[0];
  }

  async deleteContact(userId: string, id: number) {
    const res = await this.pg.query(
      `DELETE FROM dozvon_contacts WHERE id = $1 AND user_id = $2 RETURNING id`,
      [id, userId],
    );
    if (!res.rows[0]) throw new NotFoundException('Contact not found');
    return { deleted: true };
  }

  async getSettings(userId: string) {
    const res = await this.pg.query(
      `SELECT * FROM dozvon_settings WHERE user_id = $1`,
      [userId],
    );
    return res.rows[0] || {
      user_id: userId,
      voice_id: 'default',
      system_prompt: null,
      agent_name: 'Алина',
    };
  }

  async upsertSettings(userId: string, body: { voice_id?: string; system_prompt?: string; agent_name?: string }) {
    const res = await this.pg.query(
      `INSERT INTO dozvon_settings (user_id, voice_id, system_prompt, agent_name, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (user_id) DO UPDATE SET
         voice_id      = COALESCE($2, dozvon_settings.voice_id),
         system_prompt = COALESCE($3, dozvon_settings.system_prompt),
         agent_name    = COALESCE($4, dozvon_settings.agent_name),
         updated_at    = now()
       RETURNING *`,
      [userId, body.voice_id || null, body.system_prompt || null, body.agent_name || null],
    );
    return res.rows[0];
  }

  private async getContact(userId: string, id: number) {
    const res = await this.pg.query(
      `SELECT * FROM dozvon_contacts WHERE id = $1 AND user_id = $2`,
      [id, userId],
    );
    if (!res.rows[0]) throw new NotFoundException('Contact not found');
    return res.rows[0];
  }
}
