import { buildRetentionEmail, buildRetentionSmsMessage, retentionChatUrl } from './retention-mail';

const LANGS = ['ru', 'en', 'es', 'de', 'fr', 'zh', 'pt'];

describe('retention mail', () => {
  it.each(LANGS)('%s: тема, текст, чат и отписка локализованы', (language) => {
    const mail = buildRetentionEmail({
      mode: 'general', language, assistantName: 'Роман',
      chatUrl: retentionChatUrl(language), unsubscribeUrl: 'https://my.linkeon.io/webhook/retention/unsubscribe?token=x',
    });
    expect(mail.subject.length).toBeGreaterThan(10);
    expect(mail.text).toContain(`https://my.linkeon.io/chat?lang=${language}`);
    expect(mail.text).toContain('unsubscribe?token=x');
    expect(mail.html).toContain('unsubscribe?token=x');
    if (language !== 'ru') expect(mail.text).not.toContain('Здравствуйте');
  });

  it('экранирует имя ассистента в HTML, но оставляет его в plain text', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'en', assistantName: '<img src=x>',
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('<img src=x>');
    expect(mail.html).not.toContain('<img src=x>');
    expect(mail.html).toContain('&lt;img src=x&gt;');
  });

  it('Curious не использует имя ассистента', () => {
    const mail = buildRetentionEmail({
      mode: 'curious', language: 'en', assistantName: 'Hidden Name',
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).not.toContain('Hidden Name');
  });

  it('неизвестный язык получает русский fallback', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'xx-YY', assistantName: null,
      chatUrl: retentionChatUrl('xx-YY'), unsubscribeUrl: null,
    });
    expect(mail.subject).toBe('Ваш ассистент Linkeon будет рад продолжить разговор');
    expect(mail.text).toContain('Здравствуйте!');
  });

  it('SMS сохраняет текущие русские тексты', () => {
    expect(buildRetentionSmsMessage('general', 'Роман')).toContain('Роман из LINKEON');
    expect(buildRetentionSmsMessage('curious')).toContain('ассистенты под любые задачи');
  });
});
