import { Injectable, Logger, Optional } from '@nestjs/common';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdOauthClient } from './talerid-oauth.client';
import { PgService } from '../common/services/pg.service';
import { TalerIdConnectionStatus, ProvisionResult, ProvisionFail } from './talerid.types';

/**
 * Explicit type-guard, not `if (result.ok)`/`else`: this repo's tsconfig has
 * strictNullChecks:false, under which TS does NOT narrow a discriminated
 * union on the negative (else) branch of a literal check (verified — plain
 * if/else leaves `result.kind` unresolvable in the else branch even though
 * `result.ok` is false there). A user-defined type guard narrows correctly
 * regardless of strictNullChecks.
 */
function isProvisionFail(result: ProvisionResult): result is ProvisionFail {
  return result.ok === false;
}

/** Fallback grant if a stored connection predates the scopes column being set. */
const CALENDAR_SCOPE = ['mcp:calendar'];

/**
 * The mcp: scopes Linkeon requests at connect time, from env `TALERID_SCOPES`
 * (space-separated), defaulting to calendar only.
 *
 * ⚠️ MUST be a SUBSET of the linkeon-partner client's allowedScopes IN THIS ENV:
 * TalerID's /partner/provision REJECTS (HTTP 400) a request containing any scope
 * the client doesn't allow — it does NOT silently intersect (verified live
 * 2026-07-26). So this is configured per-environment: PROD (calendar-only) leaves
 * it at the default; DEV/test (calendar+notes+messages) sets
 * `TALERID_SCOPES="mcp:calendar mcp:notes mcp:messages.read mcp:messages.send"`.
 * When TalerID widens a client's allowedScopes, widen this env var there too.
 *
 * One token, not two: the same access token serves the backend calendar
 * connector AND the agent-direct path. The agent is prevented from touching
 * calendar not by a narrower token (a second refresh would rotate the shared
 * refresh and revoke the chain) but by the file-agent's `--allowedTools`
 * allowlist. The token naturally carries only what THIS env granted, so on a
 * calendar-only env the agent simply sees no notes/messages tools.
 */
function requestedScopes(): string[] {
  const raw = (process.env.TALERID_SCOPES || 'mcp:calendar').trim();
  const parsed = raw.split(/\s+/).filter(Boolean);
  return parsed.length ? parsed : CALENDAR_SCOPE;
}

/** Skew buffer: treat a stored access token as expired this many ms before its
 * real expiry, so we never hand a caller a token that dies mid-flight. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Task 3 — glues TalerIdStoreService + TalerIdOauthClient into the token
 * service the rest of Linkeon (calendar connector, controller) talks to.
 *
 * getBackendAccessToken is the rotation-safe core: TalerID rotates the
 * refresh token on every oauth/token exchange (see TalerIdOauthClient.refresh
 * doc), so every refresh here MUST persist the new refresh token via
 * store.updateRefresh BEFORE returning the new access token — a crash right
 * after refresh must never leave us holding a stale/already-revoked refresh.
 */
@Injectable()
export class TalerIdOauthService {
  private readonly logger = new Logger(TalerIdOauthService.name);
  /** Per-user in-flight refresh (single-flight) — see getBackendAccessToken. */
  private readonly refreshInFlight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: TalerIdStoreService,
    private readonly client: TalerIdOauthClient,
    // @Optional so the many `new TalerIdOauthService(store, client)` constructions in
    // unit tests keep compiling; in the real DI graph (TalerIdModule imports CommonModule)
    // PgService is always injected — it's needed by the auto-reprovision self-heal to look
    // the user's phone up. Without pg, self-heal simply no-ops (degrades to null).
    @Optional() private readonly pg?: PgService,
  ) {}

  async connect(
    userId: string,
    phone: string,
    email?: string,
    firstName?: string,
  ): Promise<TalerIdConnectionStatus> {
    const { status } = await this.provisionAndSave(userId, phone, email, firstName);
    return status;
  }

  /**
   * Partner-provision (create-or-find by phone, partner-secret) + persist. Returns the status
   * AND, on success, the freshly minted access token — so the auto-reprovision self-heal can
   * hand it straight back without a store round-trip (the store may not reflect the write yet,
   * and in unit tests it never does). On failure records the status for the caller/UI.
   */
  private async provisionAndSave(
    userId: string,
    phone: string,
    email?: string,
    firstName?: string,
  ): Promise<{ status: TalerIdConnectionStatus; accessToken?: string }> {
    const result = await this.client.provision({ phone, email, firstName, scopes: requestedScopes() });

    if (isProvisionFail(result)) {
      // ambiguous (409, last-10 phone match) or error (401/403/5xx/network) —
      // never save tokens, just record the status for the caller/UI.
      await this.store.setStatus(userId, result.kind);
      return { status: result.kind };
    }

    await this.store.saveConnection(userId, {
      taleridUserId: result.taleridUserId,
      refreshToken: result.refreshToken,
      accessToken: result.accessToken,
      accessExpiresAt: new Date(Date.now() + result.expiresIn * 1000),
      // Store what TalerID ACTUALLY granted, not what we requested — pre-widening
      // this is 'mcp:calendar', post-widening the full set. Refresh reads it back.
      scopes: result.scope || CALENDAR_SCOPE.join(' '),
    });
    return { status: 'connected', accessToken: result.accessToken };
  }

  /**
   * Provision for a user we only have the internal id of: look their SMS-verified phone
   * (and best-effort email/name) up server-side, then partner-provision. Used by the
   * connect controller and by the auto-reprovision self-heal. 'error' when no phone on file.
   */
  async provisionForUser(userId: string): Promise<TalerIdConnectionStatus> {
    const { phone, email, firstName } = await this.lookupProvisionInput(userId);
    if (!phone) return 'error';
    const { status } = await this.provisionAndSave(userId, phone, email, firstName);
    return status;
  }

  /**
   * Best-effort identity lookup for provisioning: phone (required) + email/firstName
   * (optional, used only to disambiguate a last-10 phone match). Mirrors the join in
   * ProfileService — phone stored WITHOUT '+' (TalerIdOauthClient.toE164 normalizes).
   * Any failure (or no pg wired) → phone:null, so the caller reports 'error'/no-op.
   */
  async lookupProvisionInput(userId: string): Promise<{ phone: string | null; email?: string; firstName?: string }> {
    if (!this.pg) return { phone: null };
    try {
      const [uidRes, profileRes] = await Promise.all([
        this.pg.query(`SELECT primary_phone, primary_email FROM user_id WHERE internal_id=$1`, [userId]),
        this.pg.query(`SELECT email, profile_data FROM ai_profiles_consolidated WHERE user_id=$1`, [userId]),
      ]);
      const uidRow = uidRes.rows[0] || {};
      const profileRow = profileRes.rows[0] || {};
      const phone: string | null = uidRow.primary_phone || null;
      const email: string | undefined = profileRow.email || uidRow.primary_email || undefined;
      const firstName: string | undefined = profileRow.profile_data?.name || undefined;
      return { phone, email, firstName };
    } catch (e: any) {
      this.logger.warn(`talerid lookupProvisionInput failed for user ${userId}: ${e?.message}`);
      return { phone: null };
    }
  }

  /**
   * Returns a valid access token carrying this connection's full granted scope
   * (calendar, and — post TalerID widening — notes/messages/mail), or null if
   * not connected / connection isn't in 'connected' status / refresh fails.
   *
   * This is the SINGLE token both consumers use: the backend calendar connector
   * and the agent-direct path (the agent is scope-limited by the file-agent's
   * --allowedTools allowlist, not by a narrower token — see ALL_SCOPES doc).
   */
  async getBackendAccessToken(userId: string): Promise<string | null> {
    const connection = await this.store.getConnection(userId);
    if (!connection || connection.status !== 'connected') return null;

    const fresh = await this.freshStoredAccess(userId);
    if (fresh) return fresh;

    // Single-flight the refresh per user. TalerID rotates the refresh on every
    // exchange (rotateRefreshToken=true) and revokes the WHOLE grant chain if the
    // old, now-rotated refresh is presented twice — so concurrent callers (co-pilot
    // union + a card write, two surface loads, …) must share ONE refresh, not race
    // two of them. In-process map is correct for our single PM2 instance; a
    // multi-replica deploy would need a DB compare-and-swap instead.
    const inFlight = this.refreshInFlight.get(userId);
    if (inFlight) return inFlight;

    const p = this.doRefresh(userId).finally(() => this.refreshInFlight.delete(userId));
    this.refreshInFlight.set(userId, p);
    return p;
  }

  /** Stored access token if still valid (minus skew), else null. */
  private async freshStoredAccess(userId: string): Promise<string | null> {
    const stored = await this.store.getAccess(userId);
    if (stored?.accessToken && stored.expiresAt && stored.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
      return stored.accessToken;
    }
    return null;
  }

  private async doRefresh(userId: string): Promise<string | null> {
    // Re-check inside the single-flight: another flight may have just refreshed
    // while we waited for the slot — never present an already-rotated refresh.
    const fresh = await this.freshStoredAccess(userId);
    if (fresh) return fresh;

    const refreshToken = await this.store.getRefresh(userId);
    if (!refreshToken) return null;

    // Refresh with the scope TalerID GRANTED this connection (stored at connect
    // / previous refresh), never a hardcoded set — asking for more than the
    // grant would fail, asking for a fixed subset would silently drop the
    // notes/messages/mail scopes the agent needs. Fallback to calendar for
    // connections saved before the scopes column carried the full grant.
    const connection = await this.store.getConnection(userId);
    const grantedScope = connection?.scopes
      ? connection.scopes.split(/\s+/).filter(Boolean)
      : CALENDAR_SCOPE;

    let refreshed;
    try {
      refreshed = await this.client.refresh(refreshToken, grantedScope);
    } catch (e: any) {
      // The refresh chain is dead (TalerID refresh tokens expire/rotate/revoke — a stale one
      // 400s forever). Left here it stays silently connected-but-empty: every calendar/notes
      // surface degrades to [] with no recovery. Self-heal: re-mint the connection via
      // partner-secret (no user interaction — we hold the SMS-verified phone), then return the
      // fresh access. This is the durable fix for "TalerID items silently vanish".
      this.logger.warn(`talerid refresh failed for user ${userId}: ${e?.message} — attempting auto-reprovision`);
      return this.autoReprovision(userId);
    }

    // Persist the rotated refresh + new access BEFORE returning — never lose
    // the new refresh to a crash between the HTTP call and the DB write.
    await this.store.updateRefresh(userId, refreshed.refreshToken);
    await this.store.updateAccess(userId, refreshed.accessToken, new Date(Date.now() + refreshed.expiresIn * 1000));

    return refreshed.accessToken;
  }

  /**
   * Self-heal a dead refresh chain: look the user's phone up and re-provision via partner-secret.
   * Runs inside the single-flight (called only from doRefresh), so at most one reprovision per
   * user at a time. On success returns the freshly minted access token; on failure returns null
   * and provisionAndSave has already recorded an honest non-connected status (so getBackendAccessToken
   * short-circuits on the next call instead of hammering TalerID). Never throws.
   */
  private async autoReprovision(userId: string): Promise<string | null> {
    try {
      const { phone, email, firstName } = await this.lookupProvisionInput(userId);
      if (!phone) {
        this.logger.warn(`talerid auto-reprovision skipped for user ${userId}: no phone on file`);
        return null;
      }
      const { status, accessToken } = await this.provisionAndSave(userId, phone, email, firstName);
      if (status === 'connected' && accessToken) return accessToken;
      this.logger.warn(`talerid auto-reprovision for user ${userId} did not connect: ${status}`);
      return null;
    } catch (e: any) {
      this.logger.warn(`talerid auto-reprovision failed for user ${userId}: ${e?.message}`);
      return null;
    }
  }

  async disconnect(userId: string): Promise<void> {
    await this.store.delete(userId);
  }
}
