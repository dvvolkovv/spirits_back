import { Injectable, Logger } from '@nestjs/common';
import { TalerIdStoreService } from './talerid-store.service';
import { TalerIdOauthClient } from './talerid-oauth.client';
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

/**
 * Full scope set Linkeon requests at connect time. TalerID grants the
 * INTERSECTION with the linkeon-partner client's allowedScopes, so this is
 * safe to request before TalerID widens the client: pre-widening it grants
 * calendar only (identical to the original calendar-only slice), post-widening
 * it grants notes/messages/mail too — with NO code change here. We always
 * store and refresh with the scope TalerID actually GRANTED (result.scope),
 * never this requested set, so a refresh never asks for more than the grant.
 *
 * One token, not two: the same access token serves the backend calendar
 * connector AND the agent-direct path. The agent is prevented from touching
 * calendar not by a narrower token (a second refresh would rotate the shared
 * refresh and revoke the chain) but by the file-agent's `--allowedTools`
 * allowlist, which omits the talerid calendar tools. See the connector design
 * doc, section "ОДИН токен + tool-allowlist".
 */
const ALL_SCOPES = [
  'mcp:calendar',
  'mcp:notes',
  'mcp:messages.read',
  'mcp:messages.send',
  'mcp:mail.read',
  'mcp:mail.send',
];
/** Fallback grant if a stored connection predates the scopes column being set. */
const CALENDAR_SCOPE = ['mcp:calendar'];

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
  ) {}

  async connect(
    userId: string,
    phone: string,
    email?: string,
    firstName?: string,
  ): Promise<TalerIdConnectionStatus> {
    const result = await this.client.provision({ phone, email, firstName, scopes: ALL_SCOPES });

    if (isProvisionFail(result)) {
      // ambiguous (409, last-10 phone match) or error (401/403/5xx/network) —
      // never save tokens, just record the status for the caller/UI.
      await this.store.setStatus(userId, result.kind);
      return result.kind;
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
    return 'connected';
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
      this.logger.warn(`talerid refresh failed for user ${userId}: ${e?.message}`);
      return null;
    }

    // Persist the rotated refresh + new access BEFORE returning — never lose
    // the new refresh to a crash between the HTTP call and the DB write.
    await this.store.updateRefresh(userId, refreshed.refreshToken);
    await this.store.updateAccess(userId, refreshed.accessToken, new Date(Date.now() + refreshed.expiresIn * 1000));

    return refreshed.accessToken;
  }

  async disconnect(userId: string): Promise<void> {
    await this.store.delete(userId);
  }
}
