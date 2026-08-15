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
});
