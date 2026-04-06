import { Injectable, Logger } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { JwtService } from '../common/services/jwt.service';
import axios from 'axios';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly jwtSvc: JwtService,
  ) {}

  async requestSmsCode(phone: string): Promise<{ status: string }> {
    // Check if code already exists in Redis
    const existing = await this.redis.get(`sc-${phone}`);
    if (existing) {
      this.logger.log(`Code already exists for ${phone}, skipping resend`);
      return { status: 'exists' };
    }

    // Check user state in DB
    const userRes = await this.pg.query(
      'SELECT state FROM user_id WHERE primary_phone = $1 LIMIT 1',
      [phone],
    );

    if (userRes.rows.length > 0 && userRes.rows[0].state === 'blocked') {
      return { status: 'blocked' };
    }

    // Create user if not exists
    if (userRes.rows.length === 0) {
      await this.pg.query(
        `INSERT INTO user_id (primary_phone, state, internal_id) VALUES ($1, 'active', $2) ON CONFLICT (internal_id) DO NOTHING`,
        [phone, phone],
      );
      await this.pg.query(
        `INSERT INTO ai_profiles_consolidated (user_id, tokens, isadmin) VALUES ($1, 0, false) ON CONFLICT DO NOTHING`,
        [phone],
      );
    }

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store in Redis with 5 min TTL
    await this.redis.set(`sc-${phone}`, code, 300);

    // Send SMS via SMS Aero
    await this.sendSms(phone, code);

    return { status: 'sent' };
  }

  private async sendSms(phone: string, code: string): Promise<void> {
    const login = process.env.SMSAERO_LOGIN;
    const apiKey = process.env.SMSAERO_API_KEY;
    if (!login || !apiKey) {
      this.logger.warn(`SMS Aero credentials not set. Code for ${phone}: ${code}`);
      return;
    }
    try {
      const url = `https://gate.smsaero.ru/v2/sms/send`;
      const auth = Buffer.from(`${login}:${apiKey}`).toString('base64');
      await axios.get(url, {
        params: {
          number: phone,
          text: `Код ${code} для входа в linkeon.io`,
          sign: 'SMSAero',
        },
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000,
      });
      this.logger.log(`SMS sent to ${phone}`);
    } catch (e) {
      this.logger.error(`SMS send failed: ${e.message}`);
    }
  }

  async checkCode(phone: string, code: string): Promise<{ 'access-token': string; 'refresh-token': string } | null> {
    const stored = await this.redis.get(`sc-${phone}`);
    if (!stored) return null; // expired
    if (stored !== code) return null; // wrong code

    await this.redis.del(`sc-${phone}`);

    // Ensure profile exists
    await this.pg.query(
      `INSERT INTO ai_profiles_consolidated (user_id, tokens, isadmin) VALUES ($1, 0, false) ON CONFLICT DO NOTHING`,
      [phone],
    );

    return {
      'access-token': this.jwtSvc.signAccess(phone),
      'refresh-token': this.jwtSvc.signRefresh(phone),
    };
  }

  async getDebugCode(phone: string): Promise<string | null> {
    return this.redis.get(`sc-${phone}`);
  }

  async refreshTokens(refreshToken: string): Promise<{ 'access-token': string; 'refresh-token': string } | null> {
    try {
      const payload = this.jwtSvc.verify(refreshToken);
      if (payload.type !== 'refresh') return null;
      return {
        'access-token': this.jwtSvc.signAccess(payload.phone),
        'refresh-token': this.jwtSvc.signRefresh(payload.phone),
      };
    } catch {
      return null;
    }
  }
}
