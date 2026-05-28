import { Injectable, Logger, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as bcrypt from 'bcryptjs';
import * as nodemailer from 'nodemailer';
import { RedisService } from '../common/services/redis.service';
import { PgService } from '../common/services/pg.service';

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
        ignoreTLS: false,
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

  async sendMagicLink(email: string, token: string): Promise<void> {
    const url = `${process.env.PUBLIC_BASE_URL || 'https://my.linkeon.io'}/webhook/auth/email/confirm?token=${token}`;
    if (!this.transporter) {
      this.logger.warn(`SMTP not configured. Magic-link for ${email}: ${url}`);
      return;
    }
    await this.transporter.sendMail({
      from: this.fromAddress,
      to: email,
      subject: 'Вход в linkeon.io',
      html: `
        <p>Чтобы войти в linkeon.io, кликни по этой ссылке:</p>
        <p><a href="${url}">${url}</a></p>
        <p>Ссылка действует 10 минут. Если ты не запрашивал вход — просто игнорируй это письмо.</p>
      `,
    });
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
