/**
 * Уведомление пользователя о ручном ответе поддержки.
 *
 * До 2026-08-15 ответ владельца просто ложился в support_messages: ни письма,
 * ни пуша — человек видел ответ, только если сам заходил в раздел поддержки.
 * Здесь проверяем ровно три вещи: письмо уходит тому, у кого есть адрес; на
 * серию ответов подряд не сыплется серия писем; сбой SMTP не ломает сам ответ.
 */
import { SupportService } from './support.service';

type Row = Record<string, any>;

/** Минимальный поддельный PgService: раздаёт ответы по форме запроса. */
function makePg(recipient: Row | null) {
  const events: Array<{ action: string; payload: any }> = [];
  const pg: any = {
    events,
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (/FROM support_tickets t/.test(sql)) {
        return { rows: recipient ? [recipient] : [] };
      }
      if (/INSERT INTO support_events/.test(sql)) {
        const payload = params?.[2] ? JSON.parse(params[2]) : {};
        events.push({ action: 'notify_email', payload });
        return { rows: [] };
      }
      return { rows: [] };
    }),
  };
  return pg;
}

function makeService(pg: any, mail: any): SupportService {
  const svc: any = new (SupportService as any)(pg);
  svc.mail = mail;
  return svc as SupportService;
}

describe('SupportService.notifyOwnerReplyByEmail', () => {
  const okMail = () => ({
    isConfigured: () => true,
    send: jest.fn(async (_to: string, _subject: string, _html: string) => ({ ok: true })),
  });

  it('шлёт письмо на адрес пользователя и логирует событие', async () => {
    const pg = makePg({ email: 'user@example.com', language: 'en', already_notified: false });
    const mail = okMail();

    const res = await makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'Токены вернули.');

    expect(res.sent).toBe(true);
    expect(mail.send).toHaveBeenCalledTimes(1);
    const [to, subject, html] = mail.send.mock.calls[0];
    expect(to).toBe('user@example.com');
    expect(subject.length).toBeGreaterThan(0);
    expect(html).toContain('Токены вернули.');
    expect(pg.events[0].payload).toMatchObject({ ok: true });
  });

  it('без адреса ничего не шлёт и не падает', async () => {
    const pg = makePg({ email: null, language: 'ru', already_notified: false });
    const mail = okMail();

    const res = await makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'ответ');

    expect(res).toEqual({ sent: false, reason: 'no_email' });
    expect(mail.send).not.toHaveBeenCalled();
    expect(pg.events).toHaveLength(0);
  });

  it('на второй ответ подряд письмо не дублирует', async () => {
    const pg = makePg({ email: 'user@example.com', language: 'ru', already_notified: true });
    const mail = okMail();

    const res = await makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'и ещё вот что');

    expect(res).toEqual({ sent: false, reason: 'already_notified' });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('сбой SMTP не роняет ответ поддержки, но остаётся в событиях', async () => {
    const pg = makePg({ email: 'user@example.com', language: 'ru', already_notified: false });
    const mail = { isConfigured: () => true, send: jest.fn(async () => ({ ok: false, error: '550 relay denied' })) };

    const res = await makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'ответ');

    expect(res.sent).toBe(false);
    expect(pg.events[0].payload).toMatchObject({ ok: false, error: '550 relay denied' });
  });

  it('без настроенного SMTP молча пропускает', async () => {
    const pg = makePg({ email: 'user@example.com', language: 'ru', already_notified: false });
    const mail = { isConfigured: () => false, send: jest.fn() };

    const res = await makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'ответ');

    expect(res).toEqual({ sent: false, reason: 'smtp_not_configured' });
    expect(mail.send).not.toHaveBeenCalled();
  });

  it('исключение внутри отправки не всплывает наружу', async () => {
    const pg = makePg({ email: 'user@example.com', language: 'ru', already_notified: false });
    const mail = { isConfigured: () => true, send: jest.fn(async () => { throw new Error('boom'); }) };

    await expect(makeService(pg, mail).notifyOwnerReplyByEmail('t-1', 'ответ')).resolves.toMatchObject({ sent: false });
  });
});
