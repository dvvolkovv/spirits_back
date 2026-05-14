// src/smm/social-accounts/credentials.crypto.ts
import * as crypto from 'crypto';
import { SmmEncryptedCredentials } from '../entities/smm-social-account.entity';

/**
 * AES-256-GCM encryption for social-account OAuth tokens.
 *
 * Stored shape in DB (jsonb column `credentials`):
 *   { v: 1, iv: <base64>, tag: <base64>, ct: <base64> }
 *
 * Secret loaded from env SMM_CREDS_SECRET — must be 64 hex chars (32 bytes).
 */

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits — recommended for GCM

export class TamperDetectedError extends Error {
  constructor() {
    super('Encrypted credentials failed authentication (tampered or corrupt)');
    this.name = 'TamperDetectedError';
  }
}

function loadKey(): Buffer {
  const hex = process.env.SMM_CREDS_SECRET;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('SMM_CREDS_SECRET must be set to 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

export function encryptCredentials(plain: Record<string, unknown>): SmmEncryptedCredentials {
  const key = loadKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const json = JSON.stringify(plain);
  const ciphertext = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ciphertext.toString('base64'),
  };
}

export function decryptCredentials(encrypted: SmmEncryptedCredentials): Record<string, unknown> {
  if (encrypted.v !== 1) {
    throw new Error(`Unsupported credentials version: ${encrypted.v}`);
  }
  const key = loadKey();
  const iv = Buffer.from(encrypted.iv, 'base64');
  const tag = Buffer.from(encrypted.tag, 'base64');
  const ct = Buffer.from(encrypted.ct, 'base64');

  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
  } catch (err) {
    // GCM throws on bad tag/tampered ciphertext
    throw new TamperDetectedError();
  }
}
