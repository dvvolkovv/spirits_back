import { Injectable, Logger } from '@nestjs/common';
import { MailService } from '../common/services/mail.service';
import { PgService } from '../common/services/pg.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
import { buildRetentionEmail, buildRetentionSmsMessage, retentionChatUrl } from './retention-mail';
import { selectRetentionChannel } from './retention-recipient';
import { RetentionRecipientResolver } from './retention-recipient-resolver';
import { CURIOUS_SEGMENT_SQL, GENERAL_SEGMENT_SQL } from './retention-sql';
import type { RetentionDraft, RetentionMode, RetentionPreview } from './retention.types';
import { RetentionUnsubscribeService } from './retention-unsubscribe.service';

export const RETENTION_CAMPAIGN = 'retention_reengage_v1';
export const CURIOUS_CAMPAIGN = 'curious_return_v1';
export const RETENTION_COOLDOWN_DAYS = 14;

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
    const minDays = opts?.minDays ?? 3;
    const maxDays = opts?.maxDays ?? 30;
    const seg = await this.pg.query(GENERAL_SEGMENT_SQL, [TEST_USERS, TEST_USER_PATTERN, minDays, maxDays]);
    return this.buildPreview(seg.rows, 'general', { min_days: minDays, max_days: maxDays });
  }

  async buildCuriousReturnOutreach(): Promise<RetentionPreview> {
    const seg = await this.pg.query(CURIOUS_SEGMENT_SQL, [TEST_USERS, TEST_USER_PATTERN]);
    return this.buildPreview(seg.rows, 'curious', { min_hours: 24, max_hours: 48 });
  }

  private async buildPreview(rows: any[], mode: RetentionMode, window: RetentionPreview['window']): Promise<RetentionPreview> {
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
    for (const row of rows) {
      const contact = contacts.get(row.user_id) || {
        userId: row.user_id, email: null, phone: null, language: 'ru', unsubscribed: false,
      };
      if (contact.unsubscribed) continue;
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
      channel: 'mixed', campaign, window, cooldown_days: RETENTION_COOLDOWN_DAYS,
      count: drafts.length,
      summary: {
        email: drafts.filter((d) => d.channel === 'email').length,
        sms: drafts.filter((d) => d.channel === 'sms').length,
        no_channel: drafts.filter((d) => d.channel === 'no_channel').length,
        skipped_unsubscribed: rows.length - activeIds.length,
      },
      drafts,
    };
  }
}
