import * as fs from 'fs';
import * as path from 'path';
import { noTokensMessage } from './no-tokens-message';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { TOP_UP_URL } from '../tokens/balance-context.service';

describe('noTokensMessage — остановка на нулевом балансе', () => {
  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))('%s: есть текст и абсолютная ссылка на пополнение', (lang) => {
    const msg = noTokensMessage(lang);
    expect(msg).toMatch(/^⚠️ \*\*.+\*\*/);
    // Ссылка абсолютная (ревью качества 02.11, I5), не /chat?view=tokens:
    // Flutter открывает относительную ссылку через launchUrl без схемы молча
    // мимо цели, а кабинет абсолютную ссылку на свой хост откроет как прежде.
    expect(msg).toContain(`](${TOP_UP_URL})`);
  });

  it('русский: разговор сохранён, продолжить можно с того же места', () => {
    const msg = noTokensMessage('ru');
    expect(msg).toContain('Разговор сохранён');
    expect(msg).toContain('с того же места');
  });

  it('русский: явно сказано, что САМО сообщение не получено — отправить ещё раз (ревью качества 02.11, I4)', () => {
    const msg = noTokensMessage('ru').toLowerCase();
    expect(msg).toContain('это сообщение ассистент не получил');
    expect(msg).toContain('отправьте его ещё раз');
  });

  it('upload-вариант: просит и прикрепить файлы заново', () => {
    const msg = noTokensMessage('ru', { upload: true });
    expect(msg).toContain('прикрепите файлы заново');
  });

  it('обычный (не upload) вариант — про файлы не просит', () => {
    const msg = noTokensMessage('ru');
    expect(msg).not.toContain('файлы');
  });

  it('незнакомый язык — русский', () => {
    expect(noTokensMessage('xx')).toBe(noTokensMessage('ru'));
  });

  it('языки различаются — английскому не уходит русский текст', () => {
    expect(noTokensMessage('en')).not.toBe(noTokensMessage('ru'));
    expect(noTokensMessage('en')).not.toMatch(/[а-яё]/i);
  });
});

/** Все варианты (обычный/upload/магазинный) на каждом языке (M2, ревью качества 02.11). */
describe('noTokensMessage — все варианты на каждом языке', () => {
  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))('%s: обычный, upload и магазинный варианты непустые', (lang) => {
    expect(noTokensMessage(lang)).toBeTruthy();
    expect(noTokensMessage(lang, { upload: true })).toBeTruthy();
    expect(noTokensMessage(lang, { storeBuild: true })).toBeTruthy();
  });

  it.each(SUPPORTED_LANGUAGES.filter((l) => l !== 'ru').map((l) => [l]))('%s: ни в одном варианте нет кириллицы', (lang) => {
    expect(noTokensMessage(lang)).not.toMatch(/[а-яё]/i);
    expect(noTokensMessage(lang, { upload: true })).not.toMatch(/[а-яё]/i);
    expect(noTokensMessage(lang, { storeBuild: true })).not.toMatch(/[а-яё]/i);
  });
});

/** Магазинная сборка (I5): ни слова о токенах/балансе, без ссылки — правило Apple 3.1.1. */
describe('noTokensMessage — магазинная сборка', () => {
  it.each(SUPPORTED_LANGUAGES.map((l) => [l]))('%s: без ссылки и без слов о токенах/балансе', (lang) => {
    const msg = noTokensMessage(lang, { storeBuild: true });
    expect(msg).not.toContain('](');
    expect(msg).not.toContain(TOP_UP_URL);
    expect(msg.toLowerCase()).not.toMatch(/token|балан|пополн/i);
  });

  it('upload не меняет магазинный текст — про токены молчим в любом случае', () => {
    expect(noTokensMessage('ru', { storeBuild: true, upload: true })).toBe(noTokensMessage('ru', { storeBuild: true }));
  });

  it('русский магазинный текст — нейтральная формулировка', () => {
    const msg = noTokensMessage('ru', { storeBuild: true });
    expect(msg).toContain('Ответ сейчас недоступен');
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

  // Положительная проверка (M4, ревью качества 02.11): без неё первый сторож
  // прошёл бы и при полностью вырезанном шлагбауме — отсутствие старого
  // текста ничего не говорит о том, что новый текст действительно зовётся.
  it.each([['chat.service.ts'], ['chat.controller.ts']])('%s зовёт noTokensReply(', (file) => {
    expect(live(file)).toContain('noTokensReply(');
  });
});
