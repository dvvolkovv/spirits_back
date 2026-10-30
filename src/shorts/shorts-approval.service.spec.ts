jest.mock('./short-slot-claim', () => ({
  ...jest.requireActual('./short-slot-claim'),
  approveShortIntoSlot: jest.fn(),
}));

import { InputFile } from 'grammy';
import { NoFreeSlotError } from '../blog/blog-slots';
import { approveShortIntoSlot } from './short-slot-claim';
import { REVIEW_LEASE_MINUTES, ShortsApprovalService } from './shorts-approval.service';
import { planSkits } from './short-skit-prompts';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;
/** Токен захвата — lease_until текстом, с микросекундами. */
const LEASE = '2030-01-01 14:45:00.123456+00';

const row = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'roast', source: 'manual', topic_key: 't', title: 'Залог при аренде',
  status: 'pending_review', review_chat_id: OWNER, review_message_id: 12, note_prompt_ids: [], yt_prompt_ids: [],
  slot_at: '2030-01-01T15:00:00.000Z', video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'YT', description: 'D', tags: [] } },
  ...over,
});

/** Ролик, каким его отдаёт захват отправки: сообщения ещё нет, попытка посчитана, токен аренды. */
const fresh = (over: Record<string, any> = {}) =>
  row({ review_chat_id: null, review_message_id: null, lease_token: LEASE, attempts: 1, ...over });

/** Подписи не влезают в подпись видео — уходят вторым сообщением. */
const LONG = { telegram: 'Т'.repeat(900), vk: 'VK', youtube: { title: 'YT', description: 'D', tags: [] } };

const finalWrites = (pg: any) => pg.query.mock.calls.filter((c: any[]) => String(c[0]).includes('review_message_id = $3'));
/** Пауза после неудачи: новая аренда, записанная по токену захвата. */
const pauses = (pg: any) =>
  pg.query.mock.calls.filter((c: any[]) => String(c[0]).includes('lease_until = now() + make_interval') && (c[1] || []).includes(LEASE));

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
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6], slotHourMsk: 18, maxOmniSeconds: 48 })) };
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
    it('видео байтами, обложка, кнопки; координаты сообщения — в ролик по токену захвата', async () => {
      const { svc, tg, pg, storage } = setup(fresh());
      await svc.sendPendingReviews();
      const [claimSql, claimParams] = pg.query.mock.calls[0] as any[];
      expect(claimSql).toMatch(/attempts = attempts \+ 1/);
      expect(claimSql).toMatch(/lease_until::text AS lease_token/);
      expect(claimParams).toEqual([REVIEW_LEASE_MINUTES]);
      expect(storage.download).toHaveBeenCalledWith({ bucket: 'linkeon-smm-videos', key: 'shorts/v/video.mp4' });
      const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(Buffer.isBuffer(bytes)).toBe(true);
      // thumbnail Telegram берёт только JPEG ≤ 200 КБ и ≤ 320 px: кадр 1080×1920 молча проигнорировал бы.
      expect(opts.cover).toBeInstanceOf(InputFile);
      expect(opts.thumbnail).toBeUndefined();
      expect(opts.supports_streaming).toBe(true);
      expect(opts.duration).toBe(44);
      expect(opts.caption).toContain('🎬 Ролик на проверку');
      expect(opts.reply_markup.inline_keyboard[0][0].callback_data).toBe(`short:ok:${ID}`);
      const last = pg.query.mock.calls[pg.query.mock.calls.length - 1] as any[];
      expect(last[0]).toMatch(/SET review_chat_id = \$2, review_message_id = \$3/);
      // Только поверх пустого сообщения и только своим захватом: опоздавший процесс
      // не запишет видео v1 поверх v2 или поверх сообщения соседа.
      expect(last[0]).toMatch(/review_message_id IS NULL AND lease_until = \$4::timestamptz/);
      // Попытки отправки не уходят дальше: одобренный ролик приходит к публикатору с нулём.
      expect(last[0]).toMatch(/attempts = 0/);
      expect(last[1]).toEqual([ID, OWNER, 500, LEASE]);
      expect(tg.sendMessage).not.toHaveBeenCalled();
    });

    it('аренда дольше, чем grammy ждёт ответа на загрузку (500 с)', () => {
      expect(REVIEW_LEASE_MINUTES * 60).toBeGreaterThan(500);
    });

    it('отправку перехватили или ролик изменился — без исключения, подписи вдогонку не шлём', async () => {
      const { svc, tg, pg } = setup(fresh({ captions: LONG }));
      pg.query.mockImplementation(async (sql: string) =>
        (sql.includes('review_message_id = $3') ? { rows: [], rowCount: 0 } : { rows: [fresh({ captions: LONG })], rowCount: 1 }));
      await expect(svc.sendPendingReviews()).resolves.toBeUndefined();
      expect(tg.sendVideo).toHaveBeenCalledTimes(1);
      expect(finalWrites(pg)).toHaveLength(1);
      expect(tg.sendMessage).not.toHaveBeenCalled();
      expect(pauses(pg)).toHaveLength(0);
    });

    it('подписи вторым сообщением — после записи ролика; ответ на них — замечание', async () => {
      const { svc, tg, pg } = setup(fresh({ captions: LONG }));
      await svc.sendPendingReviews();
      const [chat, text] = tg.sendMessage.mock.calls[0] as any[];
      expect(chat).toBe(OWNER);
      expect(text).toMatch(/^Подписи к ролику/);
      const writeAt = pg.query.mock.calls.findIndex((c: any[]) => String(c[0]).includes('review_message_id = $3'));
      expect(pg.query.mock.invocationCallOrder[writeAt]).toBeLessThan(tg.sendMessage.mock.invocationCallOrder[0]);
      const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('note_prompt_ids =')) as any[];
      expect(upd[1]).toEqual([ID, 900, 20]);
    });

    it('подписи вторым сообщением не ушли — видео уже записано, повтора отправки нет', async () => {
      const { svc, tg, pg } = setup(fresh({ captions: LONG }));
      tg.sendMessage.mockRejectedValue(new Error('Too Many Requests: retry after 5'));
      await expect(svc.sendPendingReviews()).resolves.toBeUndefined();
      expect(finalWrites(pg)[0][1]).toEqual([ID, OWNER, 500, LEASE]);
      expect(pauses(pg)).toHaveLength(0);
    });

    it('MinIO не отдал файл — итоговой записи нет, исключение наружу не выходит, владельцу пока не пишем', async () => {
      const { svc, tg, pg, storage } = setup(fresh());
      storage.download.mockRejectedValue(new Error('NoSuchKey: The specified key does not exist.'));
      await expect(svc.sendPendingReviews()).resolves.toBeUndefined();
      expect(tg.sendVideo).not.toHaveBeenCalled();
      expect(finalWrites(pg)).toHaveLength(0);
      expect(tg.sendMessage).not.toHaveBeenCalled();
      expect(pauses(pg)).toHaveLength(0);
    });

    it('третья неудача подряд — одно сообщение владельцу с причиной и пауза в час', async () => {
      const { svc, tg, pg } = setup(fresh({ attempts: 3 }));
      tg.sendVideo.mockRejectedValue(new Error('Request Entity Too Large'));
      await expect(svc.sendPendingReviews()).resolves.toBeUndefined();
      expect(tg.sendMessage).toHaveBeenCalledTimes(1);
      expect(tg.sendMessage).toHaveBeenCalledWith(
        OWNER,
        'Ролик «Залог при аренде» готов, но прислать его на проверку не смог: Request Entity Too Large. Повторяю раз в час.',
      );
      const [pause] = pauses(pg);
      expect(pause[0]).toMatch(/review_message_id IS NULL AND lease_until = \$2::timestamptz/);
      expect(pause[1].slice(0, 3)).toEqual([ID, LEASE, 60]);
      expect(finalWrites(pg)).toHaveLength(0);
    });

    it('четвёртая неудача и дальше — без сообщения, пауза снова час', async () => {
      const { svc, tg, pg } = setup(fresh({ attempts: 4 }));
      tg.sendVideo.mockRejectedValue(new Error('Request Entity Too Large'));
      await svc.sendPendingReviews();
      expect(tg.sendMessage).not.toHaveBeenCalled();
      expect(pauses(pg)[0][1].slice(0, 3)).toEqual([ID, LEASE, 60]);
    });

    it('пауза не записалась (ролик изменился, пока шла попытка) — о старой версии владельцу не пишем', async () => {
      const { svc, tg, pg } = setup(fresh({ attempts: 3 }));
      tg.sendVideo.mockRejectedValue(new Error('Request Entity Too Large'));
      pg.query.mockImplementation(async (sql: string, params: any[] = []) =>
        (params.includes(LEASE) ? { rows: [], rowCount: 0 } : { rows: [fresh({ attempts: 3 })], rowCount: 1 }));
      await svc.sendPendingReviews();
      expect(pauses(pg)).toHaveLength(1);
      expect(tg.sendMessage).not.toHaveBeenCalled();
    });

    it('видео больше 50 МБ — понятная причина, в Telegram не грузим', async () => {
      const { svc, tg, storage } = setup(fresh({ attempts: 3 }));
      storage.download.mockImplementation(async ({ key }: any) =>
        (key.endsWith('video.mp4') ? Buffer.alloc(51 * 1024 * 1024) : Buffer.from('jpg')));
      await svc.sendPendingReviews();
      expect(tg.sendVideo).not.toHaveBeenCalled();
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toContain('файл ролика 51 МБ — больше 50 МБ, Telegram его не примет');
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
      expect(approveShortIntoSlot).toHaveBeenCalledWith(expect.anything(), ID, new Date('2030-01-01T15:00:00.000Z'), { slotDays: [2, 4, 6], slotHourMsk: 18, maxOmniSeconds: 48 });
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
        expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Это сообщение устарело — решение под последним сообщением с роликом' });
        expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
      }
    });

    it('тот же номер сообщения, но из другого чата — тоже устарело', async () => {
      // Номера сообщений уникальны только внутри чата.
      const { svc, tg, pg } = setup();
      const foreign = { ...cb('ok'), message: { chat: { id: 555 }, message_id: 12 } };
      expect(await svc.handleCallback(foreign)).toBe(true);
      expect(approveShortIntoSlot).not.toHaveBeenCalled();
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Это сообщение устарело — решение под последним сообщением с роликом' });
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
    });

    it('«Одобрить» у уже обработанного — без записи', async () => {
      const { svc, tg } = setup(row({ status: 'published' }));
      await svc.handleCallback(cb('ok'));
      expect(approveShortIntoSlot).not.toHaveBeenCalled();
      expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Ролик уже опубликован' });
    });

    it('отказы кнопок — человеческими словами, без внутренних статусов', async () => {
      const cases: [string, string, RegExp][] = [
        ['approved', 'ok', /^Ролик уже одобрен/],
        ['capture_queued', 'ok', /переделывается/],
        ['rendering', 'redo', /переделывается/],
        ['failed', 'redo', /^Ролик упал — что с ним делать, решите в админке: Блог → Ролики$/],
        ['failed', 'note', /^Ролик упал — замечание не принял\. Что с ним делать — в админке: Блог → Ролики, раздел «Упали»\.$/],
        ['rejected', 'no', /^Ролик отклонён/],
        ['published', 'no', /^Ролик уже опубликован/],
        ['writing', 'note', /переписывается/],
        ['animating', 'ok', /переделывается/],
        ['animate_queued', 'note', /оживают/],
      ];
      for (const [status, action, text] of cases) {
        const { svc, tg, pg } = setup(row({ status }));
        await svc.handleCallback(cb(action));
        const answered = String(((tg.answerCallbackQuery.mock.calls[0] as any[])[1] as any).text);
        expect(answered).toMatch(text);
        expect(answered).not.toMatch(/[a-z]{3,}/);
        expect(Array.from(answered).length).toBeLessThanOrEqual(200);
        expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
      }
    });

    it('ролик уже вышел на площадке — «Переснять» и «Отклонить» ничего не меняют', async () => {
      // Между попытками публикации ролик лежит в approved, а пост в канале уже есть.
      for (const action of ['redo', 'no']) {
        const { svc, tg, pg } = setup(row({ status: 'approved' }));
        pg.query.mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT * FROM short_video')) return { rows: [row({ status: 'approved' })] };
          if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
          return { rows: [{ status: 'approved', released: true }] };
        });
        await svc.handleCallback(cb(action));
        const write = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('SET status = $2')) as any[];
        expect(write[0]).toMatch(
          /AND NOT EXISTS \(SELECT 1 FROM short_publication p WHERE p\.short_id = short_video\.id AND p\.status IN \('published', ?'manual_pending', ?'manual_done'\)\)/,
        );
        expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text: 'Ролик уже вышел на площадке — переснять или отклонить нельзя' });
        expect(tg.sendMessage).not.toHaveBeenCalled();
      }
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

    it('«Переснять» не записалось не из-за «вышел» — отказ по свежему статусу; строки нет — «уже обработан»', async () => {
      for (const [after, text] of [
        [{ status: 'publishing', released: false }, 'Ролик уже уходит на площадки'],
        [null, 'Ролик уже обработан'],
      ] as const) {
        const { svc, tg, pg } = setup();
        pg.query.mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT * FROM short_video')) return { rows: [row()] };
          if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
          return { rows: after ? [after] : [] };
        });
        await svc.handleCallback(cb('redo'));
        expect(tg.answerCallbackQuery).toHaveBeenCalledWith('cb', { text });
      }
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

    it('замечание к упавшему ролику — куда его передать: кнопки экрана «Ролики»', async () => {
      const { svc, tg } = setup(row({ status: 'failed', failed_from: 'writing' }));
      await svc.handleReplyEdit(reply());
      const text = String((tg.sendMessage.mock.calls[0] as any[])[1]);
      expect(text).toContain('Ролик упал — замечание не принял. Что с ним делать — в админке: Блог → Ролики, раздел «Упали».');
      expect(text).not.toMatch(/retry|reject|from=/);
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

    it('замечание не записалось (ролик ушёл с проверки) — отказ по свежему статусу', async () => {
      const { svc, pg, tg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('SELECT * FROM short_video')) return { rows: [row()] };
        if (sql.startsWith('UPDATE')) return { rows: [], rowCount: 0 };
        return { rows: [{ status: 'approved', released: false }] };
      });
      expect(await svc.handleReplyEdit(reply())).toBe(true);
      expect((tg.sendMessage.mock.calls[0] as any[])[1]).toMatch(/уже одобрен/);
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
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toMatch(/Принял заказ ролика.*Автозапуск выключен/);
      expect(text).toContain('«Запустить сейчас»');
      expect(text).toContain('раздел «Идеи»');
      expect(text).not.toContain('start_now');
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
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toMatch(/Ролик «Залог при аренде» не собрался: съёмка: ответ не годится/);
      expect(text).toContain('Что дальше — в админке: Блог → Ролики, раздел «Упали»: «Повторить», «Новая сцена» (можно с замечанием) или «Отклонить».');
      expect(text).not.toContain('Новый текст');
      expect(text).not.toMatch(/retry|reject|from=/);
    });

    it('упавшая публикация — владельцу без from: с этапа её не переснять', async () => {
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'публикация: telegram: chat not found', failed_from: 'publishing' })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toMatch(/Ролик «Залог при аренде» не вышел на площадки: публикация: telegram: chat not found/);
      expect(text).toContain('Что дальше — в админке: Блог → Ролики, раздел «Упали»: «Повторить», «Пост вышел» (если пост всё-таки в канале) или «Отклонить».');
      expect(text).not.toMatch(/retry|reject|from=|mark_published/);
    });

    it('упавший ролик со съёмкой — доступен «Новый текст»', async () => {
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'сборка: упала', failed_from: 'rendering', capture: { answerText: 'x' } })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toContain('«Повторить», «Новая сцена», «Новый текст» (можно с замечанием) или «Отклонить».');
    });

    it('упавшая публикация, но пост в канале уже вышел (YouTube упал после Telegram) — только «Повторить»', async () => {
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'публикация: youtube: не загрузилось', failed_from: 'publishing', released: true })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      const text = (tg.sendMessage.mock.calls[0] as any[])[1];
      expect(text).toContain('«Повторить» (пост в канале уже вышел, отклонить нельзя).');
      expect(text).not.toContain('«Отклонить»');
      expect(text).not.toContain('Пост вышел');
    });

    it('Telegram не принял сообщение — флаг возвращается, второй ролик в этом вызове не трогаем', async () => {
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) =>
        (sql.includes('failure_notified = true')
          ? { rows: [row({ status: 'failed', last_error: 'сборка: упала', failed_from: 'rendering' })] }
          : { rows: [], rowCount: 1 }));
      tg.sendMessage.mockRejectedValue(new Error('Bad Gateway'));
      await expect(svc.notifyFailures()).resolves.toBeUndefined();
      expect(pg.query.mock.calls.filter((c: any[]) => String(c[0]).includes('failure_notified = true'))).toHaveLength(1);
      const back = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes('failure_notified = false')) as any[];
      expect(back[0]).toMatch(/WHERE id = \$1 AND status = 'failed'/);
      expect(back[1]).toEqual([ID]);
    });

    it('BLOG_APPROVER_TG_ID не задан — писать некому, флаг не возвращаем', async () => {
      delete process.env.BLOG_APPROVER_TG_ID;
      let given = false;
      const { svc, tg, pg } = setup();
      pg.query.mockImplementation(async (sql: string) => {
        if (sql.includes('failure_notified = true') && !given) {
          given = true;
          return { rows: [row({ status: 'failed', last_error: 'сборка: упала', failed_from: 'rendering' })] };
        }
        return { rows: [] };
      });
      await svc.notifyFailures();
      expect(tg.sendMessage).not.toHaveBeenCalled();
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('failure_notified = false'))).toBe(false);
    });
  });
});

describe('ShortsApprovalService — ролик со сценками', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.BLOG_APPROVER_TG_ID = String(OWNER);
    process.env.SHORTS_ENABLED = 'true';
    delete process.env.SHORTS_STAND;
  });
  afterAll(() => {
    process.env = env;
  });

  it('в подписи владельцу — состав сценок и траты на Omni', async () => {
    const skit = (cast: Array<{ hero: string; role: string }>, box?: number) => ({
      cast, setting: 'a hallway', opening: 'o', action: 'a', lines: [{ hero: cast[0].hero, text: 'Реплика', ...(box ? { box } : {}) }],
    });
    const skits = planSkits({
      conflict: skit([{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }]) as any,
      punchline: skit([{ hero: 'kesha', role: 'жилец' }, { hero: 'galina', role: 'хозяйка квартиры' }], 1) as any,
    });
    const { svc, tg } = setup(fresh({
      format: 'skit',
      script: { hook: 'h', voice: 'madirus', speed: 1.1, lines: [], final: { assistantsCount: 18 }, skits },
      animation: { omniSeconds: 16, keyframes: 2, skits: {} },
    }));
    await svc.sendPendingReviews();
    const caption = (tg.sendVideo.mock.calls[0] as any[])[2].caption as string;
    expect(caption).toContain('Сценки: Гусыня Галина Петровна — хозяйка квартиры, Капибара Кеша — жилец');
    expect(caption).toContain('Omni: 16 из 48 с, кадров 2 ≈ $1,86');
  });
});
