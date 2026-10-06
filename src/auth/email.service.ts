import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
import { RedisService } from '../common/services/redis.service';
import { PgService } from '../common/services/pg.service';
import { sendTelegramAlert } from '../common/telegram-alert';
import { limitsFromEnv, QuotaRule, takeQuota } from './quota';
import { firstInWindow, humanLeft, opensAtMsk } from './limit-alert';

/** Лимиты писем со ссылкой входа, окно — 10 минут. Плюс минута между письмами на ящик. */
export interface MagicLinkLimits {
  /** Писем на один ящик (mailboxKey) за 10 минут. */
  perAddress: number;
  /** Писем на все адреса за 10 минут. */
  global: number;
}

/**
 * Пороги по умолчанию. Живой человек запрашивает ссылку раз-два; три за
 * 10 минут на ящик — с запасом. Общий потолок — 60 за 10 минут: в разы выше
 * живого потока и в шесть раз выше прежнего «10 на всех», который на проде
 * был общим из-за прокси. Поднять — EMAIL_LIMIT_* в .env и перезапуск.
 */
export const MAGIC_LINK_LIMIT_DEFAULTS: Readonly<MagicLinkLimits> = Object.freeze({ perAddress: 3, global: 60 });

export const MAGIC_LINK_LIMIT_ENV: Readonly<Record<keyof MagicLinkLimits, string>> = Object.freeze({
  perAddress: 'EMAIL_LIMIT_PER_ADDRESS_10MIN',
  global: 'EMAIL_LIMIT_GLOBAL_10MIN',
});

export type MagicLinkQuota =
  | { kind: 'ok' }
  | { kind: 'limited'; retryAfterSec: number }
  | { kind: 'suppressed' };

const YANDEX_DOMAINS = new Set(['yandex.ru', 'ya.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'yandex.ua']);

/**
 * Ящик, в который на самом деле придёт письмо, — ключ счёта писем.
 *
 * Иначе один ящик забрасывается письмами через синонимы адреса: метка после
 * «+» (почти все почтовые службы доставляют её в тот же ящик), точки в
 * логине Gmail и googlemail.com, домены-синонимы Яндекса, где точка и дефис
 * в логине равнозначны. Только для счёта: адрес входа не меняется.
 */
export function mailboxKey(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0];
  let domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  if (YANDEX_DOMAINS.has(domain)) {
    domain = 'yandex.ru';
    local = local.replace(/\./g, '-');
  }
  return `${local}@${domain}`;
}

/**
 * Верхняя граница ожидания отправки письма на уровне сервиса.
 * Настраивается переменной окружения — чтобы тест не ждал реальные 12 секунд
 * и не зависел от загруженности машины.
 */
const SEND_TIMEOUT_MS = parseInt(process.env.SMTP_SEND_TIMEOUT_MS || '12000', 10);

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private tempmailDomains: Set<string>;
  private transporter: nodemailer.Transporter | null = null;
  private readonly fromAddress = process.env.EMAIL_FROM || 'noreply@linkeon.io';
  /** Неверные EMAIL_LIMIT_* уже названы в логе — не повторять на каждом письме. */
  private readonly reportedLimitEnv = new Set<string>();

  constructor(
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly pg?: PgService,
  ) {
    this.tempmailDomains = this.loadTempmailDomains();
    const smtpHost = process.env.SMTP_HOST;
    if (smtpHost) {
      this.transporter = nodemailer.createTransport({
        host: smtpHost,
        port: parseInt(process.env.SMTP_PORT || '25'),
        secure: false,
        tls: { rejectUnauthorized: false },
        // Умолчания nodemailer здесь неприемлемы: 2 минуты на соединение и
        // 10 минут на сокет. Ответ на POST /webhook/auth/email/request ждёт
        // отправки, поэтому недоступный SMTP превращался в вечный спиннер на
        // экране входа — ни успеха, ни ошибки (инцидент 2026-08-07).
        connectionTimeout: 7000,
        greetingTimeout: 7000,
        socketTimeout: 10000,
      });
    }
  }

  private loadTempmailDomains(): Set<string> {
    const candidates = [
      path.join(__dirname, '..', 'identity', 'tempmail-domains.json'),
      path.join(__dirname, '..', '..', 'src', 'identity', 'tempmail-domains.json'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) return new Set(JSON.parse(fs.readFileSync(p, 'utf8')));
      } catch {}
    }
    this.logger.warn('tempmail-domains.json not found, blocking disabled');
    return new Set();
  }

  isTempmail(email: string): boolean {
    const domain = email.toLowerCase().split('@')[1] || '';
    return this.tempmailDomains.has(domain);
  }

  async generateMagicToken(email: string): Promise<string> {
    if (!this.redis) throw new Error('redis not configured');
    const token = crypto.randomBytes(32).toString('base64url');
    await this.redis.set(`ml-${token}`, email, 600);
    return token;
  }

  async consumeMagicToken(token: string): Promise<string | null> {
    if (!this.redis) return null;
    const email = await this.redis.get(`ml-${token}`);
    if (!email) return null;
    await this.redis.del(`ml-${token}`);
    return email;
  }

  /**
   * Токен подтверждения анкетной почты.
   *
   * Отдельно от magic-link (`ml-`) по трём причинам, и ни одна не косметическая:
   * внутри лежит userId (magic-link знает только адрес), жить он обязан дольше
   * десяти минут — письмо после оплаты читают когда доберутся, — и перепутать
   * их нельзя: magic-link ВПУСКАЕТ в аккаунт, а этот только добавляет способ
   * входа тому, кто уже был авторизован, когда его запрашивал.
   */
  async generateVerifyToken(userId: string, email: string): Promise<string> {
    if (!this.redis) throw new Error('redis not configured');
    const token = crypto.randomBytes(32).toString('base64url');
    await this.redis.set(`ev-${token}`, JSON.stringify({ userId, email }), 86400);
    return token;
  }

  /**
   * Не слали ли мы уже такое письмо этому человеку на этот адрес.
   *
   * Подтверждение цепляется к оплате, а оплату повторяют: без заслонки три
   * покупки подряд до подтверждения дали бы три одинаковых письма. Окно равно
   * сроку жизни токена — пока старая ссылка рабочая, новая не нужна.
   *
   * Ключ по паре (userId, адрес), а не по одному адресу: разные люди вправе
   * указывать разную почту, и заслонка одного не должна глушить другого.
   */
  async verifyAlreadyOffered(userId: string, email: string): Promise<boolean> {
    if (!this.redis) return false;
    const key = `ev-sent-${userId}-${crypto.createHash('sha256').update(email).digest('hex').slice(0, 16)}`;
    if (await this.redis.get(key)) return true;
    await this.redis.set(key, '1', 86400);
    return false;
  }

  async consumeVerifyToken(token: string): Promise<{ userId: string; email: string } | null> {
    if (!this.redis || !token) return null;
    const raw = await this.redis.get(`ev-${token}`);
    if (!raw) return null;
    await this.redis.del(`ev-${token}`);
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async sendVerifyEmail(email: string, token: string): Promise<void> {
    const url = `${process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io'}/webhook/auth/email/verify?token=${token}`;
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured. Verify-link for ${email}: ${url}`);
      return;
    }
    const send = this.transporter.sendMail({
      from: this.fromAddress,
      to: email,
      subject: 'Подтвердите почту для входа в linkeon.io',
      html: `
        <p>Вы указали этот адрес в linkeon.io. Подтвердите его — и сможете входить по почте,
           а не только по номеру телефона:</p>
        <p><a href="${url}">${url}</a></p>
        <p>Ссылка действует сутки. Аккаунт останется прежним — почта просто станет вторым
           способом входа в него, со всей историей и балансом.</p>
        <p>Если вы этого не делали — просто игнорируйте письмо, ничего не изменится.</p>
      `,
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        send,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`SMTP timeout: письмо на ${email} не ушло за ${SEND_TIMEOUT_MS} мс`)),
            SEND_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    this.logger.log(`verify-link sent to ${email}`);
  }

  async sendMagicLink(email: string, token: string): Promise<void> {
    const url = `${process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io'}/webhook/auth/email/confirm?token=${token}`;
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured. Magic-link for ${email}: ${url}`);
      return;
    }
    // Жёсткий предохранитель поверх таймаутов транспорта: они покрывают
    // соединение и сокет, но не гарантируют, что промис вообще завершится
    // (наблюдалось на test.linkeon.io — 40+ секунд без ответа). Здесь мы
    // гарантируем верхнюю границу ожидания на уровне сервиса.
    const send = this.transporter.sendMail({
      from: this.fromAddress,
      to: email,
      subject: 'Вход в linkeon.io',
      html: `
        <p>Чтобы войти в linkeon.io, кликни по этой ссылке:</p>
        <p><a href="${url}">${url}</a></p>
        <p>Ссылка действует 10 минут. Если ты не запрашивал вход — просто игнорируй это письмо.</p>
      `,
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        send,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`SMTP timeout: письмо на ${email} не ушло за ${SEND_TIMEOUT_MS} мс`)),
            SEND_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    this.logger.log(`magic-link sent to ${email}`);
  }

  /**
   * Квота на письмо со ссылкой входа. Проверка и учёт — один Lua-скрипт
   * (quota.ts): отказ ничего не считает.
   *
   * Раньше второй счётчик шёл по первому адресу из X-Forwarded-For, а на проде
   * за прокси Selectel там у всех 127.0.0.1 — «10 писем за 10 минут» было
   * общим потолком на весь вход по почте. Теперь счёт по ящику (mailboxKey):
   * не чаще раза в минуту и не больше трёх за 10 минут — против забрасывания
   * одного ящика. Плюс общий потолок повыше — против рассылки по чужим
   * адресам.
   *
   * `limited` — 429 (своя квота ящика). `suppressed` — общий потолок: ответ как
   * при успехе, но письма нет; о закрытом потолке — раз за окно в лог и
   * Telegram владельцу.
   */
  async takeSendQuota(email: string): Promise<MagicLinkQuota> {
    if (!this.redis) return { kind: 'ok' };
    const { limits, ignored } = limitsFromEnv(MAGIC_LINK_LIMIT_DEFAULTS, MAGIC_LINK_LIMIT_ENV);
    for (const bad of ignored) {
      if (this.reportedLimitEnv.has(bad)) continue;
      this.reportedLimitEnv.add(bad);
      this.logger.warn(`${bad}: нужно целое больше нуля — действует значение по умолчанию`);
    }
    const box = mailboxKey(email);
    const rules: QuotaRule[] = [
      { key: `ml-rate-addr:${box}:gap`, max: 1, windowSec: 60 },
      { key: `ml-rate-addr:${box}:10m`, max: limits.perAddress, windowSec: 600 },
      { key: 'ml-rate-global:10m', max: limits.global, windowSec: 600 },
    ];
    const reply = await takeQuota(this.redis, rules);
    if (reply.counted) return { kind: 'ok' };

    const [gapLeft, boxLeft, globalLeft] = reply.leftMs;
    if (globalLeft >= 0) await this.reportGlobalLimit(globalLeft, limits.global);
    // Своя квота ящика старше общей — как у SMS: сначала то, что зависит от
    // самого адреса.
    const ownLeft = Math.max(gapLeft, boxLeft);
    if (ownLeft >= 0) return { kind: 'limited', retryAfterSec: Math.max(1, Math.ceil(ownLeft / 1000)) };
    return { kind: 'suppressed' };
  }

  /** Общий потолок писем закрыт: error и Telegram — раз за окно, без адресов. */
  private async reportGlobalLimit(windowLeftMs: number, max: number): Promise<void> {
    try {
      if (!(await firstInWindow(this.redis!, 'ml-rate-alerted:global:10m', windowLeftMs))) return;
    } catch (e) {
      this.logger.warn(`magic-link limit: отметка алерта не записана: ${(e as Error)?.message}`);
      return;
    }
    const left = humanLeft(windowLeftMs);
    const until = opensAtMsk(windowLeftMs);
    this.logger.error(`magic-link limit global reached (${max} за 10 мин) — закрыт ещё ${left}, до ${until}; похоже на накрутку`);
    void sendTelegramAlert(
      `<b>Linkeon: исчерпан общий лимит писем входа</b>\n` +
        `${max} писем за 10 минут. Письма со ссылкой входа не уходят, клиенту отвечаем как при успехе.\n` +
        `Откроется через ${left}, в ${until}.\n` +
        `Похоже на накрутку. Снять вручную — CLAUDE.md бэкенда, «Auth».`,
    ).catch(() => undefined);
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
