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
    expect(mail.html).toContain(`https://my.linkeon.io/chat?lang=${language}`);
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
    expect(buildRetentionSmsMessage('general', 'Роман')).toBe('Здравствуйте! Роман из LINKEON будет рад продолжить разговор, если будет желание — можно вернуться в чат: https://my.linkeon.io/chat. Если сейчас не до этого, это совершенно нормально, не отвлекаем.');
    expect(buildRetentionSmsMessage('general')).toBe('Здравствуйте! Ваш ассистент в LINKEON будет рад продолжить разговор, если будет желание — можно вернуться в чат: https://my.linkeon.io/chat. Если сейчас не до этого, это совершенно нормально, не отвлекаем.');
    expect(buildRetentionSmsMessage('curious')).toBe('Здравствуйте! Напомним, что у нас есть ассистенты под любые задачи. Если есть время и желание — приходите в https://my.linkeon.io/chat и повышайте свою эффективность 👍');
  });

  it('General email персонализирует приветствие и паузу', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'ru', assistantName: 'Роман', name: 'Дмитрий', daysInactive: 3,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 3 дня назад. Роман из LINKEON');
  });

  it('Curious email персонализирует часы', () => {
    const mail = buildRetentionEmail({
      mode: 'curious', language: 'ru', assistantName: null, name: 'Дмитрий', hoursInactive: 25,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
  });

  it('SMS General и Curious получают те же персонализацию', () => {
    expect(buildRetentionSmsMessage('general', 'Роман', 'Дмитрий', 3))
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 3 дня назад.');
    expect(buildRetentionSmsMessage('curious', null, 'Дмитрий', undefined, 25))
      .toContain('Здравствуйте, Дмитрий! Последняя активность в Linkeon была 25 часов назад.');
    expect(buildRetentionSmsMessage('general', 'Роман', 'Дмитрий', 3))
      .toContain('https://my.linkeon.io/chat. Если');
  });

  it('без имени вставляет паузу после нейтрального приветствия, без undefined', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'ru', assistantName: null, name: null, daysInactive: 3,
      chatUrl: retentionChatUrl('ru'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Здравствуйте! Последняя активность в Linkeon была 3 дня назад.');
    expect(mail.text).not.toContain('undefined');
  });

  it('имя экранируется в HTML', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'en', assistantName: null, name: '<img src=x>', daysInactive: 3,
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('<img src=x>');
    expect(mail.html).not.toContain('<img src=x>');
    expect(mail.html).toContain('&lt;img src=x&gt;');
  });

  it.each([
    ['ru', '3 дня'],
    ['en', '3 days'],
    ['es', '3 días'],
    ['de', '3 Tagen'],
    ['fr', '3 jours'],
    ['zh', '3天'],
    ['pt', '3 dias'],
  ])('%s локализует паузу без русских фраз', (language, expected) => {
    const mail = buildRetentionEmail({
      mode: 'general', language, assistantName: null, name: 'Alex', daysInactive: 3,
      chatUrl: retentionChatUrl(language), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Alex');
    expect(mail.text).toContain(expected);
    if (language !== 'ru') expect(mail.text).not.toContain('дня');
  });

  it('некорректная пауза пропускается', () => {
    const mail = buildRetentionEmail({
      mode: 'general', language: 'en', assistantName: null, name: 'Alex', daysInactive: -1,
      chatUrl: retentionChatUrl('en'), unsubscribeUrl: null,
    });
    expect(mail.text).toContain('Hello, Alex!');
    expect(mail.text).not.toContain('last activity');
  });
});
