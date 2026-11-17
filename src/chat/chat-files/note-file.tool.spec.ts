import { NOTE_FILE_TOOL, NOTE_FILE_TOOL_NAME } from './note-file.tool';
import { UPLOAD_NOTE_MAX_CHARS } from '../chat-uploads/chat-uploads.service';

describe('контракт note_file', () => {
  it('имя совпадает с тем, что разрешено релею и Маше (mcp__products__note_file)', () => {
    expect(NOTE_FILE_TOOL_NAME).toBe('note_file');
    expect(NOTE_FILE_TOOL.name).toBe(NOTE_FILE_TOOL_NAME);
  });

  it('вход — ровно file_id и note, оба обязательны; userId нет — владелец из подписи токена', () => {
    const schema = NOTE_FILE_TOOL.input_schema;
    expect(Object.keys(schema.properties).sort()).toEqual(['file_id', 'note']);
    expect(schema.required).toEqual(['file_id', 'note']);
    expect(schema.additionalProperties).toBe(false);
  });

  it('длина комментария в схеме — та же, что в setNote и в CHECK миграции 002', () => {
    expect(NOTE_FILE_TOOL.input_schema.properties.note.minLength).toBe(1);
    expect(NOTE_FILE_TOOL.input_schema.properties.note.maxLength).toBe(UPLOAD_NOTE_MAX_CHARS);
  });

  // Контракт плана: регулярок в схеме нет. Формат id проверяет сервер
  // (UUID_RE в setNote) и отвечает «Файл не найден».
  it('в схеме нет pattern', () => {
    expect(JSON.stringify(NOTE_FILE_TOOL.input_schema)).not.toContain('pattern');
  });

  it('описание: когда звать, что писать, откуда id и чего не писать', () => {
    const d = NOTE_FILE_TOOL.description;
    expect(d).toMatch(/ПОСЛЕ работы/);
    expect(d).toMatch(/1–3 предложения/);
    expect(d).toMatch(/важное из прежнего комментария сохрани/i);
    expect(d).toMatch(/паролей/);
    expect(d).toMatch(/номеров документов/);
    expect(d).toContain('find_files');
    expect(d).toContain('id=');
    expect(d).toMatch(/userId и телефон не передавай/);
  });

  // Комментарий виден пользователю под файлом в панели — значит, на его
  // языке, а не на языке инструкций модели.
  it('язык комментария — язык разговора: и в описании инструмента, и в описании поля note', () => {
    const phrase = 'Пиши комментарий на языке разговора с пользователем';
    expect(NOTE_FILE_TOOL.description).toContain(phrase);
    expect(NOTE_FILE_TOOL.input_schema.properties.note.description).toContain(phrase);
  });

  // Без этой строки модель переписывает комментарий в каждом ходе, где файл
  // просто упомянут: лишний вызов и затёртый удачный текст.
  it('описание: существующий комментарий без новых решений не переписывать', () => {
    expect(NOTE_FILE_TOOL.description).toContain(
      'Если комментарий уже есть и ничего нового не решили — не переписывай его',
    );
  });
});
