import { errKind, logId } from './err-kind';

/**
 * Общие помощники журнала загрузок: сервис и контроллер пишут только вид
 * ошибки и id в кавычках. Текст сообщения S3/pg может повторять ключ объекта
 * `<uuid>/<имя файла>` — в журнал он не попадает.
 */
describe('errKind', () => {
  it('только name, статус S3 и безопасный код — без текста сообщения', () => {
    const e = Object.assign(new Error('NoSuchKey thumbs/u1/Отчёт.pdf.webp'), {
      name: 'S3ServiceException',
      $metadata: { httpStatusCode: 503 },
      code: 'ETIMEDOUT',
    });
    expect(errKind(e)).toBe('S3ServiceException status=503 code=ETIMEDOUT');
  });

  it('name чистится до безопасных символов, небезопасный code и нецелый статус отбрасываются', () => {
    const e = { name: 'Bad\nName [x]', code: 'путь/к/файлу', $metadata: { httpStatusCode: '500' } };
    expect(errKind(e)).toBe('BadNamex');
  });

  it('не-ошибка и пустое имя — Error', () => {
    expect(errKind(undefined)).toBe('Error');
    expect(errKind({ name: '\n\n' })).toBe('Error');
  });
});

describe('logId', () => {
  it('id в кавычках, перевод строки экранирован, длина ограничена', () => {
    expect(logId('44444444-4444-4444-8444-444444444444')).toBe('"44444444-4444-4444-8444-444444444444"');
    expect(logId('x\n[Nest] FAKE')).not.toContain('\n');
    expect(logId('a'.repeat(100))).toBe(JSON.stringify('a'.repeat(64)));
  });
});
