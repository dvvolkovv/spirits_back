import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Верхняя граница ожидания отправки. Та же переменная, что у EmailService:
 * SMTP один, и разъезжающиеся таймауты у двух отправителей — источник загадок.
 */
const SEND_TIMEOUT_MS = parseInt(process.env.SMTP_SEND_TIMEOUT_MS || '12000', 10);

export interface MailResult {
  ok: boolean;
  error?: string;
}

/**
 * Отправка писем для фоновых уведомлений (не для авторизации — там свой
 * EmailService, который обязан пробрасывать ошибку в HTTP-ответ).
 *
 * Контракт: send() НИКОГДА не бросает и не висит дольше SEND_TIMEOUT_MS.
 * Уведомление прицеплено к чужому действию (ответ поддержки, рассылка), и
 * упавший SMTP не должен утаскивать это действие за собой.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private readonly from = process.env.EMAIL_FROM || 'noreply@linkeon.io';

  constructor() {
    const host = process.env.SMTP_HOST;
    if (!host) {
      this.logger.warn('SMTP не настроен — фоновые письма отправляться не будут');
      return;
    }
    this.transporter = nodemailer.createTransport({
      host,
      port: parseInt(process.env.SMTP_PORT || '25'),
      secure: false,
      tls: { rejectUnauthorized: false },
      connectionTimeout: 7000,
      greetingTimeout: 7000,
      socketTimeout: 10000,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.transporter);
  }

  async send(to: string, subject: string, html: string): Promise<MailResult> {
    if (!this.transporter) return { ok: false, error: 'smtp_not_configured' };

    let timer: NodeJS.Timeout | undefined;
    try {
      // Таймауты транспорта покрывают соединение и сокет, но не гарантируют,
      // что промис вообще завершится — наблюдалось на test.linkeon.io.
      await Promise.race([
        this.transporter.sendMail({ from: this.from, to, subject, html }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`SMTP timeout: письмо на ${to} не ушло за ${SEND_TIMEOUT_MS} мс`)),
            SEND_TIMEOUT_MS,
          );
        }),
      ]);
      return { ok: true };
    } catch (e: any) {
      const error = String(e?.message || 'smtp error').slice(0, 200);
      this.logger.warn(`письмо на ${to} не ушло: ${error}`);
      return { ok: false, error };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
