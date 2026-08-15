/**
 * Письмо об ответе поддержки: шаблон и его локализация.
 *
 * Текст ответа владельца попадает в письмо как есть — это HTML-письмо, поэтому
 * экранирование здесь не косметика: реплика вида «<b>» или ссылка с кавычками
 * иначе ломает вёрстку у получателя, а в худшем случае протаскивает разметку.
 */
import { buildOwnerReplyEmail, MAIL_TEXT_MAX } from './support-mail';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

describe('buildOwnerReplyEmail', () => {
  const url = 'https://my.linkeon.io/support';

  it('кладёт текст ответа и ссылку на чат поддержки в письмо', () => {
    const { subject, html } = buildOwnerReplyEmail('ru', { text: 'Токены вернули, проверьте баланс.', url });

    expect(subject).toContain('Linkeon');
    expect(html).toContain('Токены вернули, проверьте баланс.');
    expect(html).toContain(url);
  });

  it('экранирует HTML в тексте ответа', () => {
    const { html } = buildOwnerReplyEmail('ru', { text: 'смотрите <b>тут</b> & "здесь"', url });

    expect(html).not.toContain('<b>тут</b>');
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
  });

  it('сохраняет переносы строк как <br>', () => {
    const { html } = buildOwnerReplyEmail('ru', { text: 'первая\nвторая', url });

    expect(html).toContain('первая<br>вторая');
  });

  it('обрезает слишком длинный ответ — остальное читается по ссылке', () => {
    const long = 'я'.repeat(MAIL_TEXT_MAX + 500);
    const { html } = buildOwnerReplyEmail('ru', { text: long, url });

    expect(html).toContain('…');
    expect(html).not.toContain('я'.repeat(MAIL_TEXT_MAX + 1));
  });

  it('переведён на все поддерживаемые языки, и переводы не совпадают с русским', () => {
    const ru = buildOwnerReplyEmail('ru', { text: 'ответ', url });

    for (const lang of SUPPORTED_LANGUAGES) {
      const mail = buildOwnerReplyEmail(lang, { text: 'ответ', url });
      expect(mail.subject.length).toBeGreaterThan(0);
      expect(mail.html).toContain(url);
      if (lang !== 'ru') {
        expect(mail.subject).not.toEqual(ru.subject);
      }
    }
  });

  it('незнакомый язык не роняет письмо — уходит на русском', () => {
    const { subject } = buildOwnerReplyEmail('kz', { text: 'ответ', url });

    expect(subject).toEqual(buildOwnerReplyEmail('ru', { text: 'ответ', url }).subject);
  });
});
