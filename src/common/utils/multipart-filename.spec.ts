import { decodeMultipartFilename } from './multipart-filename';

const ORIGINAL = 'Копия Договора от 01.09.2024г. №7 24.pdf';

/**
 * Ровно то, что делает busboy внутри multer 1.x: читает UTF-8 байты имени как
 * latin1. Проверено живьём против настоящего multer 1.4.5-lts.2 — результат
 * посимвольно совпал со строкой, лежащей в custom_chat_history за 11.08.2026
 * (сессия 79088644408_10).
 *
 * Записывать искажение литералом нельзя: в нём есть непечатаемые байты (॥№
 * U+2116 превращается в 0xE2 0x84 0x96, где два последних — управляющие
 * символы), и в исходнике они не переживают ни копирование, ни редактор.
 */
const mangle = (s: string) => Buffer.from(s, 'utf8').toString('latin1');
const MANGLED = mangle(ORIGINAL);

describe('decodeMultipartFilename', () => {
  it('восстанавливает кириллическое имя, испорченное latin1-декодированием multer', () => {
    expect(decodeMultipartFilename(MANGLED)).toBe(ORIGINAL);
  });

  it('не трогает уже правильное кириллическое имя (повторный вызов безопасен)', () => {
    expect(decodeMultipartFilename(ORIGINAL)).toBe(ORIGINAL);
    expect(decodeMultipartFilename(decodeMultipartFilename(MANGLED))).toBe(ORIGINAL);
  });

  it('не трогает чистый ASCII', () => {
    expect(decodeMultipartFilename('invoice-2026.pdf')).toBe('invoice-2026.pdf');
  });

  it('не ломает настоящее latin1-имя без кириллицы', () => {
    // «Straße.pdf» в latin1 — валидное имя, и наша операция не должна его портить.
    const latin1Name = Buffer.from('Straße.pdf', 'utf8').toString('utf8');
    expect(decodeMultipartFilename('Straße.pdf')).toBe(latin1Name);
  });

  it('возвращает исходник, если декодирование даёт битые байты', () => {
    // Одиночный 0xFF — не начало ни одной валидной UTF-8 последовательности.
    const broken = 'ÿÿ.pdf';
    expect(decodeMultipartFilename(broken)).toBe(broken);
  });

  it('переживает пустое значение и не-строку', () => {
    expect(decodeMultipartFilename('')).toBe('');
    expect(decodeMultipartFilename(undefined)).toBe('');
    expect(decodeMultipartFilename(null)).toBe('');
  });

  it('чинит все семь имён из реальной партии за 11.08 без потерь', () => {
    const batch = [
      'Ответ 02.12.2025г..pdf',
      'письмо от 01.12.2025г. ответчик адвокат.pdf',
      'ДОП.соглашение №1 от 07.11.25.pdf',
      'Копия Договора от 01.09.2024г. №7 24.pdf',
      'Письменные пояснения истца от 31.03.2026г.pdf',
      'пояснения к иску и отзыв представителя ответчика 10.03.26г.(15л).pdf',
      'Акты 5л. по дог.24г..pdf',
    ];
    for (const name of batch) {
      expect(decodeMultipartFilename(mangle(name))).toBe(name);
    }
  });
});
