import { Injectable, Logger, Optional } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { RedisService } from '../common/services/redis.service';
import { JwtService } from '../common/services/jwt.service';
import { IdentityService } from '../identity/identity.service';
import { EventsService } from '../events/events.service';
import axios from 'axios';
import { randomInt } from 'crypto';
import { SMS_CODE_TTL_SECONDS, smsAttemptsKey, smsCodeKey, verifySmsCode, SmsCodeCheck } from './sms-code';
import { isSmsPhone, maskPhone, SharedLimitHit, smsLimitsFromEnv, SmsLimits, SmsLimitScope, takeSmsQuota } from './sms-limits';
import { firstInWindow, humanLeft, opensAtMsk } from './limit-alert';
import { sendTelegramAlert } from '../common/telegram-alert';

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

/**
 * Номера из SMS_AERO_SKIP_PHONES: код кладётся в Redis, SMS Aero не зовётся.
 * Это тестовые номера смоука и playwright (см. sendSms), настоящей отправки
 * по ним нет — и лимиты отправки на них не распространяются.
 */
function aeroSkipList(): string[] {
  return (process.env.SMS_AERO_SKIP_PHONES || '').split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Состояние аккаунта и «известен ли номер» — одним запросом.
 *
 * Известный — есть аккаунт с этим основным телефоном или телефонный способ
 * входа (UNIQUE(provider, provider_sub) — точечный поиск). Такие номера
 * считаются в своём общем счётчике (sms-limits.ts). Ровно одна строка при
 * любом исходе: LATERAL отдаёт state первого аккаунта, как прежний
 * `SELECT state … LIMIT 1`, и один проход по user_id вместо двух.
 */
const PHONE_STATE_SQL = `
  SELECT u.state,
         (u.internal_id IS NOT NULL OR EXISTS (
            SELECT 1 FROM user_identities i WHERE i.provider = 'phone' AND i.provider_sub = $1
         )) AS known
    FROM (SELECT 1) AS one
    LEFT JOIN LATERAL (
      SELECT state, internal_id FROM user_id WHERE primary_phone = $1 LIMIT 1
    ) u ON true`;

/** Что означает для людей закрытый общий счётчик — строка алерта владельцу. */
const SHARED_LIMIT_EFFECT: Partial<Record<SmsLimitScope, string>> = {
  global_hour: 'Новым номерам SMS не уходят, клиенту отвечаем как при успехе.',
  global_day: 'Новым номерам SMS не уходят, клиенту отвечаем как при успехе.',
  intl_hour: 'Новым номерам не на +7 SMS не уходят, клиенту отвечаем как при успехе.',
  intl_day: 'Новым номерам не на +7 SMS не уходят, клиенту отвечаем как при успехе.',
  known_hour: 'Зарегистрированным номерам — отказ 429 «слишком часто».',
  known_day: 'Зарегистрированным номерам — отказ 429 «слишком часто».',
};

export type SmsRequestResult =
  /** suppressed — новому номеру закрыт общий потолок: клиенту отвечаем как при sent. */
  | { status: 'sent' | 'exists' | 'blocked' | 'invalid_phone' | 'suppressed' }
  | { status: 'rate_limited'; scope: SmsLimitScope; retryAfterSec: number };

export type CheckCodeResult =
  | { status: 'ok'; tokens: { 'access-token': string; 'refresh-token': string; 'is-new-user': boolean } }
  | { status: 'invalid' | 'too_many_attempts' };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Неверные SMS_LIMIT_* уже названы в логе — не повторять на каждой SMS. */
  private readonly reportedLimitEnv = new Set<string>();

  constructor(
    private readonly pg: PgService,
    private readonly redis: RedisService,
    private readonly jwtSvc: JwtService,
    private readonly identity: IdentityService,
    @Optional() private readonly events?: EventsService,
  ) {}

  async requestSmsCode(phone: string, sid?: string | null, src?: string | null, opts?: { suppressSms?: boolean; lang?: string | null }): Promise<SmsRequestResult> {
    // Номер из адреса запроса — что угодно. Мусор не доходит ни до Redis,
    // ни до SMS Aero.
    if (!isSmsPhone(phone)) return { status: 'invalid_phone' };

    // Check if code already exists in Redis
    const existing = await this.redis.get(smsCodeKey(phone));
    if (existing) {
      this.logger.log(`Code already exists for ${phone}, skipping resend`);
      return { status: 'exists' };
    }

    // Состояние аккаунта и «известен ли номер» — одним запросом.
    const userRes = await this.pg.query(PHONE_STATE_SQL, [phone]);
    const account = userRes.rows[0] || {};
    if (account.state === 'blocked') {
      return { status: 'blocked' };
    }
    const known = account.known === true;

    // Решаем, глушить ли реальную SMS. Только при DEBUG_SMS_CODES=true:
    //  • чисто служебные номера — всегда глушим (код в Redis);
    //  • «двойной» номер владельца (79656445804) — глушим ТОЛЬКО если вызов
    //    помечен автоматическим (suppressSms=?nosms=1); обычный вход шлёт SMS.
    const debug = process.env.DEBUG_SMS_CODES === 'true';
    const isPureTest = PURE_TEST_PHONES.includes(phone) || PURE_TEST_PATTERN.test(phone);
    const isDevDual = DEV_DUAL_PHONES.includes(phone);
    const skipSms = debug && (isPureTest || (isDevDual && !!opts?.suppressSms));

    // Лимиты — только на настоящие отправки (sms-limits.ts). Тестовые номера
    // смоук запрашивает по 4–6 раз за выкат, их лимит не касается. Квоту
    // берём до записи кода: при отказе нет ни кода, ни SMS.
    if (!skipSms && !aeroSkipList().includes(phone)) {
      const verdict = await takeSmsQuota(this.redis, phone, known, this.smsLimits());
      if (verdict.kind !== 'ok') await this.reportSharedLimits(verdict.shared);
      if (verdict.kind === 'limited') {
        return this.refuseOverLimit(phone, verdict.scope, verdict.retryAfterSec);
      }
      if (verdict.kind === 'suppressed') {
        // Новому номеру закрыт общий потолок. Ответ — как при успехе: 429
        // здесь выдал бы, что номер не зарегистрирован. Ни кода, ни SMS.
        return { status: 'suppressed' };
      }
    }

    // Шестизначный код из криптостойкого генератора: Math.random для кода
    // входа не годится.
    const code = String(randomInt(100000, 1000000));

    // Новый код — новый счётчик неверных попыток (см. sms-code.ts). Счётчик
    // сбрасываем до записи кода: пока кода нет, попытки не считаются.
    await this.redis.del(smsAttemptsKey(phone));
    await this.redis.set(smsCodeKey(phone), code, SMS_CODE_TTL_SECONDS);

    if (skipSms) {
      this.logger.log(`Phone ${phone}: SMSAERO skipped (${isPureTest ? 'pure-test' : 'dev-dual+nosms'}), code in Redis`);
    } else {
      // SMS Aero — без ожидания. Ответ клиенту от него и раньше не зависел
      // (sendSms сам ловит и логирует свои ошибки), а ожидание в сотни мс
      // отличало бы настоящую отправку от подавленной по времени ответа.
      void this.sendSms(phone, code, opts?.lang).catch((e) =>
        this.logger.error(`SMS send failed: ${(e as Error)?.message}`),
      );
    }
    const isTest = skipSms; // for the otp_request event's `sent` flag below

    // sid/src прокидываются с фронта (?sid=&src=) — чтобы шаг регистрации был
    // привязан к рекламной сессии и источнику (раньше otp_* шли без атрибуции,
    // и пост-клик воронка была слепой).
    this.events?.track('otp_request', { userId: phone, sessionId: sid || null, source: src || null, props: { channel: 'sms', sent: !isTest } });

    return { status: 'sent' };
  }

  /** Пороги лимитов SMS: умолчания из sms-limits.ts, поверх них — env. */
  private smsLimits(): SmsLimits {
    const { limits, ignored } = smsLimitsFromEnv();
    for (const bad of ignored) {
      if (this.reportedLimitEnv.has(bad)) continue;
      this.reportedLimitEnv.add(bad);
      this.logger.warn(`${bad}: нужно целое больше нуля — действует значение по умолчанию`);
    }
    return limits;
  }

  /**
   * Отказ 429. Лимит самого номера — warn (номер — последние четыре цифры) и
   * событие на каждый отказ. `known` — общий счётчик: о нём уже сообщено раз
   * за окно в reportSharedLimits, повторять на каждом отказе незачем.
   */
  private refuseOverLimit(phone: string, scope: SmsLimitScope, retryAfterSec: number): SmsRequestResult {
    if (scope.startsWith('phone_')) {
      this.logger.warn(`SMS limit ${scope} hit for ${maskPhone(phone)}, retry in ${retryAfterSec}s`);
      this.events?.track('sms_limit_hit', { userId: phone, props: { scope } });
    }
    return { status: 'rate_limited', scope, retryAfterSec };
  }

  /**
   * Заполненные общие счётчики (global, intl, known): error в лог, событие и
   * Telegram владельцу — раз за окно на счётчик, а не на каждый отказ (при
   * накрутке отказов сотни в минуту). Номеров в сигнале нет: он про счётчик,
   * а не про того, кто первым в него упёрся.
   */
  private async reportSharedLimits(hits: SharedLimitHit[]): Promise<void> {
    for (const hit of hits) {
      let first: boolean;
      try {
        first = await firstInWindow(this.redis, hit.alertKey, hit.windowLeftMs);
      } catch (e) {
        // Сигнал — не повод сорвать ответ: отказ или «успех» клиенту уже решены.
        this.logger.warn(`SMS limit ${hit.scope}: отметка алерта не записана: ${(e as Error)?.message}`);
        continue;
      }
      if (!first) continue;
      const window = hit.scope.endsWith('_hour') ? 'час' : 'сутки';
      const left = humanLeft(hit.windowLeftMs);
      const until = opensAtMsk(hit.windowLeftMs);
      this.logger.error(
        `SMS limit ${hit.scope} reached (${hit.max} в ${window}) — закрыт ещё ${left}, до ${until}; похоже на накрутку`,
      );
      this.events?.track('sms_limit_hit', { props: { scope: hit.scope } });
      void sendTelegramAlert(
        `<b>Linkeon: исчерпан общий лимит SMS</b>\n` +
          `Счётчик: <b>${hit.scope}</b> — ${hit.max} в ${window}\n` +
          `${SHARED_LIMIT_EFFECT[hit.scope] ?? ''}\n` +
          `Откроется через ${left}, в ${until}.\n` +
          `Похоже на накрутку. Снять вручную — CLAUDE.md бэкенда, «Auth».`,
      ).catch(() => undefined);
    }
  }

  /**
   * Текст SMS на языке интерфейса пользователя.
   *
   * Раньше он был только русским, и после перехода на международный ввод
   * телефона немец или испанец получал бы «Код 1234 для входа в linkeon.io».
   * Язык приходит query-параметром от формы входа: профиля на этот момент
   * ещё нет, читать язык неоткуда.
   *
   * Последняя строка — WebOTP-маркер (`@<hostname> #<code>`), формат строгий
   * и от языка не зависит: по нему Chrome Android и Safari iOS подставляют
   * код в форму автоматически.
   */
  private smsText(code: string, lang?: string | null): string {
    const line: Record<string, string> = {
      ru: `Код ${code} для входа в linkeon.io`,
      en: `${code} is your linkeon.io login code`,
      es: `${code} es tu codigo de acceso a linkeon.io`,
      de: `${code} ist dein Login-Code fur linkeon.io`,
      fr: `${code} est ton code de connexion a linkeon.io`,
      zh: `${code} 是你的 linkeon.io 登录验证码`,
    };
    const root = String(lang ?? '').toLowerCase().split(/[-_]/)[0];
    return `${line[root] ?? line.ru}\n@my.linkeon.io #${code}`;
  }

  private async sendSms(phone: string, code: string, lang?: string | null): Promise<void> {
    // Telegram-like skip-list для тестовых телефонов: smoke/playwright за двухфазный
    // деплой дёргают /sms/:phone 4-6 раз, SMS Aero отбивает 400 (blacklist) — забивает
    // логи и расходует rate-limit. Код всё равно лежит в Redis (sendCode), так что
    // /webhook/debug/sms-code/:phone и smoke-чек работают как раньше.
    if (aeroSkipList().includes(phone)) {
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
          text: this.smsText(code, lang),
          // Sender signature. Default 'SMSAero' is the shared demo signature — some carriers
          // drop or deprioritize it, so part of the OTPs don't arrive (B1). Once a branded
          // signature is registered+approved in the SMSAERO account, set SMSAERO_SIGN=<approved>
          // in prod env to switch it on with no code change. Do NOT set it to an unapproved
          // signature — SMSAERO rejects (400) unregistered signs.
          sign: process.env.SMSAERO_SIGN || 'SMSAero',
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

  /**
   * Сверить код из SMS (вход и привязка телефона). Лимит неверных попыток и
   * погашение кода — в sms-code.ts.
   */
  async verifySmsCode(phone: string, code: string): Promise<SmsCodeCheck> {
    return verifySmsCode(this.redis, phone, code);
  }

  async checkCode(phone: string, code: string, sid?: string | null, src?: string | null): Promise<CheckCodeResult> {
    const check = await this.verifySmsCode(phone, code);
    if (check !== 'ok') return { status: check };

    // IdentityService is the single point that emits signup_completed and
    // auth_succeeded — covers SMS, Google, Yandex, email magic-link. Here
    // we only emit the SMS-specific otp_verified.
    // Телефонный вход кандидата на привязку не порождает: link_required
    // возвращается только для провайдеров с подтверждённой почтой.
    const r = await this.identity.resolveOrCreate('phone', { phone });
    if (r.status !== 'ok') throw new Error(`resolveOrCreate('phone') вернул ${r.status}`);
    const { userId, isNew } = r;

    this.events?.track('otp_verified', { userId, sessionId: sid || null, source: src || null, props: { channel: 'sms' } });

    return {
      status: 'ok',
      tokens: {
        'access-token': this.jwtSvc.signAccess(userId),
        'refresh-token': this.jwtSvc.signRefresh(userId),
        // Для фронта: фиксируем регистрацию в VK-пикселе (goal=registration)
        // только для НОВОГО пользователя, не на каждый вход.
        'is-new-user': isNew,
      },
    };
  }

  async getDebugCode(phone: string): Promise<string | null> {
    return this.redis.get(smsCodeKey(phone));
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

    // Через процедуру: ручная правка баланса тоже должна оставлять след, иначе
    // токены у пользователя появляются или пропадают без объяснения. delta может
    // быть отрицательной — add_user_tokens не даст уйти ниже нуля.
    await this.pg.query(
      `SELECT add_user_tokens($1, $2, 'adjustment', $3, NULL)`,
      [phone, delta, 'Корректировка администратором'],
    );

    const balanceAfter = balanceBefore + delta;
    return { phone, balance_before: balanceBefore, balance_after: balanceAfter };
  }

  /// Помечен ли аккаунт удалённым.
  ///
  /// Ошибку базы трактуем как «не удалён»: недоступный Postgres не должен
  /// разлогинивать всех живых пользователей разом.
  private async isDeleted(userId: string): Promise<boolean> {
    if (!this.pg) return false;
    try {
      const r = await this.pg.query(
        `SELECT state FROM user_id WHERE internal_id = $1`,
        [userId],
      );
      return r.rows[0]?.state === 'deleted';
    } catch {
      return false;
    }
  }

  async refreshTokens(
    refreshToken: string,
  ): Promise<{ 'access-token': string; 'refresh-token': string; userId: string } | null> {
    try {
      const payload = this.jwtSvc.verify(refreshToken);
      if (payload.type !== 'refresh') return null;
      const userId: string = payload.userId ?? payload.sub;
      // Удалённый аккаунт не продлеваем. Связки входа удаление рвёт, но на
      // руках у клиента остаётся выданный раньше refresh-токен, и без этой
      // проверки он молча воскрешал бы доступ до самого истечения срока.
      if (await this.isDeleted(userId)) return null;
      return {
        'access-token': this.jwtSvc.signAccess(userId),
        'refresh-token': this.jwtSvc.signRefresh(userId),
        userId,
      };
    } catch {
      return null;
    }
  }
}
