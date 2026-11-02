import * as fs from 'fs';
import * as path from 'path';
import { noTokensMessage } from './no-tokens-message';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

describe('noTokensMessage — остановка на нулевом балансе', () => {
  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))('%s: есть текст и ссылка на пополнение', (lang) => {
    const msg = noTokensMessage(lang);
    expect(msg).toMatch(/^⚠️ \*\*.+\*\*/);
    expect(msg).toContain('](/chat?view=tokens)');
  });

  it('русский: разговор сохранён, продолжить можно с того же места', () => {
    const msg = noTokensMessage('ru');
    expect(msg).toContain('Разговор сохранён');
    expect(msg).toContain('с того же места');
  });

  it('незнакомый язык — русский', () => {
    expect(noTokensMessage('xx')).toBe(noTokensMessage('ru'));
  });

  it('языки различаются — английскому не уходит русский текст', () => {
    expect(noTokensMessage('en')).not.toBe(noTokensMessage('ru'));
    expect(noTokensMessage('en')).not.toMatch(/[а-яё]/i);
  });
});

/** Сторож: обе точки шлагбаума — через одну функцию, без своей копии текста. */
describe('шлагбаум нуля без копий текста', () => {
  const live = (file: string) =>
    fs.readFileSync(path.join(__dirname, file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it.each([['chat.service.ts'], ['chat.controller.ts']])('%s не держит старый текст', (file) => {
    expect(live(file)).not.toContain('Недостаточно токенов');
  });
});
