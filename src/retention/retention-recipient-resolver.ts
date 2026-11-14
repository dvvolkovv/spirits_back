import { Injectable } from '@nestjs/common';
import { LanguageService } from '../common/services/language.service';
import { PgService } from '../common/services/pg.service';
import { normalizeEmail, normalizePhone } from './retention-recipient';
import { normalizeRetentionName } from './retention-personalization';
import type { RetentionContact } from './retention.types';

@Injectable()
export class RetentionRecipientResolver {
  constructor(private readonly pg: PgService, private readonly language: LanguageService) {}

  async resolve(userIds: string[]): Promise<Map<string, RetentionContact>> {
    const ids = [...new Set(userIds.filter(Boolean))];
    const result = new Map<string, RetentionContact>();
    if (!ids.length) return result;

    // Task 17C: контакты резолвятся только для state='active' — удалённый
    // аккаунт не должен давать email/phone для рассылки ни из одного источника
    // (профиль, primary_email, идентичности). Fail-closed: legacy-строки без
    // state тоже отсекаются (см. FU-T11-2).
    const [profiles, accounts, identities] = await Promise.all([
      this.pg.query(
        "SELECT user_id, email, profile_data->>'name' AS name FROM ai_profiles_consolidated WHERE user_id=ANY($1::text[]) AND EXISTS (SELECT 1 FROM user_id u WHERE u.internal_id=ai_profiles_consolidated.user_id AND u.state='active')",
        [ids],
      ),
      this.pg.query("SELECT internal_id::text AS user_id, primary_email FROM user_id WHERE internal_id=ANY($1::text[]) AND state='active'", [ids]),
      this.pg.query(
        `SELECT user_id, provider, provider_sub, email, email_verified, last_used_at, created_at
           FROM user_identities
          WHERE user_id=ANY($1::text[])
            AND EXISTS (SELECT 1 FROM user_id u WHERE u.internal_id=user_identities.user_id AND u.state='active')
          ORDER BY user_id, email_verified DESC, last_used_at DESC NULLS LAST, created_at DESC`,
        [ids],
      ),
    ]);

    const profileById = new Map(profiles.rows.map((r: any) => [r.user_id, r]));
    const accountById = new Map(accounts.rows.map((r: any) => [r.user_id, r]));
    const identitiesById = new Map<string, any[]>();
    for (const row of identities.rows) {
      const list = identitiesById.get(row.user_id) || [];
      list.push(row);
      identitiesById.set(row.user_id, list);
    }

    const emailsById = new Map<string, string[]>();
    for (const id of ids) {
      const candidates = [
        profileById.get(id)?.email,
        accountById.get(id)?.primary_email,
        ...(identitiesById.get(id) || []).map((r) => r.email),
      ];
      const emails = [...new Set(candidates.map(normalizeEmail).filter((v): v is string => Boolean(v)))];
      emailsById.set(id, emails);
    }
    const allEmails = [...new Set([...emailsById.values()].flat())];
    const suppressed = new Set<string>();
    if (allEmails.length) {
      const rows = await this.pg.query(
        `SELECT email_normalized FROM retention_email_unsubscribes
          WHERE unsubscribed_at IS NOT NULL AND email_normalized=ANY($1::text[])`,
        [allEmails],
      );
      for (const row of rows.rows) suppressed.add(row.email_normalized);
    }

    await Promise.all(ids.map(async (id) => {
      const emails = emailsById.get(id) || [];
      const email = emails.find((value) => !suppressed.has(value)) || null;
      let phone = normalizePhone(id);
      if (!phone) {
        const phoneIdentities = (identitiesById.get(id) || [])
          .filter((row) => row.provider === 'phone')
          .sort((a, b) =>
            new Date(b.last_used_at || 0).getTime() - new Date(a.last_used_at || 0).getTime() ||
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
          );
        for (const row of phoneIdentities) {
          phone = normalizePhone(row.provider_sub);
          if (phone) break;
        }
      }
      result.set(id, {
        userId: id,
        email,
        phone: phone || null,
        language: await this.language.resolveUserLanguage(id),
        name: normalizeRetentionName(profileById.get(id)?.name),
        unsubscribed: emails.length > 0 && !email,
      });
    }));
    return result;
  }
}
