import axios from 'axios';
import { BlogApprovalService } from './blog-approval.service';
import { buildBlogKeyboard } from './blog-callback';

jest.mock('axios');

const rawRow = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', source_ref: null, topic_key: 'k', topic_hint: null,
  lang: 'ru', title: 'З', body: 'Т', image_prompt: null, image_url: 'https://minio/i.png',
  status: 'pending_review', slot_at: null, published_at: null,
  review_chat_id: '77', review_message_id: '12', tg_message_id: null, tg_url: null,
  attempts: 0, last_error: null, created_at: '', updated_at: '', ...over,
});

const draft = (over: any = {}) => ({
  id: 'p1', rubric: 'case', source: 'stats', sourceRef: null, topicKey: 'k', topicHint: null,
  lang: 'ru', title: 'Заголовок', body: 'Текст черновика', imagePrompt: null,
  imageUrl: 'https://my.linkeon.io/smm-media/i.png', status: 'drafting', slotAt: null,
  publishedAt: null, reviewChatId: null, reviewMessageId: null, tgMessageId: null, tgUrl: null,
  attempts: 0, lastError: null, createdAt: '', updatedAt: '', ...over,
});

/**
 * Telegram не скачивает картинку по нашей ссылке: my.linkeon.io за РФ-edge
 * Selectel, фетчер Telegram до него не доходит и отвечает 400 «failed to get
 * HTTP URL content». Проверено на проде: тот же файл мультипартом принимается.
 */
describe('BlogApprovalService.sendForReview', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('png-bytes') });
  });

  it('черновик уходит владельцу байтами, а не ссылкой', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 55 }), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.sendForReview(draft() as any, 77);

    expect(axios.get).toHaveBeenCalledWith(
      'https://my.linkeon.io/smm-media/i.png',
      expect.objectContaining({ responseType: 'arraybuffer' }),
    );
    const [chatId, photo] = tg.sendPhoto.mock.calls[0];
    expect(chatId).toBe(77);
    expect(Buffer.isBuffer(photo)).toBe(true);
    expect((photo as Buffer).toString()).toBe('png-bytes');
  });

  it('координаты сообщения запоминаются — иначе правка реплаем не найдёт пост', async () => {
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const tg = { sendPhoto: jest.fn().mockResolvedValue({ message_id: 55 }), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.sendForReview(draft() as any, 77);

    expect(pg.query.mock.calls[0][0]).toContain("status = 'pending_review'");
    expect(pg.query.mock.calls[0][1]).toEqual(['p1', 77, 55]);
  });

  /**
   * Текст черновика уже стоил похода к редактору, а картинка лежит в MinIO и
   * никуда не делась. Ронять пост в failed из-за недоступного на пять секунд
   * хранилища — терять работу на ровном месте: владельцу полезнее увидеть
   * черновик текстом и решить самому (в том числе «Переписать», что заодно
   * перерисует картинку).
   */
  it('картинка не скачалась — черновик всё равно приходит владельцу, текстом с кнопками', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const tg = { sendPhoto: jest.fn(), sendMessage: jest.fn().mockResolvedValue({ message_id: 56 }) };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.sendForReview(draft() as any, 77);

    expect(tg.sendPhoto).not.toHaveBeenCalled();
    const [chatId, text, options] = tg.sendMessage.mock.calls[0];
    expect(chatId).toBe(77);
    expect(text).toContain('Текст черновика');        // сам черновик, а не одна жалоба
    expect(text).toContain('ECONNREFUSED');           // и причина, по которой он без картинки
    expect(options.reply_markup).toEqual(buildBlogKeyboard('p1'));
    // Кнопки привязаны к тому сообщению, которое реально ушло.
    expect(pg.query.mock.calls[0][1]).toEqual(['p1', 77, 56]);
  });

  it('если и текст не ушёл — ошибка наверх, пост не числится показанным', async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error('ECONNREFUSED'));
    const pg = { query: jest.fn().mockResolvedValue({ rows: [] }) };
    const tg = { sendPhoto: jest.fn(), sendMessage: jest.fn().mockRejectedValue(new Error('bot was blocked')) };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await expect(svc.sendForReview(draft() as any, 77)).rejects.toThrow('bot was blocked');
    expect(pg.query).not.toHaveBeenCalled();
  });
});

describe('BlogApprovalService.handleCallback', () => {
  /**
   * Слот считается от «сейчас», поэтому дата в тексте детерминирована только
   * при зафиксированном времени — иначе тест то и дело переезжал бы между
   * «сегодня»/«завтра»/днём недели в зависимости от того, когда его гоняют.
   */
  afterEach(() => {
    jest.useRealTimers();
  });

  it('одобрение переводит пост в approved, назначает слот и называет дату/время публикации во всплывашке', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-21T05:00:00Z'));   // пн, 08:00 МСК — слот пн 10:00 МСК ещё не прошёл

    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    const sql = pg.query.mock.calls[1][0] as string;
    expect(sql).toContain("status = 'approved'");
    expect(sql).toContain('slot_at');

    // слот в тот же московский день, что и «сейчас» → «сегодня», а не день недели
    expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', expect.objectContaining({
      text: expect.stringContaining('сегодня в 10:00 МСК'),
    }));
  });

  /**
   * Всплывашка живёт секунды и легко пропускается — та же дата обязана
   * задержаться в истории чата отдельным сообщением через notify().
   */
  it('следом в личку уходит отдельное сообщение с той же датой публикации', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T12:00:00Z'));   // вт, 15:00 МСК — ближайший слот ср 10:00 МСК → «завтра»

    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    // chatId — из самого callback (тот чат, где нажали кнопку)
    expect(tg.sendMessage).toHaveBeenCalledWith(77, expect.stringContaining('завтра в 10:00 МСК'));
    // и то же сообщение, что ушло во всплывашку — дата не должна разъехаться между ними
    const popupText = tg.answerCallbackQuery.mock.calls[0][1].text as string;
    const chatText = tg.sendMessage.mock.calls[0][1] as string;
    expect(chatText).toBe(popupText);
  });

  /** Telegram отвергает текст всплывашки answerCallbackQuery длиннее 200 символов. */
  it('текст всплывашки укладывается в 200-символьный лимит Telegram даже для самого длинного дня недели', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-21T05:00:00Z'));

    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    // «воскресенье» — самое длинное название дня недели; единственный слот в неделе,
    // чтобы гарантированно получить именно его, а не «сегодня»/«завтра».
    const settings = { get: jest.fn().mockResolvedValue({ channelChatId: '-100', slotDays: [7], slotHourMsk: 10, imageStyle: '' }) };
    const svc = new BlogApprovalService(pg as any, tg as any, settings as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:ok:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });

    const text = tg.answerCallbackQuery.mock.calls[0][1].text as string;
    expect(text).toContain('воскресенье');
    expect(text.length).toBeLessThanOrEqual(200);
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

  /**
   * Отметка о начале работы гасится там же, где пост отправляют на
   * переработку: пустая отметка означает «готов к работе прямо сейчас».
   * Не погасить её значит заставить владельца ждать протухания порога, то
   * есть до пятнадцати минут вместо одного тика.
   */
  it('«переписать» освобождает пост под захват — отметка гасится', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:redo:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(String(pg.query.mock.calls[1][0])).toMatch(/drafting_started_at = NULL/i);
  });

  /**
   * «Переписать» — это и есть переработка, ради которой замечания собирали.
   * Стереть их здесь значит попросить редактора переписать пост, не сказав
   * ему, что было не так.
   */
  it('«переписать» замечания НЕ стирает — редактор пишет с их учётом', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ editor_notes: ['объясни, что такое продукт'] })] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:redo:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(String(pg.query.mock.calls[1][0])).not.toContain('editor_notes');
  });

  /** Мусор — терминальный статус: замечания к нему больше никто не прочтёт. */
  it('«в мусор» заодно стирает замечания', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ editor_notes: ['объясни'] })] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleCallback({ id: 'cb1', data: 'blog:no:p1', from: { id: 77 }, message: { chat: { id: 77 }, message_id: 12 } });
    expect(String(pg.query.mock.calls[1][0])).toContain("editor_notes = '{}'");
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

/**
 * Реплай — это ЗАМЕЧАНИЕ редактору, а не готовый текст поста.
 *
 * Раньше присланный текст ложился прямо в `body`: чтобы поправить одну фразу,
 * владелец должен был написать весь пост за редактора. Смысл кнопки был
 * обратный — сказать, что не так, и получить переписанный вариант.
 */
describe('BlogApprovalService.handleReplyEdit', () => {
  const reply = (over: any = {}) => ({
    chat: { id: 77 }, text: 'читатель не знает, что такое продукт',
    reply_to_message: { message_id: 12 }, ...over,
  });

  it('реплай сохраняется замечанием, а не подменяет текст поста', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit(reply());

    expect(handled).toBe(true);
    const [sql, params] = pg.query.mock.calls[1];
    expect(String(sql)).toContain('editor_notes');
    expect(String(sql)).not.toMatch(/\bbody\s*=/);
    expect(params[1]).toEqual(['читатель не знает, что такое продукт']);
  });

  it('пост уходит на переработку, а не остаётся ждать кнопки «Опубликовать»', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleReplyEdit(reply());

    expect(String(pg.query.mock.calls[1][0])).toContain("status = 'drafting'");
  });

  /** Иначе замечание ждало бы протухания порога, а не ближайшего тика. */
  it('замечание освобождает пост под захват — отметка гасится', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleReplyEdit(reply());

    expect(String(pg.query.mock.calls[1][0])).toMatch(/drafting_started_at = NULL/i);
  });

  /**
   * Второе замечание владелец пишет, глядя на второй черновик, — но первое от
   * этого не перестаёт действовать. Затирать его значит чинить одно и ломать
   * другое по кругу.
   */
  it('второе замечание накапливается поверх первого', async () => {
    const pg = { query: jest.fn() };
    pg.query
      .mockResolvedValueOnce({ rows: [rawRow({ editor_notes: ['объясни, что такое продукт'] })] })
      .mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleReplyEdit(reply({ text: 'и короче' }));

    expect(pg.query.mock.calls[1][1][1]).toEqual(['объясни, что такое продукт', 'и короче']);
  });

  it('бот обещает переписать, а не отчитывается о замене текста', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow()] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    await svc.handleReplyEdit(reply());

    const text = String(tg.sendMessage.mock.calls[0][1]);
    expect(text).toMatch(/перепиш/i);
    expect(text).not.toMatch(/замен/i);
  });

  /**
   * Та же машина состояний, что у кнопок и крона. Мутация `canTransition →
   * true` этот тест не ловит — ловит обратная: если разрешение перестанет
   * спрашиваться, замечание запишется в пост, который уже уехал в канал.
   */
  it('переход, запрещённый машиной состояний, в базу не пишется', async () => {
    const pg = { query: jest.fn() };
    pg.query.mockResolvedValueOnce({ rows: [rawRow({ status: 'published' })] }).mockResolvedValue({ rows: [] });
    const tg = { answerCallbackQuery: jest.fn(), editMessageText: jest.fn(), sendPhoto: jest.fn(), sendMessage: jest.fn() };
    const svc = new BlogApprovalService(pg as any, tg as any, { get: jest.fn() } as any);

    const handled = await svc.handleReplyEdit(reply());

    // Сообщение всё равно наше — пускать его ассистенту нельзя.
    expect(handled).toBe(true);
    expect(pg.query).toHaveBeenCalledTimes(1);          // только чтение
    expect(tg.sendMessage).toHaveBeenCalled();          // и владелец узнал, почему
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
