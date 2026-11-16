/**
 * Автоприветствие старого веб-клиента (тикет 8cf1c5ae).
 *
 * Кабинет до ce33cc1 (spirits_front, 13.11.2026) сам отправлял
 * `chat.initial_greeting` в каждый пустой чат: при первом открытии
 * ассистента и при каждом включении «Чистого листа» — fresh-сессия всегда
 * пустая. Бэк тарифицировал это как обычный ход: человек ничего не писал, а
 * токены уходили. Новый клиент так не делает, но SPA не проверяет свою
 * версию — вкладка, открытая до выката, шлёт приветствие, пока её не
 * перезагрузят (16.11 на проде была вкладка сборки 11.11). Так же ведёт себя
 * Capacitor-сборка с OTA от 03.11.
 *
 * Узнаём такое сообщение только по точному тексту ключа (все значения по всей
 * истории src/i18n/locales/*.json фронта — по одному на язык) и только в
 * пустой сессии: человек, который сам набрал ту же фразу посреди разговора,
 * получает обычный ответ. Другого признака старого клиента нет — поле ui он
 * тоже шлёт.
 *
 * Ответ — короткая фраза на языке приветствия, в том же обращении, что и
 * no-tokens-message.ts (de — du, fr — tu, pt — европейский). Map, а не
 * объект: «constructor» или «__proto__» первым сообщением не должны найти
 * свойство прототипа.
 */
const REPLIES = new Map<string, string>([
  ['Привет! Расскажи про себя!', 'Здравствуйте! Чем могу помочь?'],
  ['Hi! Tell me about yourself!', 'Hello! How can I help?'],
  ['Hallo! Erzähl mir von dir!', 'Hallo! Wobei kann ich dir helfen?'],
  ['¡Hola! Cuéntame sobre ti', '¡Hola! ¿En qué puedo ayudarte?'],
  ['Salut ! Parle-moi de toi !', "Bonjour ! Comment puis-je t'aider ?"],
  ['Olá! Fala-me de ti!', 'Olá! Em que posso ajudar?'],
  ['你好！和我聊聊你自己吧！', '你好！有什么可以帮你的？'],
]);

/** Ответ на автоприветствие старого клиента или null, если это обычный ход. */
export function legacyGreetingReply(message: unknown, historyLength: number): string | null {
  if (historyLength !== 0 || typeof message !== 'string') return null;
  return REPLIES.get(message.trim()) ?? null;
}
