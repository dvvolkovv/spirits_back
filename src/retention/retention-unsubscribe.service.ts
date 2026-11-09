import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { normalizeEmail } from './retention-recipient';
import { decryptRetentionEmail, encryptRetentionEmail } from './retention-token-cipher';

export interface RetentionUnsubscribeRecord {
  email: string;
  unsubscribedAt: Date | null;
}

export function maskRetentionEmail(email: string): string {
  const [local, domain] = email.split('@');
  const chars = Array.from(local);
  if (chars.length <= 2) return `${chars[0] || '*'}***@${domain}`;
  return `${chars[0]}***${chars[chars.length - 1]}@${domain}`;
}

@Injectable()
export class RetentionUnsubscribeService implements OnModuleInit {
  private readonly logger = new Logger(RetentionUnsubscribeService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    await this.applyMigration('001_retention_email_unsubscribes.sql');
  }

  private async applyMigration(filename: string) {
    const candidates = [
      path.join(__dirname, 'migrations', filename),
      path.join(__dirname, '..', '..', 'src', 'retention', 'migrations', filename),
    ];
    let found = false;
    for (const p of [...new Set(candidates)]) {
      if (!fs.existsSync(p)) continue;
      found = true;
      try {
        await this.pg.query(fs.readFileSync(p, 'utf8'));
        this.logger.log(`retention migration ${filename} applied from ${p}`);
        return;
      } catch (e: any) {
        this.logger.error(`retention migration ${filename} failed (${p}): ${e.message}`);
      }
    }
    if (found) {
      const message = `retention migration ${filename} was found but did not apply on any candidate path`;
      this.logger.error(message);
      throw new Error(message);
    }
    this.logger.warn(`retention migration ${filename} not found, skipping`);
  }

  async ensureToken(rawEmail: string): Promise<string> {
    return encryptRetentionEmail(rawEmail);
  }

  async findByToken(token: string): Promise<RetentionUnsubscribeRecord | null> {
    const email = decryptRetentionEmail(token);
    if (!email) return null;
    const r = await this.pg.query(
      `SELECT email_normalized AS email, unsubscribed_at
         FROM retention_email_unsubscribes WHERE email_normalized=$1`,
      [email],
    );
    if (!r.rows[0]) return { email, unsubscribedAt: null };
    return { email: r.rows[0].email, unsubscribedAt: r.rows[0].unsubscribed_at };
  }

  async unsubscribe(token: string): Promise<RetentionUnsubscribeRecord | null> {
    const email = decryptRetentionEmail(token);
    if (!email) return null;
    const r = await this.pg.query(
      `INSERT INTO retention_email_unsubscribes (email_normalized, token, unsubscribed_at)
       VALUES ($1, $2, now())
       ON CONFLICT (email_normalized) DO UPDATE
          SET token=EXCLUDED.token,
              unsubscribed_at=COALESCE(retention_email_unsubscribes.unsubscribed_at,now()),
              updated_at=now()
        RETURNING email_normalized AS email, unsubscribed_at`,
      [email, token],
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
