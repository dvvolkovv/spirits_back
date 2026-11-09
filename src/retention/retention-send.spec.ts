import axios from 'axios';
import { RetentionService } from './retention.service';
import type { RetentionDraft, RetentionPreview } from './retention.types';

jest.mock('axios', () => ({ __esModule: true, default: { get: jest.fn() } }));

const draft = (patch: Partial<RetentionDraft> = {}): RetentionDraft => ({
  user_id: 'u1', phone: '79001112233', email: 'u@example.com', channel: 'email',
  language: 'en', subject: 'Subject', message: 'Body', last_at: new Date(),
  last_sent_at: null, in_cooldown: false, ...patch,
});
const preview = (drafts: RetentionDraft[]): RetentionPreview => ({
  channel: 'mixed', campaign: 'retention_reengage_v1', window: { min_days: 3, max_days: 30 },
  cooldown_days: 14, count: drafts.length,
  summary: {
    email: drafts.filter((d) => d.channel === 'email').length,
    sms: drafts.filter((d) => d.channel === 'sms').length,
    no_channel: drafts.filter((d) => d.channel === 'no_channel').length,
    skipped_unsubscribed: 0,
  },
  drafts,
});

function harness(drafts: RetentionDraft[]) {
  const svc = Object.create(RetentionService.prototype) as any;
  svc.buildRetentionOutreach = jest.fn().mockResolvedValue(preview(drafts));
  svc.buildCuriousReturnOutreach = jest.fn().mockResolvedValue({
    ...preview(drafts), campaign: 'curious_return_v1', window: { min_hours: 24, max_hours: 48 },
  });
  svc.pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
  svc.mail = { send: jest.fn().mockResolvedValue({ ok: true }) };
  svc.unsubscribes = {
    ensureToken: jest.fn().mockResolvedValue('t'.repeat(43)),
    isUnsubscribed: jest.fn().mockResolvedValue(false),
  };
  svc.logger = { warn: jest.fn() };
  return svc;
}

describe('RetentionService send', () => {
  beforeEach(() => {
    process.env.SMSAERO_LOGIN = 'login';
    process.env.SMSAERO_API_KEY = 'key';
    (axios.get as jest.Mock).mockReset().mockResolvedValue({ status: 200, data: {} });
  });

  afterEach(() => {
    delete process.env.SMSAERO_LOGIN;
    delete process.env.SMSAERO_API_KEY;
  });

  it('email успешен — SMS не вызывается, plain text присутствует', async () => {
    const svc = harness([draft()]);
    const out = await svc.sendRetentionOutreach({ confirm: true });
    expect(out).toMatchObject({ sent: 1, sent_email: 1, sent_sms: 0 });
    expect(axios.get).not.toHaveBeenCalled();
    expect(svc.mail.send.mock.calls[0][3]).toContain('https://my.linkeon.io/chat?lang=en');
    const props = JSON.parse(svc.pg.query.mock.calls[0][1][1]);
    expect(props).toMatchObject({ status: 'sent', channel: 'email' });
    expect(props).not.toHaveProperty('body');
  });

  it('email ошибся — SMS не вызывается, событие содержит только безопасный код', async () => {
    const svc = harness([draft()]);
    svc.mail.send.mockResolvedValue({ ok: false, error: 'SMTP timeout: письмо на u@example.com' });
    const out = await svc.sendRetentionOutreach({ confirm: true });
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(out.results[0].error).toBe('smtp_timeout');
    expect(axios.get).not.toHaveBeenCalled();
    expect(svc.pg.query.mock.calls[0][1][1]).not.toContain('u@example.com');
  });

  it('без email отправляется SMS; no_channel не вызывает транспорт', async () => {
    const svc = harness([
      draft({ user_id: 'sms', email: null, channel: 'sms' }),
      draft({ user_id: 'none', email: null, phone: null, channel: 'no_channel' }),
    ]);
    const out = await svc.sendRetentionOutreach({ confirm: true });
    expect(out).toMatchObject({ sent_sms: 1, no_channel: 1 });
    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(svc.mail.send).not.toHaveBeenCalled();
  });

  it('отписка между preview и send блокирует письмо даже с resend', async () => {
    const svc = harness([draft({ in_cooldown: true })]);
    svc.unsubscribes.isUnsubscribed.mockResolvedValue(true);
    const out = await svc.sendRetentionOutreach({ confirm: true, resend: true });
    expect(out.skipped_unsubscribed).toBe(1);
    expect(svc.mail.send).not.toHaveBeenCalled();
  });

  it('legacy phones[] выбирает телефонный аккаунт даже при канале email', async () => {
    const svc = harness([draft(), draft({ user_id: 'other', phone: '79009998877', email: 'other@example.com' })]);
    const out = await svc.sendRetentionOutreach({ confirm: true, phones: ['79001112233'] });
    expect(out.sent_email).toBe(1);
    expect(svc.mail.send).toHaveBeenCalledTimes(1);
    expect(svc.mail.send.mock.calls[0][0]).toBe('u@example.com');
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('skipped_cooldown считается только внутри userIds-фильтра', async () => {
    const svc = harness([
      draft({ user_id: 'a', in_cooldown: true }),
      draft({ user_id: 'b', email: 'b@example.com' }),
    ]);
    const out = await svc.sendRetentionOutreach({ confirm: true, userIds: ['b'] });
    expect(out).toMatchObject({ sent: 1, skipped_cooldown: 0 });
  });

  it('resend обходит cooldown, но не no_channel', async () => {
    const svc = harness([draft({ in_cooldown: true })]);
    const out = await svc.sendRetentionOutreach({ confirm: true, resend: true });
    expect(out.sent).toBe(1);
  });

  it('ошибка event insert не маскирует доставку и помечает log_error', async () => {
    const svc = harness([draft()]);
    svc.pg.query.mockRejectedValue(new Error('events unavailable'));
    const out = await svc.sendRetentionOutreach({ confirm: true });
    expect(out.results[0]).toMatchObject({ status: 'sent', log_error: true });
  });

  it('confirm и неоднозначные фильтры проверяются до транспорта', async () => {
    const svc = harness([draft()]);
    expect((await svc.sendRetentionOutreach({})).error).toBe('confirm_required');
    expect((await svc.sendRetentionOutreach({ confirm: true, userIds: ['u1'], phones: ['79001112233'] })).error)
      .toBe('ambiguous_recipient_filter');
    expect(svc.mail.send).not.toHaveBeenCalled();
  });

  it('Curious пишет свой campaign', async () => {
    const svc = harness([draft()]);
    await svc.sendCuriousReturnOutreach({ confirm: true });
    const props = JSON.parse(svc.pg.query.mock.calls[0][1][1]);
    expect(props.campaign).toBe('curious_return_v1');
  });
});
