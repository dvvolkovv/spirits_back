import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

/**
 * Вход через Apple.
 *
 * Отличается от Google и Яндекса тем, что за данными пользователя ходить не
 * нужно: системный диалог на устройстве сразу отдаёт подписанный
 * identityToken, и наша задача — проверить подпись. Поэтому redirectUri здесь
 * нет вовсе.
 *
 * Серверные вызовы к Apple всё-таки есть, но ради другого: обменять
 * authorizationCode на refresh-токен и потом отозвать его при удалении
 * аккаунта. Отзыв — обязательное требование Apple, и выполнить его по одному
 * identityToken нельзя.
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

  /**
   * Ключ для серверных обращений к Apple: обмен кода и отзыв токена.
   *
   * APPLE_PRIVATE_KEY — содержимое .p8 целиком. В переменной окружения
   * переводы строк обычно превращаются в \n, поэтому разворачиваем обратно:
   * без настоящих переносов PKCS#8 не разбирается.
   */
  private readonly privateKey = (process.env.APPLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  private readonly keyId = process.env.APPLE_KEY_ID || '';
  private readonly teamId = process.env.APPLE_TEAM_ID || '';

  isConfigured(): boolean {
    return this.audiences.length > 0;
  }

  /** Готов ли сервис к серверным вызовам Apple (обмен кода, отзыв). */
  canCallApple(): boolean {
    return Boolean(this.privateKey && this.keyId && this.teamId);
  }

  /**
   * client_secret для Apple — это JWT, подписанный нашим .p8 по ES256.
   *
   * Живёт недолго намеренно: Apple разрешает до полугода, но секрет,
   * который валяется где-то полгода, — это секрет, который утечёт. Он
   * дешёвый, генерируем на каждый вызов.
   */
  private clientSecret(clientId: string): string {
    return jwt.sign({}, this.privateKey, {
      algorithm: 'ES256',
      keyid: this.keyId,
      issuer: this.teamId,
      audience: 'https://appleid.apple.com',
      subject: clientId,
      expiresIn: 300,
    });
  }

  /**
   * Меняет authorizationCode на refresh-токен Apple.
   *
   * Нужен ровно для одного: чтобы потом суметь отозвать доступ при удалении
   * аккаунта. Apple требует этого от каждого приложения с входом через Apple,
   * а отозвать по identityToken нельзя — только по refresh или access токену,
   * который выдаётся исключительно в обмен на код.
   *
   * Возвращает null, если обмен не удался: вход из-за этого срывать нельзя —
   * человек уже подтвердил его в системном диалоге.
   */
  async exchangeCodeForRefreshToken(code: string, clientId: string): Promise<string | null> {
    if (!this.canCallApple()) {
      this.logger.warn('ключ Apple не настроен — refresh-токен не получен, отзыв работать не будет');
      return null;
    }
    try {
      const resp = await axios.post(
        'https://appleid.apple.com/auth/token',
        new URLSearchParams({
          client_id: clientId,
          client_secret: this.clientSecret(clientId),
          code,
          grant_type: 'authorization_code',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );
      return resp.data?.refresh_token || null;
    } catch (e: any) {
      this.logger.warn(`обмен кода Apple не удался: ${e.response?.data?.error || e.message}`);
      return null;
    }
  }

  /**
   * Отзывает доступ приложения к учётной записи Apple.
   *
   * Обязательное требование Apple к приложениям с Sign in with Apple: при
   * удалении аккаунта связь должна разрываться, иначе в настройках Apple ID
   * приложение висит вечно, а повторный вход молча возвращает старую связку.
   */
  async revokeToken(refreshToken: string, clientId: string): Promise<boolean> {
    if (!this.canCallApple()) return false;
    try {
      await axios.post(
        'https://appleid.apple.com/auth/revoke',
        new URLSearchParams({
          client_id: clientId,
          client_secret: this.clientSecret(clientId),
          token: refreshToken,
          token_type_hint: 'refresh_token',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15_000,
        },
      );
      return true;
    } catch (e: any) {
      this.logger.warn(`отзыв токена Apple не удался: ${e.response?.data?.error || e.message}`);
      return false;
    }
  }

  /** Идентификатор клиента для серверных вызовов: у нативного входа это bundle id. */
  primaryClientId(): string {
    return this.audiences[0];
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
