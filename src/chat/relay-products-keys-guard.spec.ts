import * as fs from 'fs';
import * as path from 'path';

/**
 * Копия текста продуктов в промпте релея (relay-agent/server.mjs) катится
 * отдельно от бэкенда и отстаёт молча: ассистенты релея продолжали бы
 * отвечать «сменить ключи нельзя», когда сервер уже умеет.
 */
const src = fs.readFileSync(path.join(__dirname, '../../relay-agent/server.mjs'), 'utf8');
const block = src.slice(src.indexOf('const PRODUCTS_PROMPT'), src.indexOf('ФАЙЛЫ ИЗ ПРОШЛЫХ РАЗГОВОРОВ'));

describe('релей: продукты — ключи карточкой', () => {
  it('блок найден', () => {
    expect(block.length).toBeGreaterThan(500);
  });

  it('знает action keys и не просит ключи в переписке', () => {
    expect(block).toContain('action: "keys"');
    expect(block).toMatch(/Ключи в переписке не проси никогда/);
    expect(block).toMatch(/предложи карточку keys/);
    expect(block).toMatch(/стирается насовсем/);
  });

  // Добавлено по ревью задачи 8 (27.10): та же подсказка про chat_id и
  // OWNER_TG_ID, что в PRODUCTS_CLI_PROMPT — иначе веб-ассистенты (релей) и
  // Маша/TG-бот (CLI) учили бы пользователя разным действиям для одного
  // и того же «бот подсказал мне chat_id».
  it('chat_id от пользователя — правкой; после привязки Telegram бот узнаёт владельца сам', () => {
    expect(block).toMatch(/владелец — chat_id N/);
    expect(block).toMatch(/OWNER_TG_ID/);
    expect(block).toMatch(/после следующей смены ключей/);
  });
});
