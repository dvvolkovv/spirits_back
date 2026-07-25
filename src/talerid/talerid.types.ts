export type TalerIdConnectionStatus = 'connected' | 'ambiguous' | 'error';

export interface TalerIdConnection {
  userId: string;
  taleridUserId: string;
  scopes: string;
  status: TalerIdConnectionStatus;
  accessExpiresAt?: Date;
}

/** Task 2 — TalerIdOauthClient (partner-provision + refresh HTTP client). */
export interface ProvisionInput {
  phone: string;
  email?: string;
  firstName?: string;
  scopes: string[];
}

export interface ProvisionOk {
  ok: true;
  taleridUserId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}

export interface ProvisionFail {
  ok: false;
  kind: 'ambiguous' | 'error';
  status: number;
}

/** Discriminated union on `ok` — see contract §2 (200 vs 409 vs 401/403/400/429/5xx). */
export type ProvisionResult = ProvisionOk | ProvisionFail;

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  scope: string;
}
