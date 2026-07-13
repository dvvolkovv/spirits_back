import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import * as webpush from 'web-push';
import { PgService } from '../common/services/pg.service';

// Web Push transport (Слой 1 low-friction Android). Хранит подписки устройств,
// шлёт уведомления через VAPID. Переиспользуемо: рутинные пуши (Слой 3),
// «видео готово», реферальные события и т.д. Протухшие подписки (404/410) чистим.
export interface PushPayload {
  title: string;
  body?: string;
  url?: string;   // куда открыть по тапу (deep-link в PWA)
  image?: string;
  tag?: string;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private configured = false;

  // FCM HTTP v1 (нативные пуши [Натив 3]). Сервис-аккаунт из
  // FCM_SERVICE_ACCOUNT_JSON (инлайн JSON или путь к файлу).
  private fcm: { clientEmail: string; privateKey: string; projectId: string; tokenUri: string } | null = null;
  private fcmToken: { value: string; exp: number } | null = null;

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (this.pg) {
      for (const name of ['001_push_subscriptions.sql', '002_push_platform.sql']) {
        for (const p of [
          path.join(__dirname, 'migrations', name),
          path.join(__dirname, '..', '..', 'src', 'push', 'migrations', name),
        ]) {
          try {
            if (fs.existsSync(p)) { await this.pg.query(fs.readFileSync(p, 'utf8')); this.logger.log(`push migration applied: ${name}`); break; }
          } catch (e: any) { this.logger.error(`push migration failed (${p}): ${e.message}`); }
        }
      }
    }
    this.loadFcm();
    const pub = process.env.VAPID_PUBLIC_KEY;
    const priv = process.env.VAPID_PRIVATE_KEY;
    if (pub && priv) {
      try {
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@linkeon.io', pub, priv);
        this.configured = true;
        this.logger.log('Web Push configured (VAPID)');
      } catch (e: any) { this.logger.error(`VAPID setup failed: ${e.message}`); }
    } else {
      this.logger.warn('VAPID keys not set — Web Push disabled');
    }
  }

  getPublicKey(): string | null { return process.env.VAPID_PUBLIC_KEY || null; }

  // Загрузка сервис-аккаунта FCM: инлайн JSON или путь к файлу.
  private loadFcm() {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON;
    if (!raw) { this.logger.warn('FCM_SERVICE_ACCOUNT_JSON not set — native push (FCM) disabled'); return; }
    try {
      const json = raw.trim().startsWith('{') ? raw : fs.readFileSync(raw, 'utf8');
      const sa = JSON.parse(json);
      if (sa.client_email && sa.private_key && sa.project_id) {
        this.fcm = {
          clientEmail: sa.client_email,
          privateKey: sa.private_key,
          projectId: sa.project_id,
          tokenUri: sa.token_uri || 'https://oauth2.googleapis.com/token',
        };
        this.logger.log(`FCM v1 configured (project ${sa.project_id})`);
      } else {
        this.logger.error('FCM service account missing client_email/private_key/project_id');
      }
    } catch (e: any) { this.logger.error(`FCM service account load failed: ${e.message}`); }
  }

  // OAuth2 access token для FCM v1 (кэшируем до истечения).
  private async fcmAccessToken(): Promise<string | null> {
    if (!this.fcm) return null;
    const now = Math.floor(Date.now() / 1000);
    if (this.fcmToken && this.fcmToken.exp - 60 > now) return this.fcmToken.value;
    try {
      const assertion = jwt.sign(
        { scope: 'https://www.googleapis.com/auth/firebase.messaging' },
        this.fcm.privateKey,
        { algorithm: 'RS256', issuer: this.fcm.clientEmail, audience: this.fcm.tokenUri, expiresIn: 3600, header: { alg: 'RS256', typ: 'JWT' } as any },
      );
      const res = await axios.post(
        this.fcm.tokenUri,
        new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 },
      );
      this.fcmToken = { value: res.data.access_token, exp: now + (res.data.expires_in || 3600) };
      return this.fcmToken.value;
    } catch (e: any) {
      this.logger.error(`FCM token exchange failed: ${e?.response?.data?.error || e.message}`);
      return null;
    }
  }

  // Отправка на один нативный FCM-токен. true — доставлено; false — ошибка;
  // 'prune' — токен мёртв (удалить).
  private async sendFcm(token: string, payload: PushPayload): Promise<boolean | 'prune'> {
    const access = await this.fcmAccessToken();
    if (!access || !this.fcm) return false;
    try {
      await axios.post(
        `https://fcm.googleapis.com/v1/projects/${this.fcm.projectId}/messages:send`,
        {
          message: {
            token,
            notification: { title: payload.title, body: payload.body || '' },
            data: { url: payload.url || '', tag: payload.tag || '' },
            android: { priority: 'HIGH', notification: { ...(payload.image ? { image: payload.image } : {}) } },
          },
        },
        { headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );
      return true;
    } catch (e: any) {
      const status = e?.response?.status;
      const err = e?.response?.data?.error?.status;
      if (status === 404 || err === 'NOT_FOUND' || err === 'UNREGISTERED') return 'prune';
      this.logger.warn(`FCM send failed (${status || '?'} ${err || ''})`);
      return false;
    }
  }

  async subscribe(userId: string, sub: { endpoint: string; keys: Record<string, string> }): Promise<void> {
    if (!this.pg || !sub?.endpoint || !sub?.keys) return;
    await this.pg.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, platform) VALUES ($1, $2, $3, 'web')
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, keys = $3, platform = 'web'`,
      [userId, sub.endpoint, JSON.stringify(sub.keys)],
    );
  }

  // Регистрация нативного FCM-токена (Capacitor push) [Натив 3].
  async registerNative(userId: string, token: string): Promise<void> {
    if (!this.pg || !token) return;
    await this.pg.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, platform) VALUES ($1, $2, '{}'::jsonb, 'android')
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, platform = 'android'`,
      [userId, `fcm:${token}`],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    if (!this.pg || !endpoint) return;
    await this.pg.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
  }

  /** Отправить push всем устройствам юзера (web-push + нативный FCM). Возвращает число доставленных. */
  async sendPush(userId: string, payload: PushPayload): Promise<number> {
    if (!this.pg) return 0;
    const subs = await this.pg.query(
      `SELECT endpoint, keys, platform FROM push_subscriptions WHERE user_id = $1`,
      [userId],
    );
    let ok = 0;
    for (const s of subs.rows as any[]) {
      if (s.platform === 'android') {
        // Нативный FCM-токен.
        const token = String(s.endpoint).replace(/^fcm:/, '');
        const r = await this.sendFcm(token, payload);
        if (r === true) ok++;
        else if (r === 'prune') {
          await this.pg.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]).catch(() => {});
          this.logger.log(`pruned dead FCM token for ${userId}`);
        }
        continue;
      }
      // Web Push (VAPID).
      if (!this.configured) continue;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys } as any, JSON.stringify(payload));
        ok++;
      } catch (e: any) {
        const code = e?.statusCode;
        if (code === 404 || code === 410) {
          await this.pg.query(`DELETE FROM push_subscriptions WHERE endpoint = $1`, [s.endpoint]).catch(() => {});
          this.logger.log(`pruned stale push subscription (${code}) for ${userId}`);
        } else {
          this.logger.warn(`push send failed (${code || '?'}) for ${userId}: ${e?.message}`);
        }
      }
    }
    return ok;
  }
}
