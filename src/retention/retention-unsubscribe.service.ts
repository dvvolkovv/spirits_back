import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PgService } from '../common/services/pg.service';
import { normalizeEmail } from './retention-recipient';

export interface RetentionUnsubscribeRecord {
  email: string;
  unsubscribedAt: Date | null;
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export function maskRetentionEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (local.length <= 2) return `${local[0] || '*'}***@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

@Injectable()
export class RetentionUnsubscribeService {
  constructor(private readonly pg: PgService) {}

  async ensureToken(rawEmail: string): Promise<string> {
    const email = normalizeEmail(rawEmail);
    if (!email) throw new Error('invalid_email');
    const token = randomBytes(32).toString('base64url');
    const inserted = await this.pg.query(
      `INSERT INTO retention_email_unsubscribes (email_normalized, token)
       VALUES ($1, $2)
       ON CONFLICT (email_normalized) DO NOTHING
       RETURNING token`,
      [email, token],
    );
    if (inserted.rows[0]) return inserted.rows[0].token;
    const existing = await this.pg.query(
      'SELECT token FROM retention_email_unsubscribes WHERE email_normalized=$1',
      [email],
    );
    if (!existing.rows[0]) throw new Error('unsubscribe_token_unavailable');
    return existing.rows[0].token;
  }

  async findByToken(token: string): Promise<RetentionUnsubscribeRecord | null> {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const r = await this.pg.query(
      `SELECT email_normalized AS email, unsubscribed_at
         FROM retention_email_unsubscribes WHERE token=$1`,
      [token],
    );
    if (!r.rows[0]) return null;
    return { email: r.rows[0].email, unsubscribedAt: r.rows[0].unsubscribed_at };
  }

  async unsubscribe(token: string): Promise<RetentionUnsubscribeRecord | null> {
    if (!TOKEN_RE.test(String(token || ''))) return null;
    const r = await this.pg.query(
      `UPDATE retention_email_unsubscribes
          SET unsubscribed_at=COALESCE(unsubscribed_at, now()), updated_at=now()
        WHERE token=$1
        RETURNING email_normalized AS email, unsubscribed_at`,
      [token],
    );
    if (!r.rows[0]) return null;
    return { email: r.rows[0].email, unsubscribedAt: r.rows[0].unsubscribed_at };
  }

  async isUnsubscribed(rawEmail: string): Promise<boolean> {
    const email = normalizeEmail(rawEmail);
    if (!email) return false;
    const r = await this.pg.query(
      `SELECT 1 FROM retention_email_unsubscribes
        WHERE email_normalized=$1 AND unsubscribed_at IS NOT NULL LIMIT 1`,
      [email],
    );
    return r.rows.length > 0;
  }
}
