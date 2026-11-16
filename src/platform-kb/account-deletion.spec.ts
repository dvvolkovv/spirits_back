import { account } from './articles/account';
import { renderArticle } from './render';
import { V } from './values';

describe('справка об удалении аккаунта', () => {
  const web = renderArticle(account,'ru','web');
  it('stop сразу, очистка через срок из production constant, reactivation отменяет', () => {
    expect(V.accountDeletionDays).toBe('30');
    expect(web).toContain(`через ${V.accountDeletionDays} дней`);
    expect(web).toMatch(/останавливаются сразу/);
    expect(web).toMatch(/повторная регистрация до очистки отменяет/i);
    expect(web).not.toMatch(/Удаление аккаунта не трогает продукты/);
    expect(web).not.toContain('Отменить удаление аккаунта.');
  });
});
