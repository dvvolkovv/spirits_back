import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
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

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (this.pg) {
      for (const p of [
        path.join(__dirname, 'migrations', '001_push_subscriptions.sql'),
        path.join(__dirname, '..', '..', 'src', 'push', 'migrations', '001_push_subscriptions.sql'),
      ]) {
        try {
          if (fs.existsSync(p)) { await this.pg.query(fs.readFileSync(p, 'utf8')); this.logger.log(`push migration applied from ${p}`); break; }
        } catch (e: any) { this.logger.error(`push migration failed (${p}): ${e.message}`); }
      }
    }
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

  async subscribe(userId: string, sub: { endpoint: string; keys: Record<string, string> }): Promise<void> {
    if (!this.pg || !sub?.endpoint || !sub?.keys) return;
    await this.pg.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys) VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET user_id = $1, keys = $3`,
      [userId, sub.endpoint, JSON.stringify(sub.keys)],
    );
  }

  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    if (!this.pg || !endpoint) return;
    await this.pg.query(`DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2`, [userId, endpoint]);
  }

  /** Отправить push всем устройствам юзера. Возвращает число доставленных. */
  async sendPush(userId: string, payload: PushPayload): Promise<number> {
    if (!this.pg || !this.configured) return 0;
    const subs = await this.pg.query(`SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1`, [userId]);
    let ok = 0;
    for (const s of subs.rows as any[]) {
      const sub = { endpoint: s.endpoint, keys: s.keys };
      try {
        await webpush.sendNotification(sub as any, JSON.stringify(payload));
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
