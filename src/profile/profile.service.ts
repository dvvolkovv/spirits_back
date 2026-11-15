import { Injectable, Logger, Optional, OnModuleInit } from '@nestjs/common';
import { AccountDeletionLifecycle } from '../account-deletion/account-deletion.lifecycle';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';
import { IdentityService } from '../identity/identity.service';
import { OAuthAppleService } from '../auth/oauth-apple.service';
import { sanitizeAssistantVoices, sanitizeProfilePatch } from './profile-patch';
import { buildOtherUserProfile } from './profile-public';
import { readProfileAccess } from '../privacy/profile-privacy';
import * as fs from 'fs';
import * as path from 'path';

// Чистка голосов живёт рядом с белым списком profile-update; реэкспорт —
// для тех, кто импортирует её отсюда.
export { sanitizeAssistantVoices };

@Injectable()
export class ProfileService implements OnModuleInit {
  private readonly logger = new Logger(ProfileService.name);

  // Task 18: lifecycle — ОБЯЗАТЕЛЬНАЯ зависимость (вторая позиция): явное
  // удаление без координатора недопустимо, а TS не позволяет добавить
  // обязательный параметр ПОСЛЕ @Optional-параметров. AccountDeletionModule
  // (@Global) экспортирует lifecycle, поэтому imports ProfileModule не меняется.
  constructor(
    private readonly pg: PgService,
    private readonly deletion: AccountDeletionLifecycle,
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
        // Сначала profile_data, потом вычисленные поля: иначе ключ из
        // profile_data перекрыл бы isadmin, tokens, email и прочее.
        ...pdNonEntities,
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
    // Только известные поля (profile-patch.ts). Раньше сюда вливался любой
    // ключ, и в ответе профиля им перекрывались isadmin, tokens, email.
    // Портрет (values и т.д.) пишет в Neo4j контроллер.
    const { patch, dropped } = sanitizeProfilePatch(data);
    if (dropped.length > 0) {
      this.logger.warn(`profile-update: отброшены поля ${dropped.join(', ')}`);
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
    // Task 18: вся работа — у lifecycle (account-deletion.lifecycle.ts):
    // begin (поколение + план в одной транзакции), синхронные immediate-стопы,
    // затем fenced core finalize с контролем статуса. У ProfileService по-прежнему
    // нет собственных SQL/network вызовов на этом пути.
    //
    // При неуспехе стопов или ядра lifecycle бросает
    // ServiceUnavailableException с фиксированным безопасным сообщением
    // (без deletionId/userId): контроллер с @Res() не успевает отправить
    // ответ, штатный exception-filter Nest возвращает 503 — ложного
    // {success:true} не возникает. Аккаунт остаётся в удалённом поколении,
    // повторный DELETE продолжает с незавершённых задач.
    //
    // Отзыв доступа Apple и очистка связок входа — задачи конвейера
    // (integration.apple.stop и др., см. integration-account-deletion.adapter).
    // Исходники загрузок чата (chat_uploads) удаляет конвейер: задача
    // chat-upload.purge (chat-uploads/chat-upload-account-deletion.adapter.ts)
    // исполняется после retention-окна; старый inline-вызов
    // chatUploads.deleteForUser здесь сознательно не сохранён — он миновал бы
    // fencing (реактивация/merge пропускали бы очистку).
    //
    // Rationale-комментарии про SQL ядра — в profile-account-deletion.adapter.ts,
    // про порядок stops→core и ветки begin — в account-deletion.lifecycle.ts.
    await this.deletion.deleteExplicit(userId);
    return { success: true };
  }

  async getUserProfile(requesterId: string, targetId: string) {
    const access = await readProfileAccess(this.pg, requesterId, targetId).catch(() => null);
    if (!access?.visible) return null;

    const res = await this.pg.query(
      'SELECT * FROM ai_profiles_consolidated WHERE user_id = $1',
      [targetId],
    );
    const row = res.rows[0];
    if (!row) return null;

    const includeProfile = access.visible && (requesterId === targetId || access.automaticProfiling);
    const neo = includeProfile && this.neo4j
      ? await this.neo4j.getProfileEntities(targetId).catch(() => null)
      : null;

    // Настройки могли измениться, пока читались PostgreSQL и Neo4j. Единый
    // финальный snapshot не даёт собрать ответ из разрывных состояний политики.
    const finalAccess = await readProfileAccess(this.pg, requesterId, targetId).catch(() => null);
    if (!finalAccess?.visible) return null;
    const stillIncludeProfile = finalAccess.visible
      && (requesterId === targetId || finalAccess.automaticProfiling);

    return buildOtherUserProfile(row, neo, stillIncludeProfile);
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
