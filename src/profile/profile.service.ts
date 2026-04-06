import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class ProfileService {
  constructor(private readonly pg: PgService) {}

  async getProfile(userId: string) {
    const res = await this.pg.query(
      'SELECT * FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return [{
      profileJson: {
        id: row.id,
        user_id: row.user_id,
        preferred_agent: row.preferred_agent,
        tokens: row.tokens,
        email: row.email,
        isadmin: row.isadmin === true || row.isadmin === 'true',
        profile_data: row.profile_data || {},
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...(row.profile_data || {}),
      },
    }];
  }

  async updateProfile(userId: string, data: Record<string, any>) {
    const { family_name, values, desires, intents, beliefs, interests, skills, ...rest } = data;
    const patch: Record<string, any> = {};
    if (family_name !== undefined) patch.family_name = family_name;
    if (values !== undefined) patch.values = values;
    if (desires !== undefined) patch.desires = desires;
    if (intents !== undefined) patch.intents = intents;
    if (beliefs !== undefined) patch.beliefs = beliefs;
    if (interests !== undefined) patch.interests = interests;
    if (skills !== undefined) patch.skills = skills;
    Object.assign(patch, rest);

    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
           updated_at = now()
       WHERE user_id = $2`,
      [JSON.stringify(patch), userId],
    );
    return { success: true };
  }

  async deleteProfile(userId: string) {
    await this.pg.query('DELETE FROM custom_chat_history WHERE user_id = $1', [userId]);
    await this.pg.query('DELETE FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
    await this.pg.query('DELETE FROM user_id WHERE primary_phone = $1', [userId]);
    return { success: true };
  }

  async getUserProfile(userId: string) {
    const res = await this.pg.query(
      'SELECT * FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    return res.rows[0] || null;
  }

  async setEmail(userId: string, email: string) {
    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET email = $1, updated_at = now() WHERE user_id = $2',
      [email, userId],
    );
    return { success: true };
  }

  async getTokenBalance(userId: string): Promise<number> {
    const res = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    return res.rows[0]?.tokens ?? 0;
  }
}
