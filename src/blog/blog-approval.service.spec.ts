import { BlogApprovalService } from './blog-approval.service';

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: null, image_url: 'https://minio/i.png',
  status: 'pending_review', slot_at: null, published_at: null,
  review_chat_id: '77', review_message_id: '12', tg_message_id: null, tg_url: null,
  attempts: 0, last_error: null, created_at: '', updated_at: '', ...over,
});

describe('BlogApprovalService.handleCallback', () => {
  it('одобрение переводит пост в approved и назначает слот', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    const sql = pg.query.mock.calls[1][0] as string;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('slot_at');
  });

  it('устаревшая кнопка по уже опубликованному посту ничего не меняет', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [rawRow({ status: 'published' })] }) };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    expect(pg.query).toHaveBeenCalledTimes(1);      // только чтение
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', expect.objectContaining({ text: expect.stringMatching(/уже/i) }));
  });

  it('«в мусор» переводит в rejected', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:no:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(pg.query.mock.calls[1][0]).toContain("status = 'rejected'");
  });

  it('«переписать» возвращает в drafting', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:redo:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(pg.query.mock.calls[1][0]).toContain("status = 'drafting'");
  });

  it('переход, запрещённый машиной состояний, не пишется в базу', async () => {
    const pg = { query: jest.fn() };
    // Пост в approved: кнопка «Опубликовать» из старого сообщения пытается
    // увести его в approved повторно — машина такого перехода не знает.
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ status: 'approved' })] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    expect(pg.query).toHaveBeenCalledTimes(1);   // только чтение
  });

  it('чужой callback игнорируется полностью', async () => {
    const pg = { query: jest.fn() };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleCallback({ id: 'cb1', data: 'agent:xyz', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(handled).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
  });
});

describe('BlogApprovalService.handleReplyEdit', () => {
  it('реплай на черновик заменяет текст поста', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({
      chat: { id: 77 }, text: 'Исправленный текст',
      reply_to_message: { message_id: 12 },
    });

    expect(handled).toBe(true);
    expect(pg.query.mock.calls[1][1]).toContain('Исправленный текст');
  });

  it('реплай на чужое сообщение не перехватывается — текст уйдёт ассистенту', async () => {
    const pg = { query: jest.fn().mockResolvedValueOnce({ rows: [] }) };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({
      chat: { id: 77 }, text: 'Привет', reply_to_message: { message_id: 999 },
    });
    expect(handled).toBe(false);
  });

  it('обычное сообщение без реплая не перехватывается', async () => {
    const pg = { query: jest.fn() };
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit({ chat: { id: 77 }, text: 'Привет' });
    expect(handled).toBe(false);
    expect(pg.query).not.toHaveBeenCalled();
  });
});
