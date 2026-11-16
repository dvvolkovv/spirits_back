import { legacyGreetingReply } from './legacy-greeting';

/**
 * Автоприветствие старого веб-клиента (тикет 8cf1c5ae, см. legacy-greeting.ts):
 * узнаём его только по точному тексту `chat.initial_greeting` из локалей
 * фронта и только в пустой сессии. Всё остальное — обычный ход.
 */
describe('legacyGreetingReply', () => {
  // Тексты — ровно те, что слал клиент до ce33cc1 (spirits_front, 13.11.2026),
  // по всей истории src/i18n/locales/*.json. Ответ — на языке приветствия.
  it.each([
    ['Привет! Расскажи про себя!', 'Здравствуйте! Чем могу помочь?'],
    ['Hi! Tell me about yourself!', 'Hello! How can I help?'],
    ['Hallo! Erzähl mir von dir!', 'Hallo! Wobei kann ich dir helfen?'],
    ['¡Hola! Cuéntame sobre ti', '¡Hola! ¿En qué puedo ayudarte?'],
    ['Salut ! Parle-moi de toi !', "Bonjour ! Comment puis-je t'aider ?"],
    ['Olá! Fala-me de ti!', 'Olá! Em que posso ajudar?'],
    ['你好！和我聊聊你自己吧！', '你好！有什么可以帮你的？'],
  ])('%s в пустой сессии → короткий ответ на том же языке', (greeting, reply) => {
    expect(legacyGreetingReply(greeting, 0)).toBe(reply);
  });

  it('пробелы и перевод строки по краям не мешают', () => {
    expect(legacyGreetingReply('  Привет! Расскажи про себя!\n', 0)).toBe('Здравствуйте! Чем могу помочь?');
  });

  it('в сессии с историей — не перехватываем: это человек написал посреди разговора', () => {
    expect(legacyGreetingReply('Привет! Расскажи про себя!', 1)).toBeNull();
    expect(legacyGreetingReply('Hi! Tell me about yourself!', 10)).toBeNull();
  });

  it.each([
    'Привет! Расскажи про себя',
    'привет! расскажи про себя!',
    'Привет! Расскажи про себя! Мне 30 лет',
    'Привет',
    'Расскажи про себя',
    'Hi!',
  ])('похожий, но не тот текст (%s) — обычный ход', (text) => {
    expect(legacyGreetingReply(text, 0)).toBeNull();
  });

  // Поиск по словарю не должен находить свойства прототипа: первое сообщение
  // «constructor» иначе получило бы в ответ функцию вместо строки.
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty'])('«%s» — не приветствие', (text) => {
    expect(legacyGreetingReply(text, 0)).toBeNull();
  });

  it('не строка — null, а не исключение', () => {
    expect(legacyGreetingReply(undefined, 0)).toBeNull();
    expect(legacyGreetingReply(42, 0)).toBeNull();
    expect(legacyGreetingReply({ text: 'Привет! Расскажи про себя!' }, 0)).toBeNull();
  });
});
