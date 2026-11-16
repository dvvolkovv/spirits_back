import * as fs from 'fs';
import * as path from 'path';
import { markdownEscapeName } from './markdown-name';

describe('markdownEscapeName', () => {
  it('обычное имя (кириллица, пробелы, скобки) не меняется', () => {
    expect(markdownEscapeName('отчёт за ноябрь (1).pdf')).toBe('отчёт за ноябрь (1).pdf');
  });

  it('квадратные скобки экранируются', () => {
    expect(markdownEscapeName('photo [1].png')).toBe('photo \\[1\\].png');
  });

  it('обратный слэш удваивается', () => {
    expect(markdownEscapeName('a\\b.pdf')).toBe('a\\\\b.pdf');
  });

  it('сначала слэш, потом скобка: \\[ не превращается в неэкранированную скобку', () => {
    // Вход x\[y → x\\\[y: удвоенный слэш и отдельно экранированная скобка.
    expect(markdownEscapeName('x\\[y')).toBe('x\\\\\\[y');
  });

  it('chat.controller.ts берёт функцию отсюда и не держит свою копию', () => {
    // Строку истории пишет upload-and-chat, а удаление загрузки ищет её же:
    // две копии экранирования разошлись бы молча — replace() не нашёл бы строку.
    const source = fs.readFileSync(path.join(__dirname, '..', 'chat.controller.ts'), 'utf8');
    expect(source).toContain("import { markdownEscapeName } from './chat-uploads/markdown-name';");
    expect(source).not.toMatch(/function markdownEscapeName\b/);
  });
});
