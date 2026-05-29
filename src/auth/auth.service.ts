import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { JwtService } from '../common/services/jwt.service';
import { IdentityService } from '../identity/identity.service';
import { EventsService } from '../events/events.service';
import axios from 'axios';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly jwtSvc: JwtService,
    private readonly identity: IdentityService,
    @Optional() private readonly events?: EventsService,
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

    // Generate 6-digit code
    const code = String(Math.floor(100000 + Math.random() * 900000));

    // Store in Redis with 5 min TTL
    await this.redis.set(`sc-${phone}`, code, 300);

    // Send SMS via SMS Aero
    await this.sendSms(phone, code);

    this.events?.track('otp_request', { userId: phone, props: { channel: 'sms' } });

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
      // WebOTP-маркер в последней строке — Chrome Android и Safari iOS17+
      // подставят код в форму через navigator.credentials.get. Формат строгий:
      // `@<hostname> #<code>` (origin без протокола). Проверено что SMS Aero
      // принимает `\n@#` через axios params (URL-кодируется как %0A%40%23) —
      // см. test от 2026-05-15. Прошлые 400-errors были не из-за формата.
      const resp = await axios.get(url, {
        params: {
          number: phone,
          text: `Код ${code} для входа в linkeon.io\n@my.linkeon.io #${code}`,
          sign: 'SMSAero',
        },
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (resp.status >= 400) {
        // validateStatus + body capture — раньше ошибка ловилась как голое
        // «status code 400» без тела, что мешало диагностике.
        this.logger.error(`SMS Aero ${resp.status} for ${phone}: ${JSON.stringify(resp.data).slice(0, 300)}`);
      } else {
        this.logger.log(`SMS sent to ${phone}`);
      }
    } catch (e) {
      this.logger.error(`SMS send failed: ${e.message}`);
    }
  }

  async checkCode(phone: string, code: string): Promise<{ 'access-token': string; 'refresh-token': string } | null> {
    const stored = await this.redis.get(`sc-${phone}`);
    if (!stored) return null; // expired
    if (stored !== code) return null; // wrong code

    await this.redis.del(`sc-${phone}`);

    const { userId, isNew } = await this.identity.resolveOrCreate('phone', { phone });

    this.events?.track('otp_verified', { userId, props: { channel: 'sms' } });
    if (isNew) {
      this.events?.track('signup_completed', { userId, props: { channel: 'sms' } });
    }

    return {
      'access-token': this.jwtSvc.signAccess(userId),
      'refresh-token': this.jwtSvc.signRefresh(userId),
    };
  }

  async getDebugCode(phone: string): Promise<string | null> {
    return this.redis.get(`sc-${phone}`);
  }

  /**
   * Debug: изменить баланс токенов тестового пользователя (+/-).
   * Используется ТОЛЬКО Playwright-тестами; гейт по DEBUG_SMS_CODES в контроллере.
   */
  async debugAddTokens(phone: string, delta: number): Promise<{
    phone: string;
    balance_before: number;
    balance_after: number;
  }> {
    const before = await this.pg.query(
      'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
      [phone],
    );
    if (before.rows.length === 0) {
      throw new Error(`user not found: ${phone}`);
    }
    const balanceBefore = Number(before.rows[0].tokens || 0);

    await this.pg.query(
      'UPDATE ai_profiles_consolidated SET tokens = tokens + $1, updated_at = now() WHERE user_id = $2',
      [delta, phone],
    );

    const balanceAfter = balanceBefore + delta;
    return { phone, balance_before: balanceBefore, balance_after: balanceAfter };
  }

  async refreshTokens(refreshToken: string): Promise<{ 'access-token': string; 'refresh-token': string } | null> {
    try {
      const payload = this.jwtSvc.verify(refreshToken);
      if (payload.type !== 'refresh') return null;
      const userId: string = payload.userId ?? payload.sub;
      return {
        'access-token': this.jwtSvc.signAccess(userId),
        'refresh-token': this.jwtSvc.signRefresh(userId),
      };
    } catch {
      return null;
    }
  }
}
