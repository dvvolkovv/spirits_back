import { Injectable } from '@nestjs/common';
import { ProvisionInput, ProvisionResult, RefreshResult } from './talerid.types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Minimal E.164 normalizer for the partner-provision contract (§Global Constraints,
 * §2 of the contract): Linkeon stores phones WITHOUT a leading `+`
 * (e.g. `79656445804`), TalerID requires E.164 WITH one (`+79656445804`).
 * Deliberately dumb — just prepends `+` when missing. No international
 * reformatting/validation; the number is already SMS-verified upstream.
 */
export function toE164(phone: string): string {
  return phone.startsWith('+') ? phone : `+${phone}`;
}

/**
 * HTTP client for TalerID's partner-provision + OAuth refresh endpoints
 * (see cases/taler/linkeon-partner-provision-contract.md — locked contract).
 *
 * Config is read from env at call time (not cached at construction/module-load),
 * matching the pattern used elsewhere in this repo (e.g. sms-health.service.ts):
 * a module-level `process.env` read would run before ConfigModule populates
 * .env and silently freeze to ''.
 *
 * The HTTP call itself goes through an injectable fetch-like function so tests
 * never touch the network — defaults to the global `fetch` (Node 18+ / this
 * repo's Node 24 runtime already has it, see src/calendar/caldav.ts for the
 * same convention).
 */
@Injectable()
export class TalerIdOauthClient {
  constructor(private readonly fetchFn: FetchLike = globalThis.fetch as FetchLike) {}

  private baseUrl(): string {
    return process.env.TALERID_BASE_URL || 'https://staging.id.taler.tirol';
  }

  private partnerSecret(): string {
    return process.env.TALERID_PARTNER_SECRET || '';
  }

  private clientId(): string {
    return process.env.TALERID_CLIENT_ID || 'linkeon-partner';
  }

  private clientSecret(): string {
    return process.env.TALERID_CLIENT_SECRET || '';
  }

  /**
   * POST {BASE}/partner/provision — create-or-find the TalerID account for this
   * (SMS-verified) phone and mint mcp-scoped access+refresh tokens.
   * 200 → ok:true; 409 → ambiguous last-10 match (do NOT retry, escalate);
   * anything else (400/401/403/429/5xx) or a network failure → ok:false/'error'.
   */
  async provision(input: ProvisionInput): Promise<ProvisionResult> {
    const body: Record<string, unknown> = {
      phone: toE164(input.phone),
      scopes: input.scopes,
    };
    if (input.email) body.email = input.email;
    if (input.firstName) body.firstName = input.firstName;

    let res: Response;
    try {
      res = await this.fetchFn(`${this.baseUrl()}/partner/provision`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-partner-secret': this.partnerSecret(),
        },
        body: JSON.stringify(body),
      });
    } catch {
      // Network error (DNS/timeout/refused) — treat like any other provisioning
      // failure: don't connect, don't throw, let the caller record status='error'.
      return { ok: false, kind: 'error', status: 0 };
    }

    if (res.status === 200) {
      const data = await res.json();
      return {
        ok: true,
        taleridUserId: data.talerid_user_id,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresIn: data.expires_in,
        scope: data.scope,
      };
    }

    if (res.status === 409) {
      return { ok: false, kind: 'ambiguous', status: 409 };
    }

    return { ok: false, kind: 'error', status: res.status };
  }

  /**
   * POST {BASE}/oauth/token, grant_type=refresh_token — standard node-oidc-provider
   * refresh exchange, Basic-auth'd as the verifiedPartner client. TalerID rotates
   * the refresh token on EVERY exchange (rotateRefreshToken=true) — the returned
   * refreshToken is a NEW value; the caller (TalerIdOauthService, Task 3) MUST
   * overwrite the stored refresh via TalerIdStoreService.updateRefresh on every
   * call, or reusing the stale one revokes the whole chain.
   *
   * `scopes` is the narrowed scope requested for this consumer (this slice: only
   * `mcp:calendar`) — must be a subset of the scope the refresh token was granted.
   *
   * Throws on a non-2xx response; the caller decides how to handle it.
   */
  async refresh(refreshToken: string, scopes: string[]): Promise<RefreshResult> {
    const basic = Buffer.from(`${this.clientId()}:${this.clientSecret()}`).toString('base64');
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    });

    const res = await this.fetchFn(`${this.baseUrl()}/oauth/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
      },
      body: params.toString(),
    });

    if (!res.ok) {
      throw new Error(`TalerID refresh failed: HTTP ${res.status}`);
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in,
      scope: data.scope,
    };
  }
}
