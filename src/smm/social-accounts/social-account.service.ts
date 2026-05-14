// src/smm/social-accounts/social-account.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../../common/services/pg.service';
import { encryptCredentials } from './credentials.crypto';
import {
  SmmSocialAccount,
  rowToSocialAccount,
} from '../entities/smm-social-account.entity';
import { SmmPlatform } from '../entities/smm-publication.entity';

export interface CreateSocialAccountInput {
  userId: string | null;
  platform: SmmPlatform;
  displayName: string;
  credentialsPlain: Record<string, unknown>;
  expiresAt?: Date | null;
}

@Injectable()
export class SocialAccountService {
  private readonly logger = new Logger(SocialAccountService.name);

  constructor(private readonly pg: PgService) {}

  async create(input: CreateSocialAccountInput): Promise<SmmSocialAccount> {
    const enc = encryptCredentials(input.credentialsPlain);
    const res = await this.pg.query(
      `INSERT INTO smm_social_account
          (user_id, platform, display_name, credentials, expires_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       RETURNING *`,
      [input.userId, input.platform, input.displayName, JSON.stringify(enc), input.expiresAt ?? null],
    );
    return rowToSocialAccount(res.rows[0]);
  }

  async findById(id: string): Promise<SmmSocialAccount | null> {
    const res = await this.pg.query(
      `SELECT * FROM smm_social_account WHERE id = $1`, [id],
    );
    return res.rows[0] ? rowToSocialAccount(res.rows[0]) : null;
  }

  async listForUser(userId: string | null): Promise<SmmSocialAccount[]> {
    const res = userId
      ? await this.pg.query(
          `SELECT * FROM smm_social_account WHERE user_id = $1 ORDER BY created_at DESC`,
          [userId],
        )
      : await this.pg.query(
          `SELECT * FROM smm_social_account WHERE user_id IS NULL ORDER BY created_at DESC`,
        );
    return res.rows.map(rowToSocialAccount);
  }

  async deleteById(id: string): Promise<boolean> {
    const res = await this.pg.query(
      `DELETE FROM smm_social_account WHERE id = $1`, [id],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
