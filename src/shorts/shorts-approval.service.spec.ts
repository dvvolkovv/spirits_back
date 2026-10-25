jest.mock('./short-slot-claim', () => ({
  ...jest.requireActual('./short-slot-claim'),
  approveShortIntoSlot: jest.fn(),
}));

import { InputFile } from 'grammy';
import { NoFreeSlotError } from '../blog/blog-slots';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;

const row = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'roast', source: 'manual', topic_key: 't', title: 'Залог при аренде',
  status: 'pending_review', review_chat_id: OWNER, review_message_id: 12, note_prompt_ids: [], yt_prompt_ids: [],
  slot_at: '2030-01-01T15:00:00.000Z', video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'YT', description: 'D', tags: [] } },
  ...over,
});

function setup(dbRow: any = row()) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT * FROM short_video')) return { rows: dbRow ? [dbRow] : [] };
      if (sql.includes('SELECT status FROM short_publication')) return { rows: [{ status: 'manual_pending' }] };
      return { rows: dbRow ? [dbRow] : [], rowCount: 1 };
    }),
  };
  let nextId = 900;
  const tg = {
    sendVideo: jest.fn(async () => ({ message_id: 500 })),
    sendMessage: jest.fn(async () => ({ message_id: nextId++ })),
    answerCallbackQuery: jest.fn(async () => true),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6], slotHourMsk: 18 })) };
  const topics = { addManual: jest.fn(async (): Promise<any> => ({ id: 'new' })) };
  const svc = new ShortsApprovalService(pg as any, tg as any, storage as any, settings as any, topics as any);
  return { svc, pg, tg, storage, topics };
}

describe('ShortsApprovalService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
    process.env.SHORTS_ENABLED = 'true';
    delete process.env.SHORTS_STAND;
    delete process.env.SHORTS_AUTO_TOPICS;
    delete process.env.MINIO_BUCKET_VIDEOS;
    (approveShortIntoSlot as jest.Mock).mockReset();
  });
  afterAll(() => {
    process.env = env;
  });

  describe('отправка владельцу', () => {
    it('видео байтами, обложка, кнопки; координаты сообщения — в ролик', async () => {
      const { svc, tg, pg, storage } = setup();
      await svc.sendPendingReviews();
      expect(storage.download).toHaveBeenCalledWith({ bucket: 'linkeon-smm-videos', key: 'shorts/v/video.mp4' });
      const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(Buffer.isBuffer(bytes)).toBe(true);
      expect(opts.thumbnail).toBeInstanceOf(InputFile);
      expect(opts.supports_streaming).toBe(true);
      expect(opts.duration).toBe(44);
      expect(opts.caption).toContain('🎬 Ролик на проверку');
      expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`short:ok:${ID}`);
      const last = pg.query.mock.calls[pg.query.mock.calls.length - 1] as any[];
      expect(last[0]).toMatch(/SET review_chat_id = \$2, review_message_id = \$3/);
      expect(last[1]).toEqual([ID, OWNER, 500]);
    });

    it('на стенде — пометка «СТЕНД»', async () => {
      process.env.SHORTS_STAND = 'true';
      const { svc, tg } = setup();
      await svc.sendPendingReviews();
      expect((tg.sendVideo.mock.calls[0] as any[])[2].caption.startsWith('[СТЕНД]')).toBe(true);
    });

    it('нечего отправлять — Telegram не трогаем', async () => {
      const { svc, tg } = setup(null);
      await svc.sendPendingReviews();
      expect(tg.sendVideo).not.toHaveBeenCalled();
    });
  });

  describe('кнопки', () => {
    const cb = (action: string, from = OWNER) => ({
      id: 'cb', data: `short:${action}:${ID}`, from: { id: from }, message: { chat: { id: OWNER }, message_id: 12 },
    });

    it('чужая кнопка — не наша', async () => {
      const { svc } = setup();
      expect(await svc.handleCallback({ id: 'cb', data: 'blog:ok:1', from: { id: OWNER } })).toBe(false);
    });

    it('кнопки — только у владельца', async () => {
      const { svc, tg, pg } = setup();
      expect(await svc.handleCallback(cb('ok', 42))).toBe(true);
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Эти кнопки — для владельца канала' });
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('«Одобрить» — слот и дата владельцу', async () => {
      (approveShortIntoSlot as jest.Mock).mockResolvedValue({
        slot: new Date('2030-01-01T15:00:00.000Z'), now: new Date('2029-12-31T12:00:00.000Z'),
      });
      const { svc, tg } = setup();
      await svc.handleCallback(cb('ok'));
      expect(approveShortIntoSlot).toHaveBeenCalledWith(expect.anything(), ID, new Date('2030-01-01T15:00:00.000Z'), { slotDays: [2, 4, 6], slotHourMsk: 18 });
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Одобрено. Опубликую завтра в 18:00 МСК.' });
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Одобрено. Опубликую завтра в 18:00 МСК.');
    });

    it('«Одобрить» без свободного слота — причина владельцу, ролик остаётся на проверке', async () => {
      (approveShortIntoSlot as jest.Mock).mockRejectedValue(new NoFreeSlotError('все 60 ближайших слотов расписания заняты'));
      const { svc, tg } = setup();
      await svc.handleCallback(cb('ok'));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/не одобрен — все 60 ближайших слотов/);
    });

    it('кнопка под устаревшим сообщением — отказ, ролик не трогается', async () => {
      // Новая версия ещё не отправлена (review_message_id обнулён студией) или уже ушла другим сообщением.
      for (const fresh of [null, 13]) {
        (approveShortIntoSlot as jest.Mock).mockClear();
        const { svc, tg, pg } = setup(row({ review_message_id: fresh }));
        expect(await svc.handleCallback(cb('ok'))).toBe(true);
        expect(approveShortIntoSlot).not.toHaveBeenCalled();
        expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Это сообщение устарело: ролик переделан, решение — под свежим сообщением' });
        expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
      }
    });

    it('«Одобрить» у уже обработанного — без записи', async () => {
      const { svc, tg } = setup(row({ status: 'published' }));
      await svc.handleCallback(cb('ok'));
      expect(approveShortIntoSlot).not.toHaveBeenCalled();
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Ролик уже обработан: published' });
    });

    it('«Замечание» — приглашение с полем ответа, его id — в ролик', async () => {
      const { svc, tg, pg } = setup();
      await svc.handleCallback(cb('note'));
      const [chat, text, opts] = tg.sendMessage.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(text).toContain('Что поправить в ролике «Залог при аренде»?');
      expect(opts.reply_markup.force_reply).toBe(true);
      expect(opts.reply_parameters).toEqual({ message_id: 12, allow_sending_without_reply: true });
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('note_prompt_ids =')) as any[];
      expect(upd[1]).toEqual([ID, 900, 20]);
    });

    it('«Переснять» — к режиссёру, «Отклонить» — в отказ, с условием на статус', async () => {
      const { svc, pg } = setup();
      await svc.handleCallback(cb('redo'));
      await svc.handleCallback(cb('no'));
      const writes = pg.query.mock.calls.filter((c: any[]) => String(c[0]).includes('SET status = $2')) as any[];
      expect(writes.map((c) => c[1][1])).toEqual(['directing', 'rejected']);
      expect(writes[0][1][2]).toEqual(['pending_review', 'approved']);
    });

    it('«Выложил на YouTube» — приглашение прислать ссылку', async () => {
      const { svc, tg, pg } = setup(row({ status: 'published' }));
      await svc.handleCallback(cb('yt'));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toContain('Пришлите ссылку на ролик «Залог при аренде» в YouTube');
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('yt_prompt_ids ='))).toBe(true);
    });
  });

  describe('ответы реплаем', () => {
    const reply = (over: Record<string, any> = {}) => ({
      chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, message_id: 50,
      reply_to_message: { message_id: 12 }, text: 'короче и без цифр', ...over,
    });

    it('чужое сообщение — не наше', async () => {
      const { svc } = setup(null);
      expect(await svc.handleReplyEdit(reply())).toBe(false);
    });

    it('реплай не из чата апрувера — не наш, база не трогается', async () => {
      const { svc, pg } = setup();
      expect(await svc.handleReplyEdit(reply({ chat: { id: 555, type: 'private' }, from: { id: 555 } }))).toBe(false);
      expect(pg.query).not.toHaveBeenCalled();
    });

    it('замечание — ролик на переписку', async () => {
      const { svc, pg, tg } = setup();
      expect(await svc.handleReplyEdit(reply())).toBe(true);
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("status = 'writing'")) as any[];
      expect(upd[1]).toEqual([ID, 'короче и без цифр']);
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Принял замечание — поправлю ролик и пришлю заново.');
    });

    it('ролик уже не на проверке — объяснение, а не тишина', async () => {
      const { svc, tg } = setup(row({ status: 'approved' }));
      await svc.handleReplyEdit(reply());
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/уже одобрен/);
    });

    it('голосовое вместо текста — просьба написать текстом', async () => {
      const { svc, tg } = setup();
      await svc.handleReplyEdit(reply({ text: undefined, voice: {} }));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/только текстом/);
    });

    it('ссылка YouTube — отметка manual_done', async () => {
      const { svc, pg, tg } = setup(row({ status: 'published', yt_prompt_ids: ['70'] }));
      await svc.handleReplyEdit(reply({ reply_to_message: { message_id: 70 }, text: 'https://youtu.be/AbCdEfGhIjK' }));
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'manual_done'")) as any[];
      expect(upd[1]).toEqual([ID, 'https://youtube.com/shorts/AbCdEfGhIjK', 'AbCdEfGhIjK']);
      expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Записал ссылку YouTube: https://youtube.com/shorts/AbCdEfGhIjK');
    });

    it('не ссылка YouTube — переспрашивает', async () => {
      const { svc, tg } = setup(row({ status: 'published', yt_prompt_ids: ['70'] }));
      await svc.handleReplyEdit(reply({ reply_to_message: { message_id: 70 }, text: 'выложил' }));
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Не узнал ссылку/);
    });
  });

  describe('/short', () => {
    const msg = (over: Record<string, any> = {}) => ({
      chat: { id: OWNER, type: 'private' }, from: { id: OWNER }, message_id: 33,
      text: '/short Как я спорил с арендодателем о залоге', ...over,
    });

    it('владелец в личке — заказ рубрики case с ключом сообщения', async () => {
      const { svc, topics, tg } = setup();
      expect(await svc.handleShortCommand(msg())).toBe(true);
      expect(topics.addManual).toHaveBeenCalledWith({ topic: 'Как я спорил с арендодателем о залоге', rubric: 'case', sourceRef: `tg:${OWNER}:33` });
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Принял заказ ролика.*Автозапуск выключен/);
    });

    it('не владелец, группа, выключенные ролики — не наша команда', async () => {
      const { svc } = setup();
      expect(await svc.handleShortCommand(msg({ from: { id: 42 } }))).toBe(false);
      expect(await svc.handleShortCommand(msg({ chat: { id: -5, type: 'group' } }))).toBe(false);
      process.env.SHORTS_ENABLED = '';
      expect(await svc.handleShortCommand(msg())).toBe(false);
    });

    it('без темы — подсказка, как заказать', async () => {
      const { svc, topics, tg } = setup();
      await svc.handleShortCommand(msg({ text: '/short' }));
      expect(topics.addManual).not.toHaveBeenCalled();
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Как заказать ролик/);
    });

    it('повтор того же сообщения — второй раз не заводит', async () => {
      const { svc, topics, tg } = setup();
      topics.addManual.mockResolvedValue(null);
      await svc.handleShortCommand(msg());
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/уже заказан/);
    });
  });

  describe('сообщения о сбоях', () => {
    it('упавший ролик — владельцу с причиной, один раз', async () => {
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'съёмка: ответ не годится', failed_from: 'capturing' })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/Ролик «Залог при аренде» не собрался: съёмка: ответ не годится/);
    });
  });
});
