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

/**
 * Task 6 — account linking (OAuth-link). See contract §«Запрос №4» + spec
 * 2026-07-27-talerid-account-linking-design.md. attach-phone maps TalerID's
 * named 409s onto discrete kinds so the UI can explain each precisely.
 */
export interface AttachPhoneOk {
  ok: true;
  taleridUserId: string;
  merged?: { notes?: number; calendar?: number; mail?: string; duplicate_deleted?: boolean };
}
export interface AttachPhoneFail {
  ok: false;
  /** different_phone=409 account_has_different_phone; phone_taken=409 phone_belongs_to_another_account;
   *  has_messages=409 merge_has_messenger_data; invalid_login=401; error=anything else/network. */
  kind: 'different_phone' | 'phone_taken' | 'has_messages' | 'invalid_login' | 'error';
  status: number;
}
export type AttachPhoneResult = AttachPhoneOk | AttachPhoneFail;

/** Final outcome of the link flow surfaced to the frontend (via ?talerid_link=<status>). */
export type LinkStatus =
  | 'linked'          // success — phone attached, tokens now on the real account
  | 'different_phone' // target account already has a different verified phone
  | 'phone_taken'     // this phone is verified on another real account
  | 'has_messages'    // duplicate has messenger data — refused, needs manual handling
  | 'cancelled'       // user denied/aborted the TalerID login
  | 'expired'         // link state missing/expired (>10 min or reused)
  | 'error';          // code exchange / attach / provision failed
