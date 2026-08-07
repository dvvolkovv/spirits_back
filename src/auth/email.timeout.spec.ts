/**
 * Отправка письма не должна держать HTTP-ответ бесконечно.
 *
 * Инцидент 2026-08-07: на test.linkeon.io POST /webhook/auth/email/request
 * висел без ответа больше 40 секунд (проверено curl). У nodemailer-транспорта
 * не был задан ни один таймаут, а умолчания там огромные — 2 минуты на
 * соединение и 10 минут на сокет. В интерфейсе это выглядело как вечный
 * спиннер: ни успеха, ни ошибки, потому что запрос не завершается.
 *
 * Таймаут задаётся до импорта сервиса: значение читается на уровне модуля.
 * Так тест детерминирован и не зависит от загруженности машины — под полным
 * прогоном из 180 наборов замер реального времени плавал.
 */
process.env.SMTP_SEND_TIMEOUT_MS = '150';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { EmailService } = require('./email.service');

describe('EmailService: отправка письма ограничена по времени', () => {
  const makeService = (sendMail: () => Promise<unknown>) => {
    const svc = new EmailService();
    // Подменяем транспорт: настоящий SMTP в юнит-тесте не нужен, проверяем
    // ровно то, что зависшая отправка обрывается по таймауту.
    (svc as { transporter: { sendMail: () => Promise<unknown> } }).transporter = { sendMail };
    return svc;
  };

  it('обрывает зависшую отправку и сообщает об этом', async () => {
    const никогда = () => new Promise<never>(() => {});
    const svc = makeService(никогда);

    await expect(svc.sendMagicLink('someone@example.com', 'tok')).rejects.toThrow(/SMTP timeout/);
  });

  it('успешную отправку не трогает', async () => {
    const svc = makeService(() => Promise.resolve({ messageId: 'ok' }));
    await expect(svc.sendMagicLink('someone@example.com', 'tok')).resolves.toBeUndefined();
  });

  it('ошибку SMTP пробрасывает как есть, а не глотает', async () => {
    const svc = makeService(() => Promise.reject(new Error('550 relay not permitted')));
    await expect(svc.sendMagicLink('someone@example.com', 'tok')).rejects.toThrow('550 relay not permitted');
  });

  it('без настроенного SMTP не падает и не висит', async () => {
    const svc = new EmailService();
    (svc as { transporter: null }).transporter = null;
    await expect(svc.sendMagicLink('someone@example.com', 'tok')).resolves.toBeUndefined();
  });
});
