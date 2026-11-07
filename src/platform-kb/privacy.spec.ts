import { profile } from './articles/profile';
import { networking } from './articles/networking';
import { howItWorks } from './articles/how-it-works';
import { renderArticle } from './render';

it('explains both real controls and preserves existing contacts', () => {
  const profileText = renderArticle(profile, 'ru', 'web');
  const storeProfileText = renderArticle(profile, 'ru', 'store');
  const networkingText = renderArticle(networking, 'ru', 'web');
  expect(profileText).toContain('Автоматически пополнять мой профиль');
  expect(storeProfileText).toContain('Автоматически пополнять мой профиль');
  expect(storeProfileText).toContain('сохранённое остаётся видимым владельцу');
  expect(storeProfileText).toContain('Задачи и встречи продолжают запоминаться');
  expect(profileText).toContain('для поиска и совместимости он используется с учётом настройки');
  expect(profileText).toContain('Меня можно найти в поиске');
  expect(profileText).not.toContain('он работает в поиске и совместимости');
  expect(networkingText).toContain('Меня можно найти в поиске');
  expect(networkingText).toContain('существующие контакты и переписки');
  expect(networkingText).toContain('новые люди');
  expect(networkingText).toContain('Посчитать совместимость, если у одного из двоих выключен автоматический профиль.');
  expect(networkingText).not.toContain('Скрыться из поиска.');
  expect(profileText).not.toContain('Скрыть профиль из поиска людей.');
});

it('does not promise deletion or full anonymity', () => {
  const profileText = renderArticle(profile, 'ru', 'web');
  const text = renderArticle(howItWorks, 'ru', 'web');
  expect(text).toContain('новые люди');
  expect(profileText).toContain('Удалить сохранённый профиль одним переключателем.');
  expect(text).not.toContain('полная анонимность');
});
