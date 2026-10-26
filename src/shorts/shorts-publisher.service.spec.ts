import { Logger } from '@nestjs/common';
import { GrammyError, HttpError, InputFile } from 'grammy';
import { buildYoutubeKeyboard } from './short-callback';
import { MAX_PUBLISH_ATTEMPTS, STUCK_PUBLISHING_MINUTES, ShortsPublisherService } from './shorts-publisher.service';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;
const SENT = { message_id: 501, chat: { id: -1003290853538, username: 'linkeontest' } };

interface FakeOpts {
  /** Запись успеха площадки: падает (база моргнула) или не находит строку. */
  successWrite?: 'throw' | 'none';
}

/** База в миниатюре: ровно те запросы, что делает публикатор. Условия на статус — как в SQL. */
function fakeDb(over: Record<string, any> = {}, opts: FakeOpts = {}) {
  const v: any = {
    id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', title: 'Залог', slug: 'zalog_ab12',
    status: 'approved', approved_at: '2026-10-25T00:00:00Z', attempts: 0,
    video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', duration_ms: 44000,
    captions: { telegram: 'TG-подпись', vk: 'VK', youtube: { title: 'YT-заголовок', description: 'YT-описание', tags: ['аренда'] } },
    ...over,
  };
  const pubs = new Map<string, any>();
  const humanApproved = (s: string) => !!v.approved_at || !s.includes('approved_at IS NOT NULL');
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT id FROM short_video')) {
      return { rows: v.status === 'approved' && humanApproved(s) ? [{ id: v.id }] : [] };
    }
    if (s.startsWith("UPDATE short_video SET status = 'publishing'")) {
      if (v.status !== 'approved' || !humanApproved(s)) return { rows: [] };
      v.status = 'publishing';
      v.attempts += 1;
      return { rows: [{ ...v }] };
    }
    if (s.startsWith('UPDATE short_video SET updated_at = now()')) {
      return v.status === 'publishing' ? { rows: [{ alive: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (s.startsWith('INSERT INTO short_publication')) {
      if (!pubs.has(p[1])) pubs.set(p[1], { short_id: p[0], platform: p[1], status: 'pending', attempts: 0 });
      return { rows: [] };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'publishing'")) {
      const row = pubs.get(p[1]);
      if (!row || !['pending', 'failed'].includes(row.status)) return { rows: [] };
      row.status = 'publishing';
      row.attempts += 1;
      return { rows: [{ ...row }] };
    }
    if (s.startsWith('UPDATE short_publication SET status = $3')) {
      if (opts.successWrite === 'throw') throw new Error('Connection terminated unexpectedly');
      if (opts.successWrite === 'none') return { rows: [], rowCount: 0 };
      const row = pubs.get(p[1]);
      const from = s.includes("AND status IN ('pending', 'publishing', 'failed')") ? ['pending', 'publishing', 'failed'] : ['publishing'];
      if (!from.includes(row.status)) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: p[2], external_id: p[3], url: p[4], last_error: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'failed'")) {
      const row = pubs.get(p[1]);
      if (row.status !== 'publishing') return { rows: [], rowCount: 0 };
      Object.assign(row, { status: 'failed', last_error: p[2] });
      return { rows: [], rowCount: 1 };
    }
    // Неизвестный исход: строка площадки и ролик — в failed одним запросом.
    if (s.startsWith("WITH pub AS ( UPDATE short_publication SET status = 'failed'")) {
      const row = pubs.get(p[1]);
      if (row.status === 'publishing') Object.assign(row, { status: 'failed', last_error: p[2] });
      if (v.status !== 'publishing') return { rows: [], rowCount: 0 };
      Object.assign(v, { status: 'failed', failed_from: 'publishing', failure_notified: false, last_error: p[3] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM short_publication')) return { rows: [...pubs.values()].map((r) => ({ ...r })) };
    const m = s.match(/^UPDATE short_video SET status = '(published|approved|failed)'/);
    if (m) {
      if (v.status !== 'publishing') return { rows: [], rowCount: 0 };
      v.status = m[1];
      if (m[1] !== 'published') v.last_error = p[1];
      if (m[1] === 'failed') Object.assign(v, { failed_from: 'publishing', failure_notified: false });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, v, pubs };
}

function setup(db = fakeDb(), channel: string | null = '-1003290853538', platforms: string[] = ['telegram', 'youtube']) {
  const tg = {
    // Бот поднят: TgGrammyClient создаёт его в onModuleInit, только если задан TG_BOT_TOKEN.
    getBot: jest.fn((): any => ({})),
    sendVideo: jest.fn(async (): Promise<any> => SENT),
    sendDocument: jest.fn(async () => ({ message_id: 601 })),
    sendMessage: jest.fn(async () => ({ message_id: 602 })),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ platforms, tgChannelChatId: channel })) };
  const svc = new ShortsPublisherService({ query: db.query } as any, tg as any, storage as any, settings as any);
  return { svc, tg, storage, db };
}

const sqlOf = (db: { query: jest.Mock }) => db.query.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' ').trim());

const env = { ...process.env };
let logError: jest.SpyInstance;
beforeEach(() => {
  process.env.BLOG_APPROVER_TG_ID = String(OWNER);
  delete process.env.SHORTS_STAND;
  logError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  logError.mockRestore();
});
afterAll(() => {
  process.env = env;
});

describe('ShortsPublisherService.publish', () => {
  it('Telegram байтами с обложкой, затем набор YouTube; ролик опубликован', async () => {
    const { svc, tg, db } = setup();
    await svc.publish(ID);

    const [chat, bytes, opts] = tg.sendVideo.mock.calls[0] as any[];
    expect(chat).toBe(-1003290853538);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    expect(opts).toMatchObject({ caption: 'TG-подпись', supports_streaming: true, width: 1080, height: 1920, duration: 44 });
    // Обложка — cover (Bot API 8.3): thumbnail Telegram берёт только до 320 px и 200 КБ, кадр 1080×1920 он молча выбросит.
    expect(opts.cover).toBeInstanceOf(InputFile);
    expect(opts.thumbnail).toBeUndefined();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });

    const [docChat, , filename] = tg.sendDocument.mock.calls[0] as any[];
    expect([docChat, filename]).toEqual([OWNER, 'linkeon-zalog_ab12.mp4']);
    const [msgChat, text, msgOpts] = tg.sendMessage.mock.calls[0] as any[];
    expect(msgChat).toBe(OWNER);
    expect(text).toContain('YouTube — заголовок:\nYT-заголовок');
    expect(text).toContain('YT-описание');
    expect(msgOpts.reply_markup).toEqual(buildYoutubeKeyboard(ID));
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending', external_id: '602' });
    expect(db.v.status).toBe('published');
  });

  it('канал не настроен — Telegram упал, набора YouTube нет, ролик ждёт повтора', async () => {
    const { svc, tg, db } = setup(fakeDb(), null);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram').status).toBe('failed');
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).toMatch(/telegram: канал Telegram не настроен/);
  });

  it('третья неудачная попытка — failed с этапом publishing', async () => {
    const { svc, db } = setup(fakeDb({ attempts: 2 }), null);
    await svc.publish(ID);
    expect([db.v.status, db.v.failed_from]).toEqual(['failed', 'publishing']);
  });

  it('повтор шлёт только упавшее: Telegram второй раз не уходит', async () => {
    const { svc, tg, db } = setup();
    tg.sendDocument.mockRejectedValueOnce(new Error('файл не принят'));
    await svc.publish(ID);
    expect(db.v.status).toBe('approved');
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect(tg.sendDocument).toHaveBeenCalledTimes(2);
    expect(db.v.status).toBe('published');
  });

  it('бот Telegram не поднят (нет TG_BOT_TOKEN) — отказ до отправки: обычный повтор, а не «пост мог выйти»', async () => {
    const { svc, tg, storage, db } = setup();
    tg.getBot.mockReturnValue(undefined);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(storage.download).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'failed', last_error: 'бот Telegram не настроен — TG_BOT_TOKEN' });
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).toMatch(/telegram: бот Telegram не настроен — TG_BOT_TOKEN/);
    expect(db.v.last_error).not.toMatch(/пост мог выйти/);

    // Предел попыток — как у любого отказа: failed с этапом publishing.
    const last = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }));
    last.tg.getBot.mockReturnValue(undefined);
    await last.svc.publish(ID);
    expect(last.tg.sendVideo).not.toHaveBeenCalled();
    expect([last.db.v.status, last.db.v.failed_from]).toEqual(['failed', 'publishing']);
    expect(last.db.v.last_error).not.toMatch(/пост мог выйти/);
  });

  it('ролик не в approved — ничего не отправляется', async () => {
    const { svc, tg } = setup(fakeDb({ status: 'pending_review' }));
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
  });

  it('ролик, который человек не одобрял (approved_at пуст), не захватывается', async () => {
    const { svc, tg, db } = setup(fakeDb({ approved_at: null }));
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(db.v.status).toBe('approved');
  });

  it('площадки только youtube — набор уходит, ролик опубликован', async () => {
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['youtube']);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(db.pubs.has('telegram')).toBe(false);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending' });
    expect(db.v.status).toBe('published');
  });

  it('в настройках нет ни одной поддерживаемой площадки — ошибка, а не published без единого поста', async () => {
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['vk']);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).toMatch(/нет ни одной поддерживаемой площадки/);

    const last = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', []);
    await last.svc.publish(ID);
    expect([last.db.v.status, last.db.v.failed_from]).toEqual(['failed', 'publishing']);
  });

  it('GrammyError от sendVideo — отказ Telegram: обычный повтор, набор YouTube в этом тике не уходит', async () => {
    const { svc, tg, db } = setup();
    tg.sendVideo.mockRejectedValueOnce(
      new GrammyError("Call to 'sendVideo' failed!", { ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 'sendVideo', {}),
    );
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'failed' });
    expect(db.pubs.get('telegram').last_error).toMatch(/chat not found/);
    expect(db.v.status).toBe('approved');

    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(2);
    expect(db.v.status).toBe('published');
  });

  it.each([
    ['HttpError (обрыв соединения)', () => new HttpError("Network request for 'sendVideo' failed!", new Error('socket hang up'))],
    ['таймаут вне grammy', () => new Error('Request to sendVideo timed out after 500 seconds')],
    ['GrammyError 5xx', () => new GrammyError("Call to 'sendVideo' failed!", { ok: false, error_code: 502, description: 'Bad Gateway' }, 'sendVideo', {})],
  ])('%s после начала sendVideo — исход неизвестен: строка telegram и ролик сразу в failed, без автоповтора', async (_name, makeError) => {
    const { svc, tg, db } = setup();
    tg.sendVideo.mockRejectedValueOnce(makeError());
    await svc.publish(ID);

    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram').status).toBe('failed');
    expect(db.pubs.get('telegram').last_error).toMatch(/^пост мог выйти — проверьте канал/);
    // Первая же попытка из трёх — и сразу failed: повтор решает владелец, глядя в канал.
    expect(db.v.attempts).toBe(1);
    expect(db.v).toMatchObject({ status: 'failed', failed_from: 'publishing', failure_notified: false });
    expect(db.v.last_error).toMatch(/^публикация: telegram: пост мог выйти/);
    // Что делать — тем же текстом, что уйдёт владельцу: действия админки роликов, а не несуществующая кнопка.
    expect(db.v.last_error).toContain('если пост вышел — mark_published со ссылкой на пост, иначе retry');
    expect(db.v.last_error).not.toContain('«Повторить»');

    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['упала', 'throw'],
    ['не нашла строку', 'none'],
  ] as const)('отправка в канал вернулась, а запись успеха %s — строка не failed, повторной отправки нет', async (_name, mode) => {
    const { svc, tg, db } = setup(fakeDb({}, { successWrite: mode }));
    await svc.publish(ID);

    expect(db.pubs.get('telegram').status).not.toBe('failed');
    expect(tg.sendDocument).not.toHaveBeenCalled();
    // Ролик остаётся в publishing — его разберёт сторож; в approved под автоповтор он не уходит.
    expect(db.v.status).toBe('publishing');
    expect(logError.mock.calls.map((c) => String(c[0])).join('\n')).toContain('https://t.me/linkeontest/501');

    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
  });

  it('сторож забрал ролик, пока качались файлы, — в канал не уходит', async () => {
    const { svc, tg, storage, db } = setup();
    storage.download.mockImplementation(async () => {
      db.v.status = 'approved';
      return Buffer.from('bytes');
    });
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(tg.sendDocument).not.toHaveBeenCalled();
  });

  it('сторож забрал ролик во время отправки — пост всё равно записан, набор YouTube не уходит', async () => {
    const { svc, tg, db } = setup();
    tg.sendVideo.mockImplementationOnce(async () => {
      // Сторож: строка telegram — «пост мог выйти», ролик — failed.
      db.pubs.get('telegram').status = 'failed';
      db.v.status = 'failed';
      return SENT;
    });
    await svc.publish(ID);
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.v.status).toBe('failed');
  });

  it('перед каждой площадкой продлевает живость ролика', async () => {
    const { svc, db } = setup();
    await svc.publish(ID);
    const beats = sqlOf(db).filter((s) => s.startsWith("UPDATE short_video SET updated_at = now() WHERE id = $1 AND status = 'publishing' RETURNING 1"));
    expect(beats.length).toBeGreaterThanOrEqual(2);
  });
});

describe('ShortsPublisherService.publishDue', () => {
  it('берёт только ролики, которые одобрял человек', async () => {
    const db = fakeDb({ approved_at: null });
    const { svc, tg } = setup(db);
    await svc.publishDue();
    expect(sqlOf(db)[0]).toContain('approved_at IS NOT NULL');
    expect(tg.sendVideo).not.toHaveBeenCalled();
  });
});

describe('ShortsPublisherService.rearmStuck', () => {
  async function run() {
    const query = jest.fn(async (_sql: string, _p?: any[]) => ({ rows: [] as any[] }));
    const svc = new ShortsPublisherService({ query } as any, {} as any, {} as any, {} as any);
    await svc.rearmStuck();
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    return { s: String(sql).replace(/\s+/g, ' ').trim(), params: params as any[] };
  }

  it('один запрос: зависшие ролики — только в publishing, с блокировкой строк', async () => {
    const { s, params } = await run();
    expect(s).toContain("WITH stuck AS ( SELECT id FROM short_video WHERE status = 'publishing' AND updated_at < now() - make_interval(mins => $1) FOR UPDATE )");
    expect(s).toMatch(/WHERE v\.id = d\.id AND v\.status = 'publishing'/);
    expect(params[0]).toBe(STUCK_PUBLISHING_MINUTES);
    expect(params[3]).toBe(MAX_PUBLISH_ATTEMPTS);
  });

  it('зависшая строка telegram — «пост мог выйти», ролик в failed без автоповтора', async () => {
    const { s, params } = await run();
    expect(s).toContain("SET status = 'failed', last_error = CASE WHEN platform = 'telegram' THEN $2::text ELSE $3::text END");
    expect(s).toContain("EXISTS (SELECT 1 FROM cut c WHERE c.short_id = s.id AND c.platform = 'telegram') AS unknown");
    expect(s).toContain("SET status = CASE WHEN d.unknown OR v.attempts >= $4 THEN 'failed' ELSE 'approved' END");
    expect(s).toContain("failed_from = CASE WHEN d.unknown OR v.attempts >= $4 THEN 'publishing' ELSE v.failed_from END");
    expect(s).toContain('failure_notified = CASE WHEN d.unknown OR v.attempts >= $4 THEN false ELSE v.failure_notified END');
    expect(params[1]).toMatch(/^пост мог выйти — проверьте канал/);
  });

  it('зависли прочие площадки — ролик в approved, а после предела попыток — failed с понятной причиной', async () => {
    const { s, params } = await run();
    expect(params[2]).toMatch(/отправка оборвалась/);
    expect(s).toContain("WHEN v.attempts >= $4 THEN 'публикация оборвалась, попыток было ' || v.attempts || ' — процесс перезапускался посреди отправки'");
  });
});
