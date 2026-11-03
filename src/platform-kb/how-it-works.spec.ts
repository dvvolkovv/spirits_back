import { KB_CLIENTS } from './kb.types';
import { renderArticle } from './render';
import { howItWorks } from './articles/how-it-works';
import { SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Строка справки о поставщиках нейросетей (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 7). Qwen и Kimi — в том же
 * списке, что основные поставщики; оговорка про обучение — как на лендинге
 * (политика конфиденциальности, раздел 3: «По условиям Moonshot AI переданные
 * ей запросы и ответы она вправе после обезличивания использовать для
 * обучения своих моделей»). Статья целиком — на вычитке владельца.
 */
const providersLine = (text: string) =>
  text.split('\n').find((l) => l.includes('Поставщикам нейросетей уходит')) ?? '';

const LINE =
  '- Поставщикам нейросетей уходит то, что нужно для ответа: сообщения, переписка, профиль и файлы. ' +
  'Это Anthropic, OpenAI, Google, ElevenLabs, Яндекс, а также Alibaba Cloud (Qwen) и Moonshot AI (Kimi) — ' +
  'в том числе за пределами страны пользователя. ' +
  'Moonshot AI по своим условиям вправе после обезличивания обучать на присланном свои модели. ' +
  'Данные не продаются.';

const PHONE_LINE = '- Номер телефона нейросетям не передаётся; ИИ-поддержке видны имя и почта, чтобы помочь с аккаунтом.';

/** Предел статьи — kb.spec.ts (MAX_BYTES); запас — под будущую строку о номере. */
const MAX_BYTES = 5 * 1024;
const RESERVE_BYTES = 250;

describe('how-it-works: кому уходят данные', () => {
  const text = renderArticle(howItWorks, 'ru', 'web');
  const line = providersLine(text);

  it('строка о поставщиках — ровно эта', () => {
    expect(line).toBe(LINE);
  });

  it('без повисших оборотов: «в том числе…» не отделено точкой с запятой', () => {
    expect(line).not.toMatch(/;\s*в том числе/);
  });

  // OpenRouter в коде есть (запасной путь фоновых задач: разбор профиля,
  // вспомогательные тексты), но ключа OPENROUTER* в .env прода нет (проверка
  // 02.11.2026): путь мёртв, и называть OpenRouter получателем данных неверно.
  it('OpenRouter получателем не назван — на проде этот путь мёртв', () => {
    expect(text).not.toContain('OpenRouter');
  });

  // Строка о номере — после пунктов 1–6 спеки и чистки релея (03.11.2026),
  // формулировка вычитана владельцем. ИИ-поддержка получает имя и почту
  // (support.service: системный промпт и get_user_context), телефона и
  // user_id — нет.
  it('строка о номере — ровно эта, сразу после строки о поставщиках', () => {
    const lines = text.split('\n');
    const at = lines.indexOf(LINE);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toBe(PHONE_LINE);
  });

  it('строка о поставщиках одна и та же во всех клиентах', () => {
    for (const client of KB_CLIENTS) expect(providersLine(renderArticle(howItWorks, 'ru', client))).toBe(line);
  });

  it(`самый длинный вариант статьи оставляет ≥ ${RESERVE_BYTES} байт до предела ${MAX_BYTES}`, () => {
    let max = 0;
    for (const lang of SUPPORTED_LANGUAGES) {
      for (const client of KB_CLIENTS) max = Math.max(max, Buffer.byteLength(renderArticle(howItWorks, lang, client), 'utf8'));
    }
    expect(MAX_BYTES - max).toBeGreaterThanOrEqual(RESERVE_BYTES);
  });
});
