import * as fs from 'fs';
import * as path from 'path';
import {
  MAX_EDITOR_NOTES,
  MAX_EDITOR_NOTE_LEN,
  appendEditorNote,
  canTransition,
  rowToPost,
} from './blog.types';

describe('canTransition', () => {
  it('idea → drafting разрешён', () => {
    expect(canTransition('idea', 'drafting')).toBe(true);
  });

  it('pending_review → drafting разрешён (кнопка «переписать»)', () => {
    expect(canTransition('pending_review', 'drafting')).toBe(true);
  });

  it('approved → publishing → published — рабочий путь публикации', () => {
    expect(canTransition('approved', 'publishing')).toBe(true);
    expect(canTransition('publishing', 'published')).toBe(true);
  });

  it('publishing → approved разрешён: возврат на повторную попытку отправки', () => {
    expect(canTransition('publishing', 'approved')).toBe(true);
  });

  it('в approved нельзя попасть из drafting или failed — только человек одобряет', () => {
    expect(canTransition('drafting', 'approved')).toBe(false);
    expect(canTransition('failed', 'approved')).toBe(false);
    expect(canTransition('idea', 'approved')).toBe(false);
  });

  it('idea → published запрещён: пост не может выйти минуя апрув', () => {
    expect(canTransition('idea', 'published')).toBe(false);
  });

  it('published — терминальный статус, из него никуда', () => {
    expect(canTransition('published', 'drafting')).toBe(false);
    expect(canTransition('published', 'approved')).toBe(false);
  });

  it('rejected — терминальный статус', () => {
    expect(canTransition('rejected', 'drafting')).toBe(false);
  });

  // Перезапуск черновика — это переход drafting → drafting: и кнопка
  // «Переписать», и подбор осиротевшего черновика кроном приходят именно
  // сюда. Петля ничего не продвигает и апрув не обходит.
  it('drafting → drafting разрешён: перезапуск черновика', () => {
    expect(canTransition('drafting', 'drafting')).toBe(true);
  });

  it('петля на drafting не открывает дорогу мимо апрува', () => {
    expect(canTransition('drafting', 'approved')).toBe(false);
    expect(canTransition('drafting', 'published')).toBe(false);
  });

  it('failed → drafting разрешён: отказ можно перезапустить руками', () => {
    expect(canTransition('failed', 'drafting')).toBe(true);
  });
});

describe('rowToPost', () => {
  it('переводит snake_case строку БД в camelCase объект', () => {
    const post = rowToPost({
      id: 'abc', rubric: 'case', source: 'stats', source_ref: null,
      topic_key: 'arenda', topic_hint: 'про аренду', lang: 'ru',
      title: 'Заголовок', body: 'Текст', image_prompt: 'сцена', image_url: null,
      status: 'pending_review', slot_at: null, published_at: null,
      review_chat_id: '77', review_message_id: '12',
      tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
      created_at: '2026-09-21T10:00:00Z', updated_at: '2026-09-21T10:00:00Z',
    });
    expect(post.topicKey).toBe('arenda');
    expect(post.reviewMessageId).toBe(12);
    expect(post.tgMessageId).toBeNull();
  });

  it('читает накопленные замечания редактора', () => {
    const post = rowToPost({ id: 'a', status: 'drafting', attempts: 0, editor_notes: ['первое', 'второе'] });
    expect(post.editorNotes).toEqual(['первое', 'второе']);
  });

  it('читает отметку о начале работы над черновиком', () => {
    const at = '2026-09-23T10:00:00.000Z';
    expect(rowToPost({ id: 'a', status: 'drafting', attempts: 0, drafting_started_at: at }).draftingStartedAt).toBe(at);
    expect(rowToPost({ id: 'a', status: 'idea', attempts: 0 }).draftingStartedAt).toBeNull();
  });

  /**
   * Пост, заведённый до миграции, колонки не имеет вовсе. Если бы сюда
   * приезжал undefined, редактор получал бы `undefined.length` на ровном
   * месте — и черновик падал бы в failed вместо того, чтобы просто писаться
   * без замечаний.
   */
  it('строка без колонки даёт пустой список, а не undefined', () => {
    expect(rowToPost({ id: 'a', status: 'idea', attempts: 0 }).editorNotes).toEqual([]);
    expect(rowToPost({ id: 'a', status: 'idea', attempts: 0, editor_notes: null }).editorNotes).toEqual([]);
  });
});

/**
 * Имя колонки в миграции и имя, которое читает `rowToPost`, — это один
 * контракт в двух файлах, и разъехаться они могут молча: на проде запрос
 * отработает, `row.editor_notes` окажется undefined, и замечания владельца
 * будут вечно теряться без единой ошибки в логе.
 */
describe('миграция 002', () => {
  const sql = fs.readFileSync(
    path.join(__dirname, 'migrations', '002_editor_notes_and_draft_claim.sql'), 'utf8',
  );

  it('добавляет ровно ту колонку, которую читает rowToPost', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+editor_notes/i);
  });

  it('заводит отметку о начале работы над черновиком', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS\s+drafting_started_at/i);
  });

  /**
   * Пустая отметка = «готов к работе». Поставь сюда DEFAULT now() — и все
   * существующие черновики разом окажутся «в работе», а канал замолчит до
   * протухания порога.
   */
  it('отметка по умолчанию пустая', () => {
    expect(sql).toMatch(/drafting_started_at\s+timestamptz\s*;/i);
  });

  it('повторный прогон не ломается — ALTER идёт через IF NOT EXISTS', () => {
    expect(sql).toMatch(/IF NOT EXISTS/i);
  });

  /** Без DEFAULT старые строки дали бы NULL, и каждый append начинался бы с null. */
  it('колонка не пустая по умолчанию', () => {
    expect(sql).toMatch(/DEFAULT\s+'\{\}'/i);
  });
});

/**
 * Замечания НАКАПЛИВАЮТСЯ. Владелец пишет второе замечание, глядя на второй
 * черновик, — но первое от этого не перестаёт действовать. Если хранить
 * только последнее, редактор чинит одно и ломает другое по кругу, и владелец
 * ходит между двумя дефектами, пока не отправит пост в мусор.
 */
describe('appendEditorNote', () => {
  it('первое замечание ложится в пустой список', () => {
    expect(appendEditorNote([], 'объясни, что такое продукт')).toEqual(['объясни, что такое продукт']);
  });

  it('второе замечание не затирает первое', () => {
    expect(appendEditorNote(['первое'], 'второе')).toEqual(['первое', 'второе']);
  });

  it('порядок — от самого раннего к самому свежему', () => {
    const notes = ['a', 'b'].reduce((acc, n) => appendEditorNote(acc, n), [] as string[]);
    expect(notes).toEqual(['a', 'b']);
  });

  it('пустой список на входе (строка до миграции) не роняет append', () => {
    expect(appendEditorNote(null as any, 'замечание')).toEqual(['замечание']);
    expect(appendEditorNote(undefined as any, 'замечание')).toEqual(['замечание']);
  });

  /**
   * Предел нужен: каждое замечание уходит в промпт редактора целиком, и
   * бесконечный список утопил бы в себе и правила рубрики, и саму тему.
   * Выбрасывается САМОЕ СТАРОЕ, а не самое свежее: свежее — это суждение
   * владельца о черновике, который он видит прямо сейчас, и проглотить его
   * значит на глазах у владельца проигнорировать его правку.
   */
  it('сверх предела уходит самое старое, свежее остаётся', () => {
    let notes: string[] = [];
    for (let i = 1; i <= MAX_EDITOR_NOTES + 2; i++) notes = appendEditorNote(notes, `з${i}`);

    expect(notes).toHaveLength(MAX_EDITOR_NOTES);
    expect(notes[notes.length - 1]).toBe(`з${MAX_EDITOR_NOTES + 2}`);
    expect(notes).not.toContain('з1');
    expect(notes).not.toContain('з2');
  });

  it('замечание длиннее предела обрезается, а не пролезает целиком', () => {
    const huge = 'я'.repeat(MAX_EDITOR_NOTE_LEN + 500);
    const [note] = appendEditorNote([], huge);
    expect(note).toHaveLength(MAX_EDITOR_NOTE_LEN);
  });

  it('пустое замечание слот не занимает', () => {
    expect(appendEditorNote(['первое'], '   ')).toEqual(['первое']);
    expect(appendEditorNote(['первое'], '')).toEqual(['первое']);
  });
});
