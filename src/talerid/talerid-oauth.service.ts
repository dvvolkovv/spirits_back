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

/** Scope this slice deals with exclusively — the calendar connector (Task 4). */
const CALENDAR_SCOPE = ['mcp:calendar'];
const CALENDAR_SCOPE_STR = 'mcp:calendar';

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
    const result = await this.client.provision({ phone, email, firstName, scopes: CALENDAR_SCOPE });

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
      scopes: CALENDAR_SCOPE_STR,
    });
    return 'connected';
  }

  /**
   * Returns a valid mcp:calendar access token for this user, or null if not
   * connected / connection isn't in 'connected' status / refresh fails.
   */
  async getBackendAccessToken(userId: string): Promise<string | null> {
    const connection = await this.store.getConnection(userId);
    if (!connection || connection.status !== 'connected') return null;

    const stored = await this.store.getAccess(userId);
    if (stored?.accessToken && stored.expiresAt && stored.expiresAt.getTime() - EXPIRY_SKEW_MS > Date.now()) {
      return stored.accessToken;
    }

    const refreshToken = await this.store.getRefresh(userId);
    if (!refreshToken) return null;

    let refreshed;
    try {
      refreshed = await this.client.refresh(refreshToken, CALENDAR_SCOPE);
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
