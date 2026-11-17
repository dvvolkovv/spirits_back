import 'reflect-metadata';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { ProductsMcpController } from './products-mcp.controller';
import { signProductToolToken } from '../products/product-tool.token';
import { ChatUploadsService } from '../chat/chat-uploads/chat-uploads.service';

/**
 * note_file — комментарий ассистента к загрузке пользователя. Живёт на той же
 * защищённой точке, что find_files: владелец — из подписи токена, аргумента
 * userId нет. Только веб и только при CHAT_UPLOADS_ENABLED=true.
 */
const FILE_ID = '66666666-6666-4666-8666-666666666666';

describe('note_file на точке /webhook/mcp/products', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeAll(() => { process.env.JWT_SECRET = 'note-file-spec-secret'; });
  afterAll(() => {
    if (OLD_SECRET === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = OLD_SECRET;
  });
  beforeEach(() => { process.env.CHAT_UPLOADS_ENABLED = 'true'; });
  afterEach(() => {
    if (OLD_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_FLAG;
  });

  const make = (activeAssistant: string | null = '3') => {
    const tool = { execute: jest.fn(async () => ({ ok: true })) };
    const files = { searchForUser: jest.fn(async () => ({ ok: true, total: 0, files: [] })) };
    const problems = { reportFromAssistant: jest.fn() };
    const chat = { activeAssistantFor: jest.fn(() => activeAssistant) };
    const uploads = {
      setNote: jest.fn(async (input: any) => ({
        id: input.id,
        userId: input.userId,
        sessionId: `${input.userId}_3`,
        originalName: 'гостиная.jpg',
        mime: 'image/jpeg',
        sizeBytes: 1,
        sha256: 'e'.repeat(64),
        storageKey: 'k/gostinaya.jpg',
        createdAt: '2026-11-16T09:00:00.000Z',
        source: 'web',
        thumbKey: null,
        note: String(input.note).trim(),
        noteUpdatedAt: '2026-11-16T10:00:00.000Z',
        noteAssistantId: input.assistantId,
      })),
    };
    const ctrl = new ProductsMcpController(tool as any, files as any, problems as any, chat as any, uploads as any);
    return { ctrl, tool, files, chat, uploads };
  };
  const bearer = (channel: 'web' | 'telegram' = 'web', opts: any = {}) =>
    `Bearer ${signProductToolToken('u-owner', channel, opts)}`;

  describe('список инструментов', () => {
    it('веб, флаг включён: note_file сразу после find_files, без userId в схеме', () => {
      const { ctrl } = make();
      const tools = ctrl.listTools('web') as any[];
      expect(tools.map((t) => t.name)).toEqual(['manage_product', 'find_files', 'note_file', 'report_problem', 'linkeon_help']);
      const note = tools.find((t) => t.name === 'note_file');
      expect(Object.keys(note.inputSchema.properties)).not.toContain('userId');
    });

    it('веб, флаг выключен: note_file нет — набор прежний', () => {
      delete process.env.CHAT_UPLOADS_ENABLED;
      const { ctrl } = make();
      expect(ctrl.listTools('web').map((t: any) => t.name)).toEqual(['manage_product', 'find_files', 'report_problem', 'linkeon_help']);
    });

    it('Telegram и область help: note_file нет (бот — очередь 2)', () => {
      const { ctrl } = make();
      expect(ctrl.listTools('telegram').map((t: any) => t.name)).not.toContain('note_file');
      expect(ctrl.listTools('telegram', { scope: 'help' }).map((t: any) => t.name)).toEqual(['linkeon_help']);
    });
  });

  describe('вызов', () => {
    it('владелец — из токена, userId из аргументов выброшен; ассистент — свежий ход этого пользователя', async () => {
      const { ctrl, uploads, chat, tool } = make('3');
      const r: any = await ctrl.callTool(
        bearer(),
        { file_id: ` ${FILE_ID} `, note: ' Фото гостиной: серый диван. ', userId: '70000000000' },
        'note_file',
      );
      expect(uploads.setNote).toHaveBeenCalledWith({
        id: FILE_ID,
        userId: 'u-owner',
        note: ' Фото гостиной: серый диван. ',
        assistantId: '3',
      });
      expect(chat.activeAssistantFor).toHaveBeenCalledWith('u-owner');
      expect(r).toEqual({ ok: true, id: FILE_ID, note: 'Фото гостиной: серый диван.' });
      expect(tool.execute).not.toHaveBeenCalled();
    });

    it('хода не нашлось — assistantId null, комментарий всё равно пишется', async () => {
      const { ctrl, uploads } = make(null);
      const r: any = await ctrl.callTool(bearer(), { file_id: FILE_ID, note: 'Договор аренды.' }, 'note_file');
      expect(uploads.setNote.mock.calls[0][0].assistantId).toBeNull();
      expect(r.ok).toBe(true);
    });

    it('чужой или несуществующий файл — ok:false «Файл не найден»', async () => {
      const { ctrl, uploads } = make();
      uploads.setNote.mockRejectedValueOnce(new NotFoundException('Upload not found'));
      const r: any = await ctrl.callTool(bearer(), { file_id: FILE_ID, note: 'текст' }, 'note_file');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/Файл не найден/);
    });

    it('длина вне 1..500 — ok:false с пределом в тексте ошибки', async () => {
      const { ctrl, uploads } = make();
      uploads.setNote.mockRejectedValueOnce(new BadRequestException('Комментарий — от 1 до 500 символов'));
      const r: any = await ctrl.callTool(bearer(), { file_id: FILE_ID, note: '' }, 'note_file');
      expect(r.ok).toBe(false);
      expect(r.error).toContain('500');
    });

    // Прочий сбой (pg, сеть, хранилище): сырой текст ошибки модели не уходит —
    // сообщение драйвера может повторять запрос, имя файла или id. В журнал —
    // только вид ошибки (errKind) и id файла в кавычках (logId); ни текста
    // комментария, ни владельца.
    it('прочий сбой — общий ответ без текста ошибки; в журнале только вид ошибки и id', async () => {
      const { ctrl, uploads } = make();
      const err: any = new Error('connect ECONNREFUSED гостиная.jpg u-owner SELECT secret-detail');
      err.code = 'ECONNREFUSED';
      uploads.setNote.mockRejectedValueOnce(err);
      const logged: string[] = [];
      const capture = (...a: any[]) => { logged.push(a.map((x) => String(x)).join(' ')); };
      const spies = [
        jest.spyOn(Logger.prototype, 'error').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(capture),
        jest.spyOn(Logger.prototype, 'log').mockImplementation(capture),
      ];
      try {
        const r: any = await ctrl.callTool(bearer(), { file_id: FILE_ID, note: 'Комментарий-маркер' }, 'note_file');
        expect(r).toEqual({ ok: false, error: 'внутренняя ошибка, попробуй позже' });
        const all = logged.join('\n');
        expect(all).toContain('Error code=ECONNREFUSED');
        expect(all).toContain(JSON.stringify(FILE_ID));
        expect(all).not.toMatch(/гостиная|secret-detail|u-owner|Комментарий-маркер/);
      } finally {
        spies.forEach((s) => s.mockRestore());
      }
    });

    it('аргументы не той формы не роняют вызов: в сервис уходят строки', async () => {
      const { ctrl, uploads } = make();
      await ctrl.callTool(bearer(), { file_id: 42, note: { text: 'x' } }, 'note_file');
      expect(uploads.setNote).toHaveBeenCalledWith({ id: '', userId: 'u-owner', note: '', assistantId: '3' });
    });

    it('флаг выключен — «Неизвестный инструмент», сервис не зовётся', async () => {
      delete process.env.CHAT_UPLOADS_ENABLED;
      const { ctrl, uploads } = make();
      const r: any = await ctrl.callTool(bearer(), { file_id: FILE_ID, note: 'текст' }, 'note_file');
      expect(r).toEqual({ ok: false, error: 'Неизвестный инструмент: note_file' });
      expect(uploads.setNote).not.toHaveBeenCalled();
    });

    it('токен Telegram — отказ, сервис не зовётся', async () => {
      const { ctrl, uploads } = make();
      const r: any = await ctrl.callTool(bearer('telegram'), { file_id: FILE_ID, note: 'текст' }, 'note_file');
      expect(r.ok).toBe(false);
      expect(uploads.setNote).not.toHaveBeenCalled();
    });

    it('токен с областью help — отказ, сервис не зовётся', async () => {
      const { ctrl, uploads } = make();
      const r: any = await ctrl.callTool(bearer('telegram', { scope: 'help' }), { file_id: FILE_ID, note: 'текст' }, 'note_file');
      expect(r.ok).toBe(false);
      expect(uploads.setNote).not.toHaveBeenCalled();
    });
  });

  // Тот же сторож, что у ChatService в chat-uploads.prompt.spec.ts: зависимость
  // объявлена КЛАССОМ — иначе design:paramtypes сотрётся до Object, и Nest не
  // соберёт контроллер.
  it('DI: конструктор объявляет зависимость классом ChatUploadsService', () => {
    expect(Reflect.getMetadata('design:paramtypes', ProductsMcpController)).toContain(ChatUploadsService);
  });
});
