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
    const pd = row.profile_data || {};

    // Get phone + signup_method from user_id table (phone users have primary_phone set)
    const userIdRow = await this.pg.query(
      'SELECT primary_phone, primary_email, signup_method FROM user_id WHERE internal_id = $1',
      [userId],
    );
    const uidRow = userIdRow.rows[0] || {};
    // phone: for phone-registered users, primary_phone is set; others have no phone
    const phone = uidRow.primary_phone || null;
    // identity email: fallback for email/oauth users where ai_profiles_consolidated.email is not set
    const identityEmail = row.email || uidRow.primary_email || null;

    // Entity-поля (values/beliefs/desires/intents/interests/skills) — источник
    // правды Neo4j (компакция работает только там). profile_data.values и т.п.
    // — устаревший снапшот, может содержать testовый мусор и удалённое; не
    // подмешиваем его. Не-entity поля (name, family_name, avatar_url,
    // contactVisible, smm_sdk_session_id, и пр.) остаются из profile_data.
    const neo = this.neo4j ? await this.neo4j.getProfileEntities(userId).catch(() => null) : null;
    const ENTITY_KEYS = new Set(['values', 'beliefs', 'desires', 'intents', 'interests', 'skills', 'valuesRich', 'beliefsRich', 'desiresRich', 'intentsRich', 'interestsRich', 'skillsRich']);
    const pdNonEntities: Record<string, any> = {};
    for (const [k, v] of Object.entries(pd)) {
      if (!ENTITY_KEYS.has(k)) pdNonEntities[k] = v;
    }

    return [{
      profileJson: {
        id: row.id,
        user_id: row.user_id,
        preferred_agent: row.preferred_agent,
        tokens: row.tokens,
        phone,
        email: identityEmail,
        signup_method: uidRow.signup_method || null,
        isadmin: row.isadmin === true || row.isadmin === 'true',
        profile_data: pd, // raw column для обратной совместимости со старым фронтом
        created_at: row.created_at,
        updated_at: row.updated_at,
        ...pdNonEntities,
        // Свежие entities из Neo4j (если есть). Имя/фамилия — из profile_data
        // (туда их пишет ProfileService.updateProfile + KYC), Neo4j редко
        // имеет name заполненным.
        name: pd.name || neo?.name,
        family_name: pd.family_name || neo?.family_name,
        values: neo?.values || [],
        beliefs: neo?.beliefs || [],
        desires: neo?.desires || [],
        intents: neo?.intents || [],
        interests: neo?.interests || [],
        skills: neo?.skills || [],
        valuesRich: neo?.valuesRich || [],
        beliefsRich: neo?.beliefsRich || [],
        desiresRich: neo?.desiresRich || [],
        intentsRich: neo?.intentsRich || [],
        interestsRich: neo?.interestsRich || [],
        skillsRich: neo?.skillsRich || [],
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
    // Preserve token balance: clear profile data but keep the row so tokens survive re-registration
    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{}', email = NULL, preferred_agent = NULL, isadmin = false, updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    // Soft-delete: mark user as deleted but keep user_id + user_identities rows so that
    // re-registration with the same phone/email/OAuth restores the old token balance.
    await this.pg.query(
      `UPDATE user_id SET state = 'deleted', update_date = now() WHERE internal_id = $1`,
      [userId],
    );
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
