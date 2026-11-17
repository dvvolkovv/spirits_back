import { uploadKind } from './upload-kind';
import { kindByMime } from '../chat-files/find-files';

/**
 * Вид загрузки пользователя — один на панель «Медиа/Файлы», блок загрузок
 * ассистента и find_files: сначала семейство mime, без него — расширение
 * имени. Разойдутся — человек увидит фото во «Файлах», а ассистент назовёт
 * его документом.
 */
describe('uploadKind', () => {
  it('семейство mime решает первым', () => {
    expect(uploadKind({ mime: 'image/png', originalName: 'scan' })).toBe('image');
    expect(uploadKind({ mime: 'video/mp4', originalName: 'clip' })).toBe('video');
    expect(uploadKind({ mime: 'audio/mpeg', originalName: 'voice' })).toBe('audio');
    // Регистр и параметры mime не мешают: HEIC с айфона — картинка.
    expect(uploadKind({ mime: 'IMAGE/HEIC', originalName: 'IMG_0001.HEIC' })).toBe('image');
    expect(uploadKind({ mime: 'audio/ogg; codecs=opus', originalName: 'voice' })).toBe('audio');
  });

  it('без семейства в mime — по расширению имени', () => {
    expect(uploadKind({ mime: 'application/octet-stream', originalName: 'photo.JPG' })).toBe('image');
    expect(uploadKind({ mime: '', originalName: 'clip.mov' })).toBe('video');
    expect(uploadKind({ mime: 'application/octet-stream', originalName: 'voice.m4a' })).toBe('audio');
  });

  it('расширение берётся от очищенного имени (safeFileName) — как ext в панели', () => {
    // Пробелы по краям: панель покажет «фото.jpg» с ext=jpg — и вид обязан быть image.
    expect(uploadKind({ mime: 'application/octet-stream', originalName: 'фото.jpg  ' })).toBe('image');
    // Невидимый RLO в хвосте имени safeFileName тоже снимает.
    const RLO = String.fromCodePoint(0x202e);
    expect(uploadKind({ mime: '', originalName: `clip.mp4${RLO}` })).toBe('video');
  });

  it('всё прочее — document', () => {
    expect(uploadKind({ mime: 'application/pdf', originalName: 'договор.pdf' })).toBe('document');
    expect(uploadKind({ mime: 'application/zip', originalName: 'архив.zip' })).toBe('document');
    expect(uploadKind({ mime: '', originalName: 'без расширения' })).toBe('document');
  });

  it('пустые поля не роняют разбор', () => {
    expect(uploadKind({ mime: undefined as any, originalName: undefined as any })).toBe('document');
    expect(uploadKind({ mime: null as any, originalName: 'pic.webp' })).toBe('image');
  });

  it('совпадает с видом исходника в find_files (kindByMime)', () => {
    const cases: Array<[string, string]> = [
      ['image/gif', 'a'],
      ['', 'a.mp3'],
      ['text/plain', 'a.txt'],
      ['application/octet-stream', 'a.webm'],
    ];
    for (const [mime, name] of cases) {
      expect(uploadKind({ mime, originalName: name })).toBe(kindByMime(mime, name));
    }
  });
});
