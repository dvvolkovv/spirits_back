import { looksLikeCliRefusal } from './llm-error';

/**
 * Отказ CLI, пришедший обычным ответом. Распознаётся только с начала текста:
 * ложное срабатывание здесь открывает окно запасного пути для всех вызовов,
 * а Маша часто говорит о ключах продуктов.
 */
describe('looksLikeCliRefusal', () => {
  it.each([
    'Not logged in · Please run /login',
    'Please run /login',
    "You've hit your session limit · resets 3am (UTC)",
    'You’ve hit your weekly limit · resets Nov 3',
    'You have hit your usage limit',
    'Invalid API key · Please run /login',
    'Credit balance is too low',
    'OAuth token has expired. Please obtain a new token or refresh your existing token.',
    'Claude AI usage limit reached|1730000000',
    '  Not logged in · Please run /login\n',
    "You've hit your limit · resets 3am",
    "You've hit your Opus limit",
  ])('отказ: %p', (t) => {
    expect(looksLikeCliRefusal(t)).toBe(true);
  });

  it.each([
    'Это значит, что ключ неверный: сервис ответил Invalid API key. Проверьте ключ в карточке продукта.',
    'У меня выскочило «Not logged in», что делать?',
    'Похоже, вы hit your usage limit у провайдера — подождите сброса.',
    // Отказы CLI всегда английские: русский ответ Маши, начатый с цитаты, — не отказ.
    'Invalid API key — так ответил сервис, проверьте ключ',
    '',
    'Not logged in · Please run /login ' + 'x'.repeat(300),
  ])('не отказ: %p', (t) => {
    expect(looksLikeCliRefusal(t)).toBe(false);
  });
});
