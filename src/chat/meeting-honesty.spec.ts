import * as fs from 'fs';
import * as path from 'path';
import { MEETING_HONESTY_RULE } from './meeting-honesty';

/// Ассистент не должен выдумывать участие во встрече.
///
/// Повод — живой случай 14.09.2026: на ссылку «подключись к встрече» модель
/// ответила, что она в комнате, слышит участника, ведёт запись и пришлёт
/// расшифровку. Не было ни звонка, ни задания воркеру, ни входа в комнату.
///
/// Тест смотрит и на текст правила, и на исходник сборки промпта: та же
/// ловушка, что с языковой директивой и формой ответа — путей сборки
/// несколько, забыть один легко, а заметит это пользователь.
describe('правило о встречах в промпте ассистента', () => {
  const src = fs.readFileSync(path.join(__dirname, 'chat.service.ts'), 'utf8');

  it('запрещает выдумывать подключение, запись и расшифровку', () => {
    const flat = MEETING_HONESTY_RULE.replace(/\s+/g, ' ');
    expect(flat).toMatch(/Сам зайти во встречу ты НЕ можешь/);
    expect(flat).toMatch(/НИКОГДА не пиши, что ты подключился/);
    expect(flat).toMatch(/ведёшь запись/);
    expect(flat).toMatch(/расшифровку/);
  });

  it('объясняет, что значит отсутствие карточки', () => {
    // Без этого модель знает только запрет и молчит о причине, а пользователь
    // остаётся с «не могу» без единой подсказки, что делать дальше.
    const flat = MEETING_HONESTY_RULE.replace(/\s+/g, ' ');
    expect(flat).toMatch(/карточки не было/);
    expect(flat).toMatch(/ссылку не распознали/);
  });

  it('вставлено во все пути сборки промпта', () => {
    // Считаем по языковому фолбэку — он ровно один на путь.
    const tails = src.match(/LANGUAGE_REPLY_LINE\[DEFAULT_LANGUAGE\]/g) || [];
    const rules = src.match(/MEETING_HONESTY_RULE/g) || [];
    expect(tails.length).toBeGreaterThan(0);
    // -1: строка импорта.
    expect(rules.length - 1).toBeGreaterThanOrEqual(tails.length);
  });

  it('стоит перед языковой директивой, а не после неё', () => {
    // Последняя строка промпта обязана остаться языковой — см.
    // prompt-language-tail.spec.ts. Правило о встречах её не вытесняет.
    const rule = src.indexOf('${MEETING_HONESTY_RULE}\n\n${RESPONSE_STYLE_RULE}');
    const lang = src.indexOf('${LanguageService.buildDirective(userLanguage)}');
    expect(rule).toBeGreaterThan(-1);
    expect(rule).toBeLessThan(lang);
  });
});
