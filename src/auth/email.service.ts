import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
import { RedisService } from '../common/services/redis.service';
import { PgService } from '../common/services/pg.service';

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

  async checkRateLimit(email: string, ip: string): Promise<{ ok: true } | { ok: false; reason: 'per_email' | 'per_ip' }> {
    if (!this.redis) return { ok: true };
    const perEmail = await this.redis.get(`ml-rate-${email}`);
    if (perEmail) return { ok: false, reason: 'per_email' };
    await this.redis.set(`ml-rate-${email}`, '1', 60);
    const ipCount = parseInt((await this.redis.get(`ml-rate-ip-${ip}`)) || '0', 10);
    if (ipCount >= 10) return { ok: false, reason: 'per_ip' };
    await this.redis.set(`ml-rate-ip-${ip}`, String(ipCount + 1), 600);
    return { ok: true };
  }

  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, 12);
  }

  async verifyPassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
