import * as fs from 'fs';
import * as path from 'path';
import { KB_LABEL_KEYS, KB_LABELS } from './labels.generated';
import { labelsFor } from './labels';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Подписи справки и карты «Что есть в Linkeon» — из локалей фронта, скриптом
 * scripts/sync-kb-labels.mjs. Ручная копия (так было в platform-guide.ts до
 * 24.10.2026) молча отстаёт от фронта: переименовали пункт меню — ассистент
 * называет кнопку, которой у пользователя нет.
 */
describe('подписи справки', () => {
  it('ключи — ровно те, что перечислены в label-keys.json, в том же порядке', () => {
    const json = JSON.parse(fs.readFileSync(path.join(__dirname, 'label-keys.json'), 'utf8'));
    expect([...KB_LABEL_KEYS]).toEqual(Object.keys(json));
  });

  it.each([...SUPPORTED_LANGUAGES])('%s: каждая подпись есть, непустая и без разметки', (lang) => {
    const l = KB_LABELS[lang];
    expect(l).toBeDefined();
    for (const k of KB_LABEL_KEYS) {
      expect(typeof l[k]).toBe('string');
      expect(l[k].trim()).not.toBe('');
      expect(l[k]).not.toMatch(/[{}<>]|undefined/);
    }
  });

  it('подписи на языке, а не копия русских', () => {
    expect(labelsFor('ru').studio).toBe('Студия');
    expect(labelsFor('en').studio).toBe('Studio');
    expect(labelsFor('zh').studio).toBe('工作室');
    expect(labelsFor('pt').studio).toBe('Estúdio');
  });

  it('тег языка схлопывается до корня, незнакомый — русские подписи', () => {
    expect(labelsFor('en-US')).toBe(labelsFor('en'));
    expect(labelsFor('xx')).toBe(labelsFor('ru'));
    expect(labelsFor('')).toBe(labelsFor('ru'));
  });
});
