import * as fs from 'fs';
import * as path from 'path';
import { markdownEscapeName, uploadHistoryLink } from './markdown-name';

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
});

describe('uploadHistoryLink', () => {
  const LINK_URL = '/webhook/chat-uploads/11111111-1111-4111-8111-111111111111';

  it('простое имя — та же строка, что пишет upload-and-chat сегодня', () => {
    // Совпадает с UPLOAD_LINK из chat.upload-session.spec.ts.
    expect(uploadHistoryLink('a.pdf', LINK_URL)).toBe(
      '📎 [a.pdf](/webhook/chat-uploads/11111111-1111-4111-8111-111111111111)',
    );
  });

  it('имя с [ ] и \\ экранируется внутри ссылки', () => {
    // Вход x\[1].pdf → x\\\[1\].pdf: слэш удвоен, обе скобки экранированы.
    expect(uploadHistoryLink('x\\[1].pdf', '/webhook/chat-uploads/id')).toBe(
      '📎 [x\\\\\\[1\\].pdf](/webhook/chat-uploads/id)',
    );
  });

  it('скрепка — U+1F4CE, после неё ровно один пробел (байты UTF-8 F0 9F 93 8E 20 5B)', () => {
    // Сверка по байтам: строку истории ищут replace() посимвольно, и
    // вариант скрепки с селектором U+FE0F или другой пробел не нашёлся бы.
    const line = uploadHistoryLink('a.pdf', LINK_URL);
    expect(line.codePointAt(0)).toBe(0x1f4ce);
    expect(Buffer.from(line, 'utf8').subarray(0, 6).toString('hex')).toBe('f09f938e205b');
  });
});

describe('chat.controller.ts — единственный источник строки истории', () => {
  // Строку истории пишет upload-and-chat, а удаление загрузки ищет её же:
  // две копии шаблона или экранирования разошлись бы молча — replace() не
  // нашёл бы строку.
  const source = fs.readFileSync(path.join(__dirname, '..', 'chat.controller.ts'), 'utf8');

  it('импортирует uploadHistoryLink из markdown-name', () => {
    expect(source).toMatch(
      /import \{[^}]*\buploadHistoryLink\b[^}]*\} from '\.\/chat-uploads\/markdown-name';/,
    );
  });

  it('строит строку 📎 сохранённой загрузки через uploadHistoryLink', () => {
    expect(source).toMatch(/uploadHistoryLink\(\s*r\.originalName\s*,\s*this\.chatUploads!?\.ownerUrl\(r\.id\)\s*\)/);
  });

  it('не держит своей копии: ни функций, ни рукописного шаблона `📎 [${`', () => {
    expect(source).not.toMatch(/function markdownEscapeName\b/);
    expect(source).not.toMatch(/function uploadHistoryLink\b/);
    expect(source).not.toContain('📎 [${');
  });
});
