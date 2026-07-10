import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { JwtService } from '../common/services/jwt.service';
import { IdentityService } from '../identity/identity.service';
import { EventsService } from '../events/events.service';
import axios from 'axios';

// Чисто служебные номера: при DEBUG_SMS_CODES=true НИКОГДА не шлём реальную SMS
// (код доступен через /webhook/debug/sms-code). Это smoke/мониторинг/playwright
// и невалидные номера (70000000000 — не MSISDN). Бэклог b0821507: рост SMS-расхода
// после мониторинга; явно «не слать на 79030169187».
const PURE_TEST_PHONES = ['70000000000', '79030169187', '79169403771'];
const PURE_TEST_PATTERN = /^790300\d{5}$/;

// «Двойные» номера: реальный телефон, который ЗАОДНО используется как dev/test
// (79656445804 — им же владелец логинится с телефона). Для них реальную SMS
// шлём НА ОБЫЧНЫЙ вход, а глушим ТОЛЬКО когда вызов помечен как автоматический
// (?nosms=1 от Claude-ceremony/тестов) — иначе владелец не может войти по SMS
// (инцидент 2026-07-10). Код всё равно кладётся в Redis для debug-эндпоинта.
const DEV_DUAL_PHONES = ['79656445804'];

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

  async requestSmsCode(phone: string, sid?: string | null, src?: string | null, opts?: { suppressSms?: boolean }): Promise<{ status: string }> {
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

    // Решаем, глушить ли реальную SMS. Только при DEBUG_SMS_CODES=true:
    //  • чисто служебные номера — всегда глушим (код в Redis);
    //  • «двойной» номер владельца (79656445804) — глушим ТОЛЬКО если вызов
    //    помечен автоматическим (suppressSms=?nosms=1); обычный вход шлёт SMS.
    const debug = process.env.DEBUG_SMS_CODES === 'true';
    const isPureTest = PURE_TEST_PHONES.includes(phone) || PURE_TEST_PATTERN.test(phone);
    const isDevDual = DEV_DUAL_PHONES.includes(phone);
    const skipSms = debug && (isPureTest || (isDevDual && !!opts?.suppressSms));
    if (skipSms) {
      this.logger.log(`Phone ${phone}: SMSAERO skipped (${isPureTest ? 'pure-test' : 'dev-dual+nosms'}), code in Redis`);
    } else {
      // Send SMS via SMS Aero
      await this.sendSms(phone, code);
    }
    const isTest = skipSms; // for the otp_request event's `sent` flag below

    // sid/src прокидываются с фронта (?sid=&src=) — чтобы шаг регистрации был
    // привязан к рекламной сессии и источнику (раньше otp_* шли без атрибуции,
    // и пост-клик воронка была слепой).
    this.events?.track('otp_request', { userId: phone, sessionId: sid || null, source: src || null, props: { channel: 'sms', sent: !isTest } });

    return { status: 'sent' };
  }

  private async sendSms(phone: string, code: string): Promise<void> {
    // Telegram-like skip-list для тестовых телефонов: smoke/playwright за двухфазный
    // деплой дёргают /sms/:phone 4-6 раз, SMS Aero отбивает 400 (blacklist) — забивает
    // логи и расходует rate-limit. Код всё равно лежит в Redis (sendCode), так что
    // /webhook/debug/sms-code/:phone и smoke-чек работают как раньше.
    const skipList = (process.env.SMS_AERO_SKIP_PHONES || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    if (skipList.includes(phone)) {
      this.logger.log(`SMS Aero skipped for ${phone} (in SMS_AERO_SKIP_PHONES). Code in Redis.`);
      return;
    }

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
        this.events?.track('sms_aero_failure', {
          userId: phone,
          props: { http_status: resp.status, reason: resp.data?.message?.slice(0, 100) || 'unknown' },
        });
      } else {
        this.logger.log(`SMS sent to ${phone}`);
        this.events?.track('sms_aero_success', { userId: phone });
      }
    } catch (e) {
      this.logger.error(`SMS send failed: ${e.message}`);
      this.events?.track('sms_aero_failure', {
        userId: phone,
        props: { http_status: 0, reason: e.message?.slice(0, 100) || 'network' },
      });
    }
  }

  async checkCode(phone: string, code: string, sid?: string | null, src?: string | null): Promise<{ 'access-token': string; 'refresh-token': string; 'is-new-user': boolean } | null> {
    const stored = await this.redis.get(`sc-${phone}`);
    if (!stored) return null; // expired
    if (stored !== code) return null; // wrong code

    await this.redis.del(`sc-${phone}`);

    // IdentityService is the single point that emits signup_completed and
    // auth_succeeded — covers SMS, Google, Yandex, email magic-link. Here
    // we only emit the SMS-specific otp_verified.
    const { userId, isNew } = await this.identity.resolveOrCreate('phone', { phone });

    this.events?.track('otp_verified', { userId, sessionId: sid || null, source: src || null, props: { channel: 'sms' } });

    return {
      'access-token': this.jwtSvc.signAccess(userId),
      'refresh-token': this.jwtSvc.signRefresh(userId),
      // Для фронта: фиксируем регистрацию в VK-пикселе (goal=registration)
      // только для НОВОГО пользователя, не на каждый вход.
      'is-new-user': isNew,
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
