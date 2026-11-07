import { profile } from './articles/profile';
import { networking } from './articles/networking';
import { howItWorks } from './articles/how-it-works';
import { renderArticle } from './render';

it('explains both real controls and preserves existing contacts', () => {
  const profileText = renderArticle(profile, 'ru', 'web');
  const networkingText = renderArticle(networking, 'ru', 'web');
  expect(profileText).toContain('Автоматически пополнять мой профиль');
  expect(networkingText).toContain('Меня можно найти в поиске');
  expect(networkingText).toContain('существующие контакты и переписки');
  expect(networkingText).not.toContain('Скрыться из поиска.');
  expect(profileText).not.toContain('Скрыть профиль из поиска людей.');
});

it('does not promise deletion or full anonymity', () => {
  const text = renderArticle(howItWorks, 'ru', 'web');
  expect(text).toContain('новые люди');
  expect(text).not.toContain('полная анонимность');
});
