import { SUPPORTED_LANGUAGES } from '../../common/services/language.service';
import { DELETED_FILE_TEXT, deletedUploadLine } from './deleted-line';

describe('DELETED_FILE_TEXT', () => {
  it('перевод есть ровно для каждого языка из SUPPORTED_LANGUAGES', () => {
    // Новый язык в SUPPORTED_LANGUAGES без перевода здесь — красный тест,
    // а не русская строка в чужой локали.
    expect(Object.keys(DELETED_FILE_TEXT).sort()).toEqual([...SUPPORTED_LANGUAGES].sort());
  });

  it.each([
    ['ru', 'файл удалён'],
    ['en', 'file deleted'],
    ['es', 'archivo eliminado'],
    ['de', 'Datei gelöscht'],
    ['fr', 'fichier supprimé'],
    ['zh', '文件已删除'],
    ['pt', 'ficheiro eliminado'],
  ])('%s → «%s»', (lang, text) => {
    expect(DELETED_FILE_TEXT[lang]).toBe(text);
  });

  it('у каждого языка свой текст — ни один не остался русским', () => {
    const values = Object.values(DELETED_FILE_TEXT);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe('deletedUploadLine', () => {
  it('ru: «📎 <имя> — файл удалён», имя как есть, без markdown-ссылки', () => {
    const line = deletedUploadLine('отчёт [финал].pdf', 'ru');
    expect(line).toBe('📎 отчёт [финал].pdf — файл удалён');
    expect(line).not.toContain('](');
    expect(line).not.toContain('/webhook/chat-uploads/');
  });

  it('en', () => {
    expect(deletedUploadLine('report.pdf', 'en')).toBe('📎 report.pdf — file deleted');
  });

  it.each([
    ['pt-PT', '📎 a.png — ficheiro eliminado'],
    ['EN', '📎 a.png — file deleted'],
    ['en_US', '📎 a.png — file deleted'],
  ])('тег %s нормализуется до корня', (lang, expected) => {
    expect(deletedUploadLine('a.png', lang)).toBe(expected);
  });

  // Имя пришло из multipart: RLO развернул бы хвост имени в пузыре чата и
  // подменил видимое расширение; невидимые символы — мусор. В строке —
  // safeFileName, как в панели «Медиа/Файлы». Символы собраны из кодов.
  it('имя — через safeFileName: bidi, невидимые и управляющие символы не доходят до строки', () => {
    const rlo = String.fromCodePoint(0x202e);
    const zwsp = String.fromCodePoint(0x200b);
    const tag = String.fromCodePoint(0xe0041);
    const line = deletedUploadLine(`счёт${rlo}fdp.exe${zwsp}${tag}\u0007`, 'en');
    expect(line).toBe('📎 счётfdp.exe — file deleted');
    expect(line).not.toMatch(/[\p{Cf}\p{Cc}]/u);
  });

  it('имя из одних невидимых символов — «file», как у safeFileName', () => {
    expect(deletedUploadLine(String.fromCodePoint(0x202e, 0x200b), 'ru')).toBe('📎 file — файл удалён');
  });

  it.each([[null], [undefined], [''], ['xx'], ['klingon']])('язык %p — фолбэк ru', (lang) => {
    expect(deletedUploadLine('a.png', lang as string | null | undefined)).toBe('📎 a.png — файл удалён');
  });
});
