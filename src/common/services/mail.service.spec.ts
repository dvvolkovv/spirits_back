/**
 * Общий отправитель писем: никогда не бросает и не висит.
 *
 * Причина ровно та же, что у EmailService (инцидент 2026-08-07 с вечным
 * спиннером на входе): умолчания nodemailer — 2 минуты на соединение и 10 на
 * сокет. Разница в контракте: здесь отправка фоновая, поэтому сбой должен
 * возвращаться значением, а не исключением, иначе он утащит за собой вызов,
 * к которому прицеплен (ответ поддержки).
 *
 * Таймаут задаётся до импорта — читается на уровне модуля.
 */
process.env.SMTP_SEND_TIMEOUT_MS = '150';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MailService } = require('./mail.service');

describe('MailService', () => {
  const withTransport = (sendMail: () => Promise<unknown>) => {
    const svc = new MailService();
    (svc as any).transporter = { sendMail };
    return svc;
  };

  it('успешную отправку отдаёт как ok', async () => {
    const svc = withTransport(() => Promise.resolve({ messageId: 'x' }));
    await expect(svc.send('a@example.com', 'тема', '<p>тело</p>')).resolves.toEqual({ ok: true });
  });

  it('ошибку SMTP возвращает значением, а не исключением', async () => {
    const svc = withTransport(() => Promise.reject(new Error('550 relay not permitted')));
    await expect(svc.send('a@example.com', 'тема', 'тело')).resolves.toEqual({
      ok: false, error: expect.stringContaining('550 relay'),
    });
  });

  it('зависшую отправку обрывает по таймауту', async () => {
    const svc = withTransport(() => new Promise<never>(() => {}));
    const res = await svc.send('a@example.com', 'тема', 'тело');
    expect(res).toEqual({ ok: false, error: expect.stringContaining('timeout') });
  });

  it('без настроенного SMTP отвечает отказом, а не падением', async () => {
    const svc = new MailService();
    (svc as any).transporter = null;
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.send('a@example.com', 'тема', 'тело')).resolves.toEqual({
      ok: false, error: 'smtp_not_configured',
    });
  });

  it.each([
    ['smtp_error', '550 mailbox victim@example.com rejected; token=abc123; url=https://smtp.example.test/diagnostic'],
    ['smtp_timeout', 'SMTP timeout: victim@example.com token=abc123 https://smtp.example.test/timeout'],
  ])('логирует только безопасную категорию %s, сохраняя legacy error', async (category, raw) => {
    const svc = withTransport(() => Promise.reject(new Error(raw)));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
    const recipient = 'recipient@example.com';
    await expect(svc.send(recipient, 'тема', 'тело')).resolves.toEqual({ ok: false, error: raw });
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).toContain(category);
    expect(logs).not.toContain(recipient);
    expect(logs).not.toContain(raw);
    expect(logs).not.toContain('victim@example.com');
    expect(logs).not.toContain('abc123');
    expect(logs).not.toContain('token');
    expect(logs).not.toContain('https://');
  });

  it('передаёт plain text в nodemailer, не ломая старую сигнатуру', async () => {
    let payload: any;
    const svc = withTransport((p?: any) => { payload = p; return Promise.resolve({ messageId: 'x' }); });
    await svc.send('a@example.com', 'тема', '<p>HTML</p>', 'Текст');
    expect(payload).toMatchObject({ subject: 'тема', html: '<p>HTML</p>', text: 'Текст' });
  });
});
