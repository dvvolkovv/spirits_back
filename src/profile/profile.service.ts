import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { IdentityService } from '../identity/identity.service';
import { OAuthAppleService } from '../auth/oauth-apple.service';
import { VOICE_CATALOG } from '../speech/voices';
import * as fs from 'fs';
import * as path from 'path';

/** Ассистентов в каталоге полтора десятка; 50 — запас, за которым уже мусор. */
const MAX_VOICE_OVERRIDES = 50;

/**
 * Пользовательский выбор голосов (`profile_data.assistant_voices`) приходит из
 * браузера, поэтому проверяем всё: ключ — имя ассистента (оно же
 * `preferred_agent`), значение — id голоса из каталога. Несуществующие id
 * выбрасываем, `null` трактуем как «сбросить на дефолт» (resolveVoice сам
 * подставит голос ассистента, когда переопределения нет).
 */
export function sanitizeAssistantVoices(raw: any): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const valid = new Set(VOICE_CATALOG.map((v) => v.id));
  const out: Record<string, string> = {};
  for (const [assistant, voice] of Object.entries(raw)) {
    if (Object.keys(out).length >= MAX_VOICE_OVERRIDES) break;
    if (typeof voice !== 'string') continue;
    if (!valid.has(voice)) continue;
    out[assistant] = voice;
  }
  return out;
}

@Injectable()
export class ProfileService implements OnModuleInit {
  private readonly logger = new Logger(ProfileService.name);

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j?: Neo4jService,
    @Optional() private readonly identity?: IdentityService,
    @Optional() private readonly apple?: OAuthAppleService,
  ) {}

  // Применяем миграции профиля при старте (как BacklogService) — глобального
  // раннера нет, каждый модуль накатывает свои .sql сам. Так pm2 restart на
  // деплое добавит колонку onboarded + бэкфилл до прогона smoke.
  async onModuleInit() {
    for (const file of ['001_onboarded_flag.sql']) {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'profile', 'migrations', file),
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            await this.pg.query(fs.readFileSync(p, 'utf8'));
            this.logger.log(`profile migration ${file} applied from ${p}`);
            break;
          }
        } catch (e: any) {
          this.logger.error(`profile migration ${file} failed (${p}): ${e.message}`);
        }
      }
    }
  }

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
        onboarded: row.onboarded === true,
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

    // Только если поле реально пришло: безусловная санитизация подставила бы
    // assistant_voices: {} в каждый апдейт профиля и стирала бы выбор голосов
    // при любом сохранении имени.
    if ('assistant_voices' in patch) {
      patch.assistant_voices = sanitizeAssistantVoices(patch.assistant_voices);
    }

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

  async completeOnboarding(userId: string) {
    await this.pg.query(
      `UPDATE ai_profiles_consolidated SET onboarded = true, updated_at = now() WHERE user_id = $1`,
      [userId],
    );
    return { onboarded: true };
  }

  async deleteProfile(userId: string) {
    // Отзыв доступа Apple — обязательное требование к приложениям с Sign in
    // with Apple: без него приложение навсегда остаётся в настройках Apple ID
    // пользователя, а повторный вход молча возвращает прежнюю связку, будто
    // аккаунт и не удаляли.
    //
    // Делается ДО удаления: после него identity-строки ещё нужны, чтобы найти
    // сохранённый refresh-токен. Неудача отзыва удаление не срывает —
    // человек попросил удалить аккаунт, и внешний сбой не повод ему отказать.
    await this.revokeAppleAccess(userId);

    await this.pg.query('DELETE FROM custom_chat_history WHERE session_id LIKE $1', [`${userId}_%`]);
    await this.pg.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{}', email = NULL, preferred_agent = NULL, isadmin = false,
           tokens = 0, updated_at = now()
       WHERE user_id = $1`,
      [userId],
    );
    await this.neo4j?.deleteUserGraph(userId);

    // Связки входа рвём — иначе «удаление» им не является.
    //
    // Раньше строки user_identities оставались жить, чтобы перерегистрация
    // тем же телефоном или почтой возвращала прежний баланс. Побочный эффект
    // оказался таким: удалённый аккаунт пускал обратно по СТАРОМУ паролю, а
    // связывание отдельной строкой поднимало ему state обратно в active. То
    // есть с точки зрения человека аккаунт не удалялся вовсе — что и увидели
    // при съёмке для Apple. Правило 5.1.1(v) считает это деактивацией, а не
    // удалением.
    //
    // Пароль и почту в user_id гасим там же: пароль иначе остался бы годным
    // для нового аккаунта с тем же адресом, а primary_email — единственная
    // оставшаяся копия адреса.
    await this.pg.query('DELETE FROM user_identities WHERE user_id = $1', [userId]);
    await this.pg.query(
      `UPDATE user_id
       SET state = 'deleted', password_hash = NULL, primary_email = NULL,
           welcome_bonus_at = NULL, update_date = now()
       WHERE internal_id = $1`,
      [userId],
    );
    // welcome_bonus_at сбрасываем намеренно: у пользователя с телефонным
    // входом internal_id — это сам номер, и перерегистрация неизбежно
    // попадёт в ту же строку. Без сброса он получил бы чистый аккаунт с
    // нулевым балансом и без стартового бонуса.
    //
    // Известный остаток: выданный РАНЬШЕ access-токен продолжает пускать до
    // своего истечения — по умолчанию два часа (JWT_ACCESS_EXPIRES). Связок
    // входа уже нет и продлить его нельзя (см. AuthService.isDeleted), но
    // сам он ещё годен. Проверено на тестовом стенде 15.08.2026.
    //
    // Не закрыто сознательно: проверка состояния в JwtGuard легла бы на
    // КАЖДЫЙ авторизованный запрос, и ошибка в ней кладёт весь API — размен
    // хуже самой дыры. Дыра при этом ведёт к уже пустому аккаунту: профиль
    // очищен, история удалена, баланс обнулён. Клиент после удаления сам
    // выходит и токен выбрасывает.
    return { success: true };
  }

  private async revokeAppleAccess(userId: string): Promise<void> {
    if (!this.identity || !this.apple) return;
    try {
      const tokens = await this.identity.providerRefreshTokens(userId, 'apple');
      for (const token of tokens) {
        await this.apple.revokeToken(token, this.apple.primaryClientId());
      }
    } catch (e: any) {
      this.logger?.warn?.(`отзыв доступа Apple при удалении ${userId} не удался: ${e.message}`);
    }
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
