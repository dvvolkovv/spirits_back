import { KB_CLIENTS } from './kb.types';
import { renderArticle } from './render';
import { howItWorks } from './articles/how-it-works';

/**
 * Строка справки о поставщиках нейросетей (спека
 * 2026-11-02-pii-out-of-prompts-design.md, п. 7). Запасные модели Qwen и Kimi —
 * в том же списке, что основные поставщики; оговорка про обучение — как на
 * лендинге (политика конфиденциальности, раздел 3: «По условиям Moonshot AI
 * переданные ей запросы и ответы она вправе после обезличивания использовать
 * для обучения своих моделей»). Статья целиком — на вычитке владельца.
 */
const providersLine = (text: string) =>
  text.split('\n').find((l) => l.includes('Поставщикам нейросетей уходит')) ?? '';

describe('how-it-works: кому уходят данные', () => {
  const text = renderArticle(howItWorks, 'ru', 'web');
  const line = providersLine(text);

  it('строка о поставщиках на месте, прежние поставщики в ней остались', () => {
    expect(line).not.toBe('');
    for (const p of ['Anthropic', 'OpenAI', 'Google', 'ElevenLabs', 'Яндекс']) expect(line).toContain(p);
  });

  it('запасные модели — Alibaba Cloud (Qwen) и Moonshot AI (Kimi)', () => {
    expect(line).toMatch(/запасные модели[^.]*Alibaba Cloud \(Qwen\)[^.]*Moonshot AI \(Kimi\)/);
  });

  it('оговорка: Moonshot AI вправе обучать свои модели на присланном', () => {
    expect(line).toMatch(/По условиям Moonshot AI[^.]*обучения своих моделей/);
  });

  // OpenRouter в коде есть (запасной путь фоновых задач: разбор профиля,
  // вспомогательные тексты), но ключа OPENROUTER* в .env прода нет (проверка
  // 02.11.2026): путь мёртв, и называть OpenRouter получателем данных неверно.
  it('OpenRouter получателем не назван — на проде этот путь мёртв', () => {
    expect(text).not.toContain('OpenRouter');
  });

  it('данные не продаются — по-прежнему последним словом строки', () => {
    expect(line.trim().endsWith('Данные не продаются.')).toBe(true);
  });

  // Строка «Номер телефона нейросетям не передаётся…» — отдельным выкатом,
  // после пунктов 1–6 спеки и в её точной формулировке.
  it('строки о номере пока нет', () => {
    expect(text).not.toMatch(/номер телефона[^.\n]*не передаётся/i);
  });

  it('строка о поставщиках одна и та же во всех клиентах', () => {
    for (const client of KB_CLIENTS) expect(providersLine(renderArticle(howItWorks, 'ru', client))).toBe(line);
  });
});
