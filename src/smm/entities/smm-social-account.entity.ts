// src/smm/entities/smm-social-account.entity.ts
import { SmmPlatform } from './smm-publication.entity';

export type SmmSocialAccountStatus = 'active' | 'expired' | 'revoked';

export interface SmmEncryptedCredentials {
  v: 1;
  iv: string;
  tag: string;
  ct: string;
}

export interface SmmSocialAccount {
  id: string;
  userId: string | null;
  platform: SmmPlatform;
  displayName: string;
  credentials: SmmEncryptedCredentials;
  status: SmmSocialAccountStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function rowToSocialAccount(row: any): SmmSocialAccount {
  return {
    id: row.id,
    userId: row.user_id ?? null,
    platform: row.platform,
    displayName: row.display_name,
    credentials: row.credentials as SmmEncryptedCredentials,
    status: row.status,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
