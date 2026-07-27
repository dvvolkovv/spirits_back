import { Injectable, Logger } from '@nestjs/common';
import { randomBytes, createHash } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { TalerIdOauthClient } from './talerid-oauth.client';
import { TalerIdOauthService } from './talerid-oauth.service';
import { LinkStatus, AttachPhoneResult, AttachPhoneFail } from './talerid.types';

/** Type guard — this repo has strictNullChecks:false, under which a plain `if (!r.ok)` does NOT
 *  narrow the union on the negative branch (see TalerIdOauthService.isProvisionFail for the same). */
function isAttachFail(r: AttachPhoneResult): r is AttachPhoneFail {
  return r.ok === false;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/** PKCE code_verifier: 43-char base64url (32 random bytes) — within RFC 7636 43..128. */
function genVerifier(): string { return b64url(randomBytes(32)); }
/** S256 challenge = base64url(SHA-256(verifier)). */
function challengeFor(verifier: string): string { return b64url(createHash('sha256').update(verifier).digest()); }
function genState(): string { return b64url(randomBytes(24)); }

interface LinkState { userId: string; verifier: string; phone: string; }

/**
 * Task 6 — account linking (OAuth-link). Orchestrates the two-leg flow:
 *  startLink  (authenticated): mint PKCE state, stash {userId,verifier,phone} in Redis, return authorize URL.
 *  completeLink (public callback, tied back by `state`): exchange code→id_token, attach phone to the
 *  authenticated account (+ merge duplicate), then reuse the existing provision-by-phone to store tokens
 *  on the now-linked account. No new token channel — attach just moves the phone.
 *
 * Security: OAuth id_token proves "this is my account"; the phone was SMS-verified by Linkeon and is
 * carried server-side (stashed at start, never from the untrusted callback) — both proofs required.
 */
@Injectable()
export class TalerIdLinkService {
  private readonly logger = new Logger(TalerIdLinkService.name);
  private static readonly TTL_S = 600; // 10 min — matches TalerID's id_token iat anti-replay window
  private static readonly KEY = (state: string) => `talerid:link:${state}`;

  constructor(
    private readonly client: TalerIdOauthClient,
    private readonly oauth: TalerIdOauthService,
    private readonly redis: RedisService,
  ) {}

  /** Behind JwtGuard. phone is looked up server-side and stashed — the callback never trusts a client phone. */
  async startLink(userId: string, phone: string): Promise<{ authorizeUrl: string }> {
    const state = genState();
    const verifier = genVerifier();
    const payload: LinkState = { userId, verifier, phone };
    await this.redis.set(TalerIdLinkService.KEY(state), JSON.stringify(payload), TalerIdLinkService.TTL_S);
    return { authorizeUrl: this.client.buildAuthorizeUrl(state, challengeFor(verifier)) };
  }

  /**
   * Public callback path. Resolves the outcome to a LinkStatus (the controller redirects the browser
   * with it). One-time state (deleted on use) prevents replay. Never throws.
   */
  async completeLink(state: string, code: string): Promise<LinkStatus> {
    if (!state || !code) return 'error';
    const key = TalerIdLinkService.KEY(state);
    const raw = await this.redis.get(key);
    if (!raw) return 'expired';
    await this.redis.del(key); // one-time use — reuse/replay lands here as 'expired'

    let st: LinkState;
    try { st = JSON.parse(raw); } catch { return 'error'; }
    const { userId, verifier, phone } = st;
    if (!userId || !verifier || !phone) return 'error';

    let idToken: string;
    try {
      idToken = await this.client.exchangeCodeForIdToken(code, verifier);
    } catch (e: any) {
      this.logger.warn(`talerid link: code exchange failed for user ${userId}: ${e?.message}`);
      return 'error';
    }

    const attach = await this.client.attachPhone(idToken, phone);
    if (isAttachFail(attach)) {
      if (attach.kind === 'different_phone') return 'different_phone';
      if (attach.kind === 'phone_taken') return 'phone_taken';
      if (attach.kind === 'has_messages') return 'has_messages';
      this.logger.warn(`talerid link: attach-phone failed for user ${userId}: kind=${attach.kind} status=${attach.status}`);
      return 'error';
    }

    // Phone is now on the real account → the existing provision-by-phone finds it and stores tokens
    // (overwriting any prior duplicate connection for this user). No new token plumbing.
    try {
      const status = await this.oauth.connect(userId, phone);
      return status === 'connected' ? 'linked' : 'error';
    } catch (e: any) {
      this.logger.warn(`talerid link: post-attach provision failed for user ${userId}: ${e?.message}`);
      return 'error';
    }
  }
}
