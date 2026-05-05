import { Injectable, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';

@Injectable()
export class ProfileService {
  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j?: Neo4jService,
  ) {}

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
    // Entities (values, beliefs, etc.) are stored in Neo4j only — strip them here
    const { values, desires, intents, intentions, beliefs, interests, skills, ...rest } = data;
    const patch: Record<string, any> = { ...rest };

    if (Object.keys(patch).length > 0) {
      await this.pg.query(
        `UPDATE ai_profiles_consolidated
         SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
             updated_at = now()
         WHERE user_id = $2`,
        [JSON.stringify(patch), userId],
      );
    }
    return { success: true };
  }

  async deleteProfile(userId: string) {
    await this.pg.query('DELETE FROM custom_chat_history WHERE session_id LIKE $1', [`${userId}_%`]);
    await this.pg.query('DELETE FROM ai_profiles_consolidated WHERE user_id = $1', [userId]);
    await this.pg.query('DELETE FROM user_id WHERE primary_phone = $1 OR internal_id = $1', [userId]);
    return { success: true };
  }

  async getUserProfile(userId: string) {
    const res = await this.pg.query(
      'SELECT * FROM ai_profiles_consolidated WHERE user_id = $1',
      [userId],
    );
    const row = res.rows[0];
    if (!row) return null;

    // Merge Neo4j entities (values/beliefs/desires/intents/interests/skills)
    // with profile_data from Postgres. Neo4j is the richer source.
    const neo = this.neo4j ? await this.neo4j.getProfileEntities(userId).catch(() => null) : null;
    const pd = row.profile_data || {};
    const merged = {
      name: neo?.name || pd.name,
      family_name: neo?.family_name || pd.family_name,
      values: (neo?.values?.length ? neo.values : pd.values) || [],
      beliefs: (neo?.beliefs?.length ? neo.beliefs : pd.beliefs) || [],
      desires: (neo?.desires?.length ? neo.desires : pd.desires) || [],
      intents: (neo?.intents?.length ? neo.intents : pd.intents) || [],
      interests: (neo?.interests?.length ? neo.interests : pd.interests) || [],
      skills: (neo?.skills?.length ? neo.skills : pd.skills) || [],
    };

    return {
      user_id: row.user_id,
      profile_data: { ...pd, ...merged },
      ...merged,
    };
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
    return Number(res.rows[0]?.tokens ?? 0);
  }
}
