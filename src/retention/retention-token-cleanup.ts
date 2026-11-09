import { PgService } from '../common/services/pg.service';

export async function cleanupOrphanRetentionTokens(pg: PgService): Promise<void> {
  await pg.query(
    `DELETE FROM retention_email_unsubscribes r
      WHERE r.unsubscribed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM ai_profiles_consolidated p
           WHERE lower(btrim(p.email)) = r.email_normalized
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_id u
           WHERE lower(btrim(u.primary_email)) = r.email_normalized
        )
        AND NOT EXISTS (
          SELECT 1 FROM user_identities i
           WHERE lower(btrim(i.email)) = r.email_normalized
        )`,
  );
}
