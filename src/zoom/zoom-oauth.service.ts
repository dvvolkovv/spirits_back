import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { RedisService } from '../common/services/redis.service';
import { ZoomOauthClient } from './zoom-oauth.client';
import { ZoomStoreService } from './zoom-store.service';

/**
 * Подключение аккаунта Zoom и выдача токена On-Behalf-Of.
 *
 * ЗАЧЕМ ВООБЩЕ. С 2 марта 2026 приложение на Meeting SDK входит во встречу за
 * пределами своего аккаунта только с токеном OBF. Токен выдаётся от имени
 * пользователя, который авторизовал приложение и присутствует на встрече, —
 * то есть ровно того, кто зовёт ассистента.
 *
 * Без подключения ассистент остаётся заперт во встречах нашего же аккаунта.
 */

/** Сколько живёт одноразовый `state`. Согласие человек даёт за секунды. */
const STATE_TTL_SEC = 600;

@Injectable()
export class ZoomOauthService {
  private readonly logger = new Logger(ZoomOauthService.name);

  /**
   * Обновление токена на пользователя — в одном экземпляре.
   *
   * Два одновременных входа на встречу обновили бы токен дважды, а refresh у
   * Zoom ротируется: второй обмен получил бы отказ по уже обесцененному
   * токену, и подключение развалилось бы на ровном месте.
   */
  private readonly refreshing = new Map<string, Promise<string | null>>();

  constructor(
    private readonly client: ZoomOauthClient,
    private readonly store: ZoomStoreService,
    @Optional() private readonly redis?: RedisService,
  ) {}

  configured(): boolean {
    return this.client.configured();
  }

  /** Адрес согласия и одноразовый `state`, привязанный к пользователю. */
  async start(userId: string): Promise<{ authorizeUrl: string } | { error: string }> {
    if (!this.configured()) return { error: 'zoom_not_configured' };
    const state = randomBytes(24).toString('base64url');
    await this.redis?.set(`zoom-oauth-${state}`, JSON.stringify({ userId }), STATE_TTL_SEC);
    return { authorizeUrl: this.client.authorizeUrl(state) };
  }

  /** Чей это возврат. `null` — чужой или протухший. */
  async claimState(state: string): Promise<string | null> {
    if (!state || !this.redis) return null;
    const raw = await this.redis.get(`zoom-oauth-${state}`);
    if (!raw) return null;
    await this.redis.del(`zoom-oauth-${state}`);
    try {
      return String(JSON.parse(raw)?.userId || '') || null;
    } catch {
      return null;
    }
  }

  /** Обменять код и сохранить подключение. `false` — не вышло. */
  async complete(userId: string, code: string): Promise<boolean> {
    try {
      const tokens = await this.client.exchangeCode(code);
      let who = { id: '', accountId: '', email: '' };
      try {
        who = await this.client.me(tokens.accessToken);
      } catch (e: any) {
        // Профиль — украшение: без него подключение всё равно рабочее.
        this.logger.warn(`не узнали, чей аккаунт Zoom: ${e?.message}`);
      }
      await this.store.save({
        userId,
        zoomUserId: who.id || null,
        zoomAccountId: who.accountId || null,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
      });
      this.logger.log(`[zoom] аккаунт подключён: user=${userId}`);
      return true;
    } catch (e: any) {
      this.logger.warn(`[zoom] обмен кода не удался: ${e?.message}`);
      return false;
    }
  }

  async status(userId: string): Promise<{ connected: boolean; zoomUserId?: string | null }> {
    const c = await this.store.get(userId);
    return c?.refreshToken ? { connected: true, zoomUserId: c.zoomUserId } : { connected: false };
  }

  async disconnect(userId: string): Promise<void> {
    await this.store.remove(userId);
  }

  /** Живой токен доступа: при нужде обновляем, ротацию сохраняем целиком. */
  private async accessToken(userId: string): Promise<string | null> {
    const c = await this.store.get(userId);
    if (!c?.refreshToken) return null;
    const fresh = c.accessToken && c.accessExpiresAt && c.accessExpiresAt.getTime() > Date.now();
    if (fresh) return c.accessToken;

    const running = this.refreshing.get(userId);
    if (running) return running;

    const job = (async () => {
      try {
        const t = await this.client.refresh(c.refreshToken!);
        await this.store.save({
          userId,
          zoomUserId: c.zoomUserId,
          zoomAccountId: c.zoomAccountId,
          refreshToken: t.refreshToken,
          accessToken: t.accessToken,
          accessExpiresAt: t.expiresAt,
          scopes: t.scopes || c.scopes,
        });
        return t.accessToken;
      } catch (e: any) {
        // Refresh мёртв — подключение надо делать заново. Строку не удаляем:
        // по ней видно, что человек когда-то подключался, и статус честно
        // покажет «подключено», пока он не переподключится. Удалять молча —
        // значит потерять след.
        this.logger.warn(`[zoom] обновить токен не вышло: ${e?.message}`);
        return null;
      } finally {
        this.refreshing.delete(userId);
      }
    })();
    this.refreshing.set(userId, job);
    return job;
  }

  /**
   * Токен для входа на конкретную встречу. `null` — войти по нему нельзя.
   *
   * Берётся на каждый вход заново: он одноразовый и короткоживущий.
   */
  async obfToken(userId: string, meetingNumber: string): Promise<string | null> {
    if (!this.configured()) return null;
    const access = await this.accessToken(userId);
    if (!access) return null;
    try {
      const token = await this.client.onBehalfToken(access, meetingNumber);
      return token || null;
    } catch (e: any) {
      this.logger.warn(`[zoom] OBF-токен не выдан: ${e?.message}`);
      return null;
    }
  }
}
