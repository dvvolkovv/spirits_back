/**
 * Unit-тест парсинга списка chat_id для алертов (common/telegram-alert).
 * Алерты мониторинга должны уходить в НЕСКОЛЬКО чатов (личка + дев-чат команды)
 * — TELEGRAM_CHAT_ID = comma-separated. Inline-копия логики (как остальные unit).
 */
function telegramChatIds(env) {
  return (env || '').split(',').map((s) => s.trim()).filter(Boolean);
}

describe('telegramChatIds', () => {
  test('один чат (back-compat)', () => {
    expect(telegramChatIds('417871972')).toEqual(['417871972']);
  });
  test('несколько чатов через запятую + тримминг', () => {
    expect(telegramChatIds('417871972, -1003755562318')).toEqual(['417871972', '-1003755562318']);
  });
  test('пустой/не задан → пусто (алерты молча выключены, не падают)', () => {
    expect(telegramChatIds('')).toEqual([]);
    expect(telegramChatIds(undefined)).toEqual([]);
  });
  test('лишние запятые/пробелы игнорируются', () => {
    expect(telegramChatIds(' 111 ,, 222 ,')).toEqual(['111', '222']);
  });
});
