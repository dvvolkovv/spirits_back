import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { MailService } from '../common/services/mail.service';
import { PgService } from '../common/services/pg.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
import { buildRetentionEmail, buildRetentionSmsMessage, retentionChatUrl } from './retention-mail';
import { selectRetentionChannel } from './retention-recipient';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { CURIOUS_SEGMENT_SQL, GENERAL_SEGMENT_SQL } from './retention-sql';
import type {
  RetentionDraft,
  RetentionMode,
  RetentionPreview,
  RetentionResultRow,
  RetentionSendRequest,
  RetentionSendResponse,
} from './retention.types';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';

export const RETENTION_CAMPAIGN = 'retention_reengage_v1';
export const CURIOUS_CAMPAIGN = 'curious_return_v1';
export const RETENTION_COOLDOWN_DAYS = 14;

interface RetentionSegmentResult {
  preview: RetentionPreview;
  suppressed: Map<string, { phone: string | null }>;
}

@Injectable()
export class RetentionService {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    private readonly pg: PgService,
    private readonly recipients: RetentionRecipientResolver,
    private readonly unsubscribes: RetentionUnsubscribeService,
    private readonly mail: MailService,
  ) {}

  async buildRetentionOutreach(opts?: { minDays?: number; maxDays?: number }): Promise<RetentionPreview> {
    return (await this.buildGeneralSegment(opts)).preview;
  }

  async buildCuriousReturnOutreach(): Promise<RetentionPreview> {
    return (await this.buildCuriousSegment()).preview;
  }

  private async buildGeneralSegment(opts?: { minDays?: number; maxDays?: number }): Promise<RetentionSegmentResult> {
    const minDays = opts?.minDays ?? 3;
    const maxDays = opts?.maxDays ?? 30;
    const seg = await this.pg.query(GENERAL_SEGMENT_SQL, [TEST_USERS, TEST_USER_PATTERN, minDays, maxDays]);
    return this.buildPreview(seg.rows, 'general', { min_days: minDays, max_days: maxDays });
  }

  private async buildCuriousSegment(): Promise<RetentionSegmentResult> {
    const seg = await this.pg.query(CURIOUS_SEGMENT_SQL, [TEST_USERS, TEST_USER_PATTERN]);
    return this.buildPreview(seg.rows, 'curious', { min_hours: 24, max_hours: 48 });
  }

  private async buildPreview(rows: any[], mode: RetentionMode, window: RetentionPreview['window']): Promise<RetentionSegmentResult> {
    const campaign = mode === 'general' ? RETENTION_CAMPAIGN : CURIOUS_CAMPAIGN;
    const ids = rows.map((r) => r.user_id);
    const contacts = await this.recipients.resolve(ids);
    const activeIds = ids.filter((id) => !contacts.get(id)?.unsubscribed);
    const lastSent = new Map<string, Date | string>();
    if (activeIds.length) {
      const curious = mode === 'curious';
      const sent = await this.pg.query(
        `SELECT user_id, max(ts) AS last_sent_at FROM events
          WHERE name='retention_outreach' AND user_id=ANY($1::text[])
            AND props->>'status'='sent'
            ${curious ? `AND props->>'campaign'=$2` : ''}
          GROUP BY user_id`,
        curious ? [activeIds, campaign] : [activeIds],
      );
      for (const row of sent.rows) lastSent.set(row.user_id, row.last_sent_at);
    }

    const drafts: RetentionDraft[] = [];
    const suppressed = new Map<string, { phone: string | null }>();
    for (const row of rows) {
      const contact = contacts.get(row.user_id) || {
        userId: row.user_id, email: null, phone: null, language: 'ru', unsubscribed: false,
      };
      if (contact.unsubscribed) {
        suppressed.set(row.user_id, { phone: contact.phone });
        continue;
      }
      const channel = selectRetentionChannel(contact);
      const mail = channel === 'email' ? buildRetentionEmail({
        mode, language: contact.language, assistantName: row.assistant_name,
        chatUrl: retentionChatUrl(contact.language), unsubscribeUrl: null,
      }) : null;
      const lastSentAt = lastSent.get(row.user_id) || null;
      const inCooldown = lastSentAt
        ? Date.now() - new Date(lastSentAt).getTime() < RETENTION_COOLDOWN_DAYS * 864e5
        : false;
      drafts.push({
        user_id: row.user_id,
        phone: contact.phone,
        email: contact.email,
        channel,
        language: contact.language,
        subject: mail?.subject || null,
        message: mail?.text || (channel === 'sms' ? buildRetentionSmsMessage(mode, row.assistant_name) : ''),
        assistant_id: row.assistant_id,
        assistant_name: row.assistant_name || null,
        last_at: row.last_at,
        ...(mode === 'general' ? { days_inactive: row.days_inactive } : { hours_inactive: row.hours_inactive }),
        last_sent_at: lastSentAt,
        in_cooldown: inCooldown,
      });
    }

    return {
      preview: {
        channel: 'mixed', campaign, window, cooldown_days: RETENTION_COOLDOWN_DAYS,
        count: drafts.length,
        summary: {
          email: drafts.filter((d) => d.channel === 'email').length,
          sms: drafts.filter((d) => d.channel === 'sms').length,
          no_channel: drafts.filter((d) => d.channel === 'no_channel').length,
          skipped_unsubscribed: suppressed.size,
        },
        drafts,
      },
      suppressed,
    };
  }

  async sendRetentionOutreach(data: RetentionSendRequest): Promise<RetentionSendResponse> {
    return this.send('general', data);
  }

  async sendCuriousReturnOutreach(data: RetentionSendRequest): Promise<RetentionSendResponse> {
    return this.send('curious', data);
  }

  private async send(mode: RetentionMode, data: RetentionSendRequest): Promise<RetentionSendResponse> {
    if (data?.confirm !== true) {
      return { error: 'confirm_required', message: 'Отправка реальным пользователям требует confirm:true (подтверждение владельца).' };
    }
    const allowResend = data.resend === true;
    const hasUsers = Object.prototype.hasOwnProperty.call(data, 'userIds');
    const hasPhones = Object.prototype.hasOwnProperty.call(data, 'phones');
    if (hasUsers && hasPhones) {
      return { error: 'ambiguous_recipient_filter', message: 'Передайте либо userIds[], либо phones[], но не оба фильтра.' };
    }
    const validRecipientFilter = (value: unknown): value is string[] =>
      Array.isArray(value) && value.length > 0 &&
      value.every((entry) => typeof entry === 'string' && entry.length > 0);
    if ((hasUsers && !validRecipientFilter(data.userIds)) || (hasPhones && !validRecipientFilter(data.phones))) {
      return { error: 'invalid_recipient_filter', message: 'Фильтр получателей должен быть непустым массивом непустых строк.' };
    }
    const segment = mode === 'general'
      ? await this.buildGeneralSegment({ minDays: data.minDays, maxDays: data.maxDays })
      : await this.buildCuriousSegment();
    const { preview, suppressed } = segment;
    let selected = preview.drafts;
    const userFilter = hasUsers ? new Set(data.userIds!) : null;
    const phoneFilter = hasPhones ? new Set(data.phones!) : null;
    if (userFilter) {
      selected = selected.filter((d) => userFilter.has(d.user_id));
    } else if (phoneFilter) {
      selected = selected.filter((d) => phoneFilter.has(d.user_id) || (d.phone ? phoneFilter.has(d.phone) : false));
    }

    const skippedCooldown = allowResend ? 0 : selected.filter((d) => d.channel !== 'no_channel' && d.in_cooldown).length;
    const noChannel = selected.filter((d) => d.channel === 'no_channel').length;
    const targets = selected.filter((d) => d.channel !== 'no_channel' && (allowResend || !d.in_cooldown));
    const results: RetentionResultRow[] = [];
    let skippedUnsubscribed = 0;
    for (const [userId, contact] of suppressed) {
      const isSelected = userFilter
        ? userFilter.has(userId)
        : phoneFilter
          ? phoneFilter.has(userId) || (contact.phone ? phoneFilter.has(contact.phone) : false)
          : true;
      if (isSelected) skippedUnsubscribed += 1;
    }

    for (const d of targets) {
      const channel = d.channel as 'email' | 'sms';
      let status: 'sent' | 'failed' = 'failed';
      let error: string | null = null;
      let skipped = false;

      if (channel === 'email') {
        let unsubscribed = false;
        try {
          unsubscribed = await this.unsubscribes.isUnsubscribed(d.email!);
        } catch {
          error = 'suppression_check_failed';
          this.logger.warn(`retention suppression check failed for ${d.user_id}: ${error}`);
        }
        if (!error) {
          if (unsubscribed) {
            skipped = true;
            skippedUnsubscribed += 1;
          } else {
            try {
              const token = await this.unsubscribes.ensureToken(d.email!);
              const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
              const unsubscribeUrl = `${base}/webhook/retention/unsubscribe?token=${encodeURIComponent(token)}&lang=${d.language}`;
              const content = buildRetentionEmail({
                mode, language: d.language, assistantName: d.assistant_name,
                chatUrl: retentionChatUrl(d.language), unsubscribeUrl,
              });
              const sent = await this.mail.send(d.email!, content.subject, content.html, content.text);
              status = sent.ok ? 'sent' : 'failed';
              error = sent.ok ? null : this.safeMailError(sent.error);
            } catch (e: any) {
              error = this.safePreparationError(e);
              this.logger.warn(`retention delivery preparation failed for ${d.user_id}: ${error}`);
            }
          }
        }
      } else {
        const sent = await this.sendOutreachSms(d.phone!, buildRetentionSmsMessage(mode, d.assistant_name));
        status = sent.ok ? 'sent' : 'failed';
        error = sent.ok ? null : sent.error || 'sms_error';
      }
      if (skipped) continue;

      const props = {
        status, channel, campaign: preview.campaign, error,
        assistant_id: d.assistant_id, days_inactive: d.days_inactive,
        hours_inactive: d.hours_inactive,
      };
      let logError = false;
      try {
        await this.pg.query(
          `INSERT INTO events (user_id, name, props) VALUES ($1, 'retention_outreach', $2::jsonb)`,
          [d.user_id, JSON.stringify(props)],
        );
      } catch (e: any) {
        logError = true;
        this.logger.warn(`retention log insert failed for ${d.user_id}: ${String(e?.message || e).slice(0, 120)}`);
      }
      results.push({
        user_id: d.user_id, phone: d.phone, email: d.email, channel,
        status, error, ...(logError ? { log_error: true } : {}),
      });
    }

    return {
      campaign: preview.campaign,
      sent: results.filter((r) => r.status === 'sent').length,
      sent_email: results.filter((r) => r.status === 'sent' && r.channel === 'email').length,
      sent_sms: results.filter((r) => r.status === 'sent' && r.channel === 'sms').length,
      failed: results.filter((r) => r.status === 'failed').length,
      skipped_cooldown: skippedCooldown,
      skipped_unsubscribed: skippedUnsubscribed,
      no_channel: noChannel,
      results,
    };
  }

  private safeMailError(raw?: string): string {
    if (raw === 'smtp_not_configured') return raw;
    return /timeout/i.test(String(raw || '')) ? 'smtp_timeout' : 'smtp_error';
  }

  private safePreparationError(raw: any): string {
    const code = String(raw?.message || raw || '');
    if (code === 'retention_unsubscribe_secret_not_configured' || code === 'retention_unsubscribe_secret_invalid') {
      return code;
    }
    return 'delivery_preparation_failed';
  }

  private async sendOutreachSms(phone: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const login = process.env.SMSAERO_LOGIN;
    const apiKey = process.env.SMSAERO_API_KEY;
    if (!login || !apiKey) return { ok: false, error: 'SMS Aero credentials not set' };
    try {
      const auth = Buffer.from(`${login}:${apiKey}`).toString('base64');
      const resp = await axios.get('https://gate.smsaero.ru/v2/sms/send', {
        params: { number: phone, text, sign: 'SMSAero' },
        headers: { Authorization: `Basic ${auth}` },
        timeout: 10000,
        validateStatus: () => true,
      });
      if (resp.status >= 400) {
        return { ok: false, error: `SMS Aero ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}` };
      }
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message?.slice(0, 200) || 'network error' };
    }
  }
}
