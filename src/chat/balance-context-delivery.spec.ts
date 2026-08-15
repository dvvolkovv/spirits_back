import { insufficientTokens } from './chat-tools';

describe('insufficientTokens — единый ответ на нехватку токенов', () => {
  it('несёт баланс, требуемое и нехватку', () => {
    const r = insufficientTokens(3000, 10000);
    expect(r).toMatchObject({
      ok: false,
      error: 'insufficient_tokens',
      balance: 3000,
      required: 10000,
      shortfall: 7000,
    });
  });

  it('несёт ссылку на пополнение — без неё ассистент импровизирует', () => {
    expect(insufficientTokens(3000, 10000).topUpUrl).toBe('https://my.linkeon.io/chat?view=tokens');
  });

  it('нехватка не уходит в минус при балансе больше требуемого', () => {
    expect(insufficientTokens(12000, 10000).shortfall).toBe(0);
  });
});

import * as fs from 'fs';
import * as path from 'path';

/**
 * Сторож против самого вероятного способа сломать фичу: отрефакторить
 * contextPrefix и потерять вызов. Сервис при этом останется зелёным, а
 * ассистент молча перестанет видеть баланс.
 *
 * Проверяем исходник, а не поведение: поднять полный streamChat в юните
 * невозможно — он требует агента, БД и живой стрим.
 *
 * ВНИМАНИЕ на чистку комментариев ниже. Первая редакция сторожа искала
 * подстроку по сырому файлу и оставалась ЗЕЛЁНОЙ, когда строку инжекта
 * закомментировали: `// contextPrefix += balanceBlock` матчится той же
 * регуляркой, что и живой код. Проверено на слом — без чистки сторож не
 * ловит ничего. Если будешь править эти проверки, ломай инжект руками и
 * убеждайся, что тест краснеет.
 */
const liveCode = (file: string): string =>
  fs
    .readFileSync(path.join(__dirname, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');

describe('доставка блока баланса в промпт', () => {
  const src = liveCode('chat.service.ts');

  it('блок собирается ровно один раз за ход', () => {
    const calls = src.match(/balanceCtx\.buildContextForPrompt/g) || [];
    expect(calls.length).toBe(1);
  });

  it('доезжает до contextPrefix (путь relay — все ассистенты)', () => {
    expect(src).toMatch(/contextPrefix \+= balanceBlock/);
  });

  it('доезжает до volatileSystemPrompt (локальный путь Маши)', () => {
    expect(src).toMatch(/volatileSystemPrompt \+= .*balanceBlock/);
  });

  it('передаётся в путь Юли через ctx', () => {
    expect(src).toMatch(/const ctx = \{ userId, isAdmin, balanceBlock \}/);
  });

  it('сторож смотрит на живой код, а не на комментарии', () => {
    // Прямая проверка самой чистки, без которой три проверки выше — театр.
    // Эта фраза живёт в chat.service.ts только внутри `//`-комментария:
    // в сыром файле она есть, в очищенном коде её быть не должно.
    const marker = 'читаем один раз';
    expect(fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8')).toContain(marker);
    expect(src).not.toContain(marker);
  });
});
