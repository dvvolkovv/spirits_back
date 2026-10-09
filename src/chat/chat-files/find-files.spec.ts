import {
  FIND_FILES_DEFAULT_LIMIT, assistantPart, normalizeForSearch, parseFindFilesInput, plainNote, queryWords, scoreFile,
} from './find-files';

describe('parseFindFilesInput', () => {
  it('пустой вход — без слов, любой вид, без фильтров, лимит по умолчанию', () => {
    expect(parseFindFilesInput(undefined)).toEqual({ query: '', kind: 'any', assistant: '', days: null, limit: FIND_FILES_DEFAULT_LIMIT });
  });
  it('приводит типы и зажимает числа в рамки', () => {
    expect(parseFindFilesInput({ query: '  договор ', kind: 'DOCUMENT', assistant: ' Ирина ', days: '30', limit: 500 }))
      .toEqual({ query: 'договор', kind: 'document', assistant: 'Ирина', days: 30, limit: 30 });
    expect(parseFindFilesInput({ kind: 'spreadsheet', days: 0, limit: -3 })).toMatchObject({ kind: 'any', days: null, limit: FIND_FILES_DEFAULT_LIMIT });
    expect(parseFindFilesInput({ days: 99999 }).days).toBe(3650);
  });
  it('длинные строки обрезаются', () => {
    expect(parseFindFilesInput({ query: 'а'.repeat(500) }).query).toHaveLength(200);
  });
});

describe('слова и очки', () => {
  it('ё и регистр не мешают', () => {
    expect(normalizeForSearch('Отчёт ПО Ёлкам')).toBe('отчет по елкам');
  });
  it('слова запроса — от двух знаков, без повторов', () => {
    expect(queryWords('Договор аренды, договор! и 2026')).toEqual(['договор', 'аренды', '2026']);
  });
  it('слово в имени весит больше, чем в тексте', () => {
    expect(scoreFile(['договор'], 'dogovor.docx', 'Подготовила договор аренды')).toBe(1);
    expect(scoreFile(['договор'], 'Договор.docx', 'без слова')).toBe(3);
    expect(scoreFile(['договор', 'аренды'], 'Договор.docx', 'договор аренды')).toBe(5);
    expect(scoreFile(['отчет'], 'report.pdf', 'про погоду')).toBe(0);
  });
});

describe('plainNote', () => {
  it('без разметки, адресов и маркеров, не длиннее предела', () => {
    const text = '## Итог\n\nСделала **договор аренды** — [Скачать d.docx](https://pub/x/d.docx)\n\n![](https://pub/i.png) [VIDEO_JOB:11111111-2222-4333-8444-555555555555]';
    expect(plainNote(text)).toBe('Итог Сделала договор аренды — Скачать d.docx');
    expect(Array.from(plainNote('я'.repeat(500), 50))).toHaveLength(50);
  });
});

describe('assistantPart', () => {
  it('число, кастомный ассистент, «Чистый лист» срезается', () => {
    expect(assistantPart('u1_12', 'u1')).toBe('12');
    expect(assistantPart('u1_custom:0f8e6a1c-1111-4222-8333-444455556666', 'u1')).toBe('custom:0f8e6a1c-1111-4222-8333-444455556666');
    expect(assistantPart('u1_12_fresh_1728000000000', 'u1')).toBe('12');
    expect(assistantPart('u2_12', 'u1')).toBe('');
  });
});
