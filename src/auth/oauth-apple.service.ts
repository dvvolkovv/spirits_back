import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

/**
 * Вход через Apple.
 *
 * Отличается от Google и Яндекса тем, что обмена кода на userinfo нет: на
 * устройстве нативный диалог сразу отдаёт подписанный identityToken, и наша
 * задача — проверить подпись, а не ходить за данными. Поэтому здесь нет ни
 * clientSecret, ни redirectUri.
 *
 * Проверяем всё, что можно проверить: подпись по ключам Apple, издателя,
 * получателя (наш bundle id) и срок. Пропустить хотя бы одно — значит принять
 * чужой токен: identityToken выдаётся любому приложению, и без сверки `aud`
 * подошёл бы токен от постороннего.
 */
@Injectable()
export class OAuthAppleService {
  private readonly logger = new Logger(OAuthAppleService.name);

  private static readonly ISSUER = 'https://appleid.apple.com';
  private static readonly JWKS_URL = 'https://appleid.apple.com/auth/keys';

  /**
   * Кому выдан токен. Для нативного входа это bundle id приложения, а не
   * Services ID — тот нужен только вебу и отзыву токена.
   *
   * Список, а не строка: у iOS и возможного macOS-таргета bundle id разные,
   * а токен один и тот же формат.
   */
  private readonly audiences: [string, ...string[]] = ((): [string, ...string[]] => {
    const list = (process.env.APPLE_BUNDLE_IDS || 'io.linkeon.linkeonMobile')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    // Пустой список означал бы проверку без сверки получателя — то есть
    // приём токена, выданного любому другому приложению. Лучше вернуться
    // к значению по умолчанию, чем остаться без проверки.
    return list.length > 0
      ? (list as [string, ...string[]])
      : ['io.linkeon.linkeonMobile'];
  })();

  /**
   * Ключи Apple меняются редко, но меняются. Держим их в памяти и
   * перечитываем, когда встретился незнакомый kid, — так и лишних походов
   * нет, и ротация не роняет вход.
   */
  private keys = new Map<string, string>();
  private keysFetchedAt = 0;
  private static readonly KEYS_TTL_MS = 24 * 60 * 60 * 1000;

  isConfigured(): boolean {
    return this.audiences.length > 0;
  }

  /**
   * Проверяет identityToken и возвращает данные в том же виде, что и
   * остальные провайдеры, — чтобы resolveOrCreate не пришлось учить
   * отдельному формату.
   *
   * `email` у Apple может отсутствовать вовсе или быть подставным адресом
   * вида `...@privaterelay.appleid.com`, если человек скрыл почту. Это
   * нормальный сценарий, а не ошибка: опознаём человека по `sub`.
   */
  async verifyIdentityToken(
    identityToken: string,
  ): Promise<{ sub: string; email: string; emailVerified: boolean }> {
    const decoded = jwt.decode(identityToken, { complete: true });
    if (!decoded || typeof decoded === 'string' || !decoded.header?.kid) {
      throw new Error('apple identityToken malformed');
    }

    const publicKey = await this.publicKeyFor(decoded.header.kid);

    let payload: any;
    try {
      payload = jwt.verify(identityToken, publicKey, {
        algorithms: ['RS256'],
        issuer: OAuthAppleService.ISSUER,
        audience: this.audiences,
      });
    } catch (e: any) {
      throw new Error(`apple identityToken rejected: ${e.message}`);
    }

    const sub = payload?.sub;
    if (!sub) throw new Error('apple identityToken without sub');

    // email_verified приходит то булевым, то строкой "true" — Apple не
    // определилась. Приводим сами, иначе Boolean("false") дало бы true.
    const verifiedRaw = payload.email_verified;
    const emailVerified =
      verifiedRaw === true || verifiedRaw === 'true';

    return {
      sub: String(sub),
      email: String(payload.email || '').trim().toLowerCase(),
      emailVerified,
    };
  }

  /** Публичный ключ Apple по kid, в PEM. */
  private async publicKeyFor(kid: string): Promise<string> {
    const cached = this.keys.get(kid);
    const fresh = Date.now() - this.keysFetchedAt < OAuthAppleService.KEYS_TTL_MS;
    if (cached && fresh) return cached;

    await this.refreshKeys();
    const key = this.keys.get(kid);
    // Незнакомый kid после обновления — либо чужой токен, либо ключ,
    // которого у Apple нет. И то и другое означает отказ.
    if (!key) throw new Error(`apple signing key ${kid} not found`);
    return key;
  }

  private async refreshKeys(): Promise<void> {
    const resp = await axios.get(OAuthAppleService.JWKS_URL, { timeout: 10_000 });
    const jwks = resp.data?.keys;
    if (!Array.isArray(jwks) || jwks.length === 0) {
      throw new Error('apple jwks empty');
    }

    const next = new Map<string, string>();
    for (const jwk of jwks) {
      if (!jwk?.kid) continue;
      try {
        // Node умеет читать JWK напрямую — отдельной библиотеки не нужно.
        const pem = crypto
          .createPublicKey({ key: jwk, format: 'jwk' })
          .export({ type: 'spki', format: 'pem' })
          .toString();
        next.set(jwk.kid, pem);
      } catch (e: any) {
        this.logger.warn(`ключ ${jwk.kid} не разобрался: ${e.message}`);
      }
    }
    if (next.size === 0) throw new Error('apple jwks unusable');

    this.keys = next;
    this.keysFetchedAt = Date.now();
  }
}
