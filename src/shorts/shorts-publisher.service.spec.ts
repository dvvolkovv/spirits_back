import { Logger } from '@nestjs/common';
import { GrammyError, HttpError, InputFile } from 'grammy';
import { performance } from 'perf_hooks';
import { buildYoutubeKeyboard } from './short-callback';
import { KEEPALIVE_MAX_LAG_MS, MAX_PUBLISH_ATTEMPTS, STUCK_PUBLISHING_MINUTES, ShortsPublisherService, YOUTUBE_MAY_BE_OUT } from './shorts-publisher.service';
import { DOWNLOAD_TIMEOUT_MS } from './short-files';
import { PENDING_UPLOAD_NOTE } from './shorts-youtube.service';
import { YoutubeAttemptSuperseded, YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';
import { SEND_TIMEOUT_MS } from './youtube/youtube-upload';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const OWNER = 777;
const SENT = { message_id: 501, chat: { id: -1003290853538, username: 'linkeontest' } };

interface FakeOpts {
  /** Запись успеха площадки: падает (база моргнула) или не находит строку. */
  successWrite?: 'throw' | 'none';
}

/**
 * Жетон попытки из условия `attempts = $n` в SQL: значение параметра nth-го такого условия
 * (с нуля); условия нет — undefined, и фейк жетон не проверяет, как не проверила бы база.
 */
const fenceArg = (s: string, p: any[], nth = 0): number | undefined => {
  const m = [...s.matchAll(/\battempts = \$(\d+)/g)][nth];
  return m ? p[Number(m[1]) - 1] : undefined;
};
const fits = (fence: number | undefined, attempts: number): boolean => fence === undefined || fence === attempts;

/** База в миниатюре: ровно те запросы, что делает публикатор. Условия на статус и жетон попытки — как в SQL. */
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
      let alive = v.status === 'publishing' && fits(fenceArg(s, p, 0), v.attempts);
      if (s.includes('EXISTS')) {
        // Вместе с роликом — строка площадки: publishing и её жетон.
        const row = pubs.get(p[Number(s.match(/platform = \$(\d+)/)[1]) - 1]);
        alive = alive && !!row && row.status === 'publishing' && fits(fenceArg(s, p, 1), row.attempts);
      }
      return alive ? { rows: [{ alive: 1 }], rowCount: 1 } : { rows: [], rowCount: 0 };
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
      // Набор — только в свою строку (publishing и её жетон) или в никем не занятую (pending, failed).
      const kitFenced = s.includes("status IN ('pending', 'failed') OR (status = 'publishing' AND attempts = $6)");
      const fits6 = kitFenced
        ? ['pending', 'failed'].includes(row.status) || (row.status === 'publishing' && row.attempts === p[5])
        : (s.includes("status IN ('pending', 'publishing', 'failed')") ? ['pending', 'publishing', 'failed'] : ['publishing']).includes(row.status);
      if (!fits6) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: p[2], external_id: p[3], url: p[4], last_error: null });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_publication SET status = 'failed'")) {
      const row = pubs.get(p[1]);
      if (row.status !== 'publishing' || !fits(fenceArg(s, p), row.attempts)) return { rows: [], rowCount: 0 };
      Object.assign(row, { status: 'failed', last_error: p[2] });
      return { rows: [], rowCount: 1 };
    }
    // Неизвестный исход: строка площадки и ролик — в failed одним запросом.
    if (s.startsWith("WITH pub AS ( UPDATE short_publication SET status = 'failed'")) {
      const row = pubs.get(p[1]);
      const pubHit = row.status === 'publishing' && fits(fenceArg(s, p, 0), row.attempts);
      if (pubHit) Object.assign(row, { status: 'failed', last_error: p[2] });
      const needsPub = s.includes('EXISTS (SELECT 1 FROM pub)');
      if (v.status !== 'publishing' || !fits(fenceArg(s, p, 1), v.attempts) || (needsPub && !pubHit)) return { rows: [], rowCount: 0 };
      Object.assign(v, { status: 'failed', failed_from: 'publishing', failure_notified: false, last_error: p[3] });
      return { rows: [{ written: 1 }], rowCount: 1 };
    }
    if (s.startsWith('SELECT * FROM short_publication')) return { rows: [...pubs.values()].map((r) => ({ ...r })) };
    const m = s.match(/^UPDATE short_video SET status = '(published|approved|failed)'/);
    if (m) {
      if (v.status !== 'publishing' || !fits(fenceArg(s, p), v.attempts)) return { rows: [], rowCount: 0 };
      v.status = m[1];
      if (m[1] !== 'published') v.last_error = p[1];
      if (m[1] === 'failed') Object.assign(v, { failed_from: 'publishing', failure_notified: false });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, v, pubs };
}

function setup(db = fakeDb(), channel: string | null = '-1003290853538', platforms: string[] = ['telegram', 'youtube'], youtube: any = undefined) {
  const tg = {
    // Бот поднят: TgGrammyClient создаёт его в onModuleInit, только если задан TG_BOT_TOKEN.
    getBot: jest.fn((): any => ({})),
    sendVideo: jest.fn(async (): Promise<any> => SENT),
    sendDocument: jest.fn(async () => ({ message_id: 601 })),
    sendMessage: jest.fn(async () => ({ message_id: 602 })),
  };
  const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
  const settings = { get: jest.fn(async () => ({ platforms, tgChannelChatId: channel })) };
  const svc = new ShortsPublisherService({ query: db.query } as any, tg as any, storage as any, settings as any, youtube);
  return { svc, tg, storage, db };
}

const sqlOf = (db: { query: jest.Mock }) => db.query.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' ').trim());
/** Запросы с параметрами: s — SQL одной строкой, p — параметры. */
const callsOf = (db: { query: jest.Mock }) =>
  db.query.mock.calls.map((c: any[]) => ({ s: String(c[0]).replace(/\s+/g, ' ').trim(), p: (c[1] ?? []) as any[] }));

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

  it('набор YouTube — заголовок и описание без угловых скобок (YouTube отверг бы их, 400)', async () => {
    const db = fakeDb({
      captions: {
        telegram: 'TG-подпись', vk: 'VK',
        youtube: { title: 'Залог <по договору>', description: 'Срок < 30 дней, штраф > 10%', tags: ['аренда'] },
      },
    });
    const { svc, tg } = setup(db);
    await svc.publish(ID);
    const text = (tg.sendMessage.mock.calls[0] as any[])[1] as string;
    expect(text).toContain('Залог ‹по договору›');
    expect(text).toContain('Срок ‹ 30 дней, штраф › 10%');
    expect(text).not.toMatch(/[<>]/);
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

  it('перед каждой площадкой продлевает живость ролика — с жетоном ролика (attempts из захвата)', async () => {
    const { svc, db } = setup();
    await svc.publish(ID);
    const beats = callsOf(db).filter((c) => c.s.startsWith('UPDATE short_video SET updated_at = now()') && !c.s.includes('EXISTS'));
    expect(beats.length).toBeGreaterThanOrEqual(2);
    for (const b of beats) expect(b.p).toEqual([ID, 1]);
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

describe('ShortsPublisherService.publish — YouTube загрузкой', () => {
  const youtube = (plan: any) => ({
    uploadPlan: jest.fn(async () => plan),
    upload: jest.fn(),
    notifyUploaded: jest.fn(async () => undefined),
  });
  const UPLOAD = { kind: 'upload', privacy: 'unlisted' };
  const kitText = (tg: any): string => (tg.sendMessage.mock.calls[0] as any[])[1];

  it('загрузка: строка youtube published с id и ссылкой, владельцу — сообщение, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false });
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.uploadPlan).toHaveBeenCalledWith(ID);
    expect(yt.notifyUploaded).toHaveBeenCalledWith(ID, 'unlisted');
    // Четвёртым — жетон попытки: attempts из захвата строки YouTube.
    expect(yt.upload).toHaveBeenCalledWith(expect.objectContaining({ id: ID }), 'unlisted', expect.any(Function), 1);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'published', external_id: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk' });
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.v.status).toBe('published');
  });

  it('продление живости, которое публикатор отдаёт загрузке, у своей попытки проходит', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockImplementation(async (_v: any, _p: any, keepAlive: () => Promise<boolean>) => {
      expect(await keepAlive()).toBe(true);
      return { videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false };
    });
    const { svc, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(db.v.status).toBe('published');
  });

  it('план — набор: заметка плана первой строкой, загрузки нет', async () => {
    const yt = youtube({ kind: 'kit', note: 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube' });
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.upload).not.toHaveBeenCalled();
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg).startsWith('Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube\n\nYouTube — заголовок:\nYT-заголовок')).toBe(true);
    expect(yt.notifyUploaded).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending' });
  });

  it('доступ пропал при загрузке — набор с причиной, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeAuthError('HTTP 400 invalid_grant: Token has been expired or revoked.'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg)).toMatch(/^Доступ к каналу YouTube пропал \(HTTP 400 invalid_grant: Token has been expired or revoked\.\) — набор вместо загрузки\. Переподключить: \/youtube/);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending' });
    expect(db.v.status).toBe('published');
  });

  it('отказ YouTube не на последней попытке — строка failed, ролик в approved, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'published' });
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed', last_error: 'начало загрузки: HTTP 403 quotaExceeded: quota' });
    expect(db.v.status).toBe('approved');
  });

  it('отказ YouTube на последней попытке — набор с причиной, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    const { svc, tg, db } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(kitText(tg)).toMatch(/^Не смог загрузить на YouTube: начало загрузки: HTTP 403 quotaExceeded: quota\. Выложите вручную\./);
    expect(db.v.status).toBe('published');
  });

  it('исход загрузки неизвестен не на последней попытке — повтор, набора нет', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube').last_error).toMatch(/спрошу YouTube о прошлой загрузке/);
    expect(db.v.status).toBe('approved');
  });

  it('исход неизвестен на последней попытке — набора нет, ролик failed с причиной про безопасный retry', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const { svc, tg, db } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed' });
    expect(db.v.status).toBe('failed');
    expect(db.v.last_error).toContain(YOUTUBE_MAY_BE_OUT);
  });

  it('403 без явного лимита на вопросе о сессии, последняя попытка (ролик мог бы ходить по кругу без выхода в тексте) — last_error ролика содержит подсказку выхода и причину 403', async () => {
    const cases = [
      // Короткая синтетическая причина — укладывается в last_error целиком, вместе с подсказкой.
      { reason: 'HTTP 403 forbidden: Forbidden', checkFullCause: true },
      // Документированный текст Google для forbidden (61 знак) — подсказка в checkUpload идёт
      // перед причиной, а не после, так что она не обрывается посреди слова (ревью качества).
      { reason: 'HTTP 403 forbidden: The requested operation is forbidden and cannot be completed.', checkFullCause: false },
    ];
    for (const { reason, checkFullCause } of cases) {
      // Ровно то, что бросил бы checkUpload на 403 {errors:[{reason:'forbidden'}]} (youtube-upload.ts).
      const cause = `YouTube отказал в ответе о прошлой загрузке — так бывает, если канал переподключили другим аккаунтом; тогда переподключите прежним (${reason})`;
      const yt = youtube(UPLOAD);
      yt.upload.mockRejectedValue(new YoutubeMaybeUploaded(cause, 403));
      const { svc, tg, db } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
      await svc.publish(ID);
      expect(tg.sendDocument).not.toHaveBeenCalled();
      expect(db.v.status).toBe('failed');
      // Подсказка выхода из затяжного «исход неизвестен» — целиком, не обрезана причиной Google.
      expect(db.v.last_error).toContain(YOUTUBE_MAY_BE_OUT);
      expect(db.v.last_error).toContain('/youtube вручную');
      expect(db.v.last_error).toContain('верните режим');
      expect(db.v.last_error).toContain('переподключите прежним');
      // Короткая причина укладывается в бюджет 500 знаков строки площадки целиком.
      if (checkFullCause) expect(db.v.last_error).toContain(cause);
    }
  });

  it('доступ пропал при живой сессии — к набору предупреждение проверить канал', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeAuthError('HTTP 400 invalid_grant', true));
    const { svc, tg } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(kitText(tg)).toContain(PENDING_UPLOAD_NOTE);
  });

  it('YouTube не помнит прошлую загрузку — набор с предупреждением, ролик опубликован', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeUploadExpired('YouTube уже не помнит прошлую загрузку этого ролика'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(kitText(tg).startsWith(`YouTube уже не помнит прошлую загрузку этого ролика — набор вместо загрузки.\n${PENDING_UPLOAD_NOTE}`)).toBe(true);
    expect(db.v.status).toBe('published');
  });

  it('срок выгрузки файла с запасом меньше порога сторожа: живую выгрузку сторож не заберёт', () => {
    expect(SEND_TIMEOUT_MS + 60_000).toBeLessThan(STUCK_PUBLISHING_MINUTES * 60_000);
  });

  it('Telegram не вышел — к YouTube не идём', async () => {
    const yt = youtube(UPLOAD);
    const { svc, db } = setup(fakeDb(), null, ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.uploadPlan).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'pending' });
  });

  it('загрузка: адрес сессии стирается тем же запросом, что пишет published; Telegram и набор колонку не трогают', async () => {
    const recordOf = (db: any, platform: string) =>
      db.query.mock.calls.find((c: any[]) => String(c[0]).replace(/\s+/g, ' ').startsWith('UPDATE short_publication SET status = $3') && c[1][1] === platform);
    const yt = youtube(UPLOAD);
    yt.upload.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false });
    const a = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await a.svc.publish(ID);
    expect(String(recordOf(a.db, 'youtube')[0])).toContain('upload_session = NULL');
    expect(String(recordOf(a.db, 'telegram')[0])).not.toContain('upload_session');
    const b = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], youtube({ kind: 'kit', note: PENDING_UPLOAD_NOTE }));
    await b.svc.publish(ID);
    expect(String(recordOf(b.db, 'youtube')[0])).not.toContain('upload_session');
  });

  it('ролик нашёлся по прошлой сессии — сообщение без доступа (null)', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: true });
    const { svc } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(yt.notifyUploaded).toHaveBeenCalledWith(ID, null);
  });

  it('отказ на последней попытке: хвостовая точка причины не задваивается', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota.', 403));
    const { svc, tg } = setup(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 }), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(kitText(tg)).toMatch(/^Не смог загрузить на YouTube: начало загрузки: HTTP 403 quotaExceeded: quota\. Выложите вручную\./);
  });

  it('повтор после «исход неизвестен»: Telegram второй раз не уходит, на последней — failed без набора, retry — загрузка', async () => {
    const yt = youtube(UPLOAD);
    yt.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const { svc, tg, db } = setup(fakeDb(), '-1003290853538', ['telegram', 'youtube'], yt);
    for (let i = 1; i < MAX_PUBLISH_ATTEMPTS; i++) {
      await svc.publish(ID);
      expect([db.v.status, db.pubs.get('youtube').status]).toEqual(['approved', 'failed']);
    }
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.v.last_error).toContain(YOUTUBE_MAY_BE_OUT);
    // retry из admin/shorts: строки — в pending (счётчик строки — жетон, не обнуляется), ролик — с нулевым счётом.
    db.pubs.get('youtube').status = 'pending';
    Object.assign(db.v, { status: 'approved', attempts: 0 });
    yt.upload.mockResolvedValue({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: true });
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect(db.v.status).toBe('published');
    expect(yt.notifyUploaded).toHaveBeenCalledTimes(1);
  });
});

/**
 * Жетон попытки (см. platform() публикатора): attempts из захвата ролика (v.attempts) и строки
 * площадки. Попытка, зависшая дольше порога сторожа, пока ролик и строку взяла новая, не шлёт
 * ни файла, ни набора и в чужое не пишет; свою строку отдаёт как отказ.
 */
describe('ShortsPublisherService — жетон попытки', () => {
  const UPLOAD = { kind: 'upload', privacy: 'unlisted' };
  const KIT = { kind: 'kit', note: null };
  const OK = { videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false };
  const SESSION_A = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=a';
  /** Как сервис YouTube отвечает на продление перед файлом, которое не прошло. */
  const LOST = 'перед отправкой файла живость не продлена: ролик или строку YouTube забрала другая попытка либо продление шло слишком долго — не отправляю';
  const youtube = (plan: any = UPLOAD) => ({
    uploadPlan: jest.fn(async () => plan),
    upload: jest.fn(),
    notifyUploaded: jest.fn(async () => undefined),
  });
  /** Telegram уже вышел, YouTube падал раньше: жетон строки после захвата (5) не совпадёт с жетоном ролика (1). */
  const withRows = (db: ReturnType<typeof fakeDb>) => {
    db.pubs.set('telegram', { short_id: ID, platform: 'telegram', status: 'published', attempts: 1 });
    db.pubs.set('youtube', { short_id: ID, platform: 'youtube', status: 'failed', attempts: 4 });
    return db;
  };
  /** Строку площадки захватила новая попытка: статус тот же, жетон — её. */
  const takeRow = (db: ReturnType<typeof fakeDb>, platform = 'youtube') => {
    db.pubs.get(platform).attempts += 1;
  };
  const finals = (db: ReturnType<typeof fakeDb>) => sqlOf(db).filter((s) => /^UPDATE short_video SET status = '(approved|failed|published)'/.test(s));
  const rowFails = (db: ReturnType<typeof fakeDb>) => callsOf(db).filter((c) => c.s.startsWith("UPDATE short_publication SET status = 'failed'"));
  /** Загрузка, как её ведёт сервис YouTube: свой адрес сессии в строке, продление перед файлом не прошло — YoutubeAttemptSuperseded. */
  const uploadLike = (db: ReturnType<typeof fakeDb>, sent: jest.Mock = jest.fn()) =>
    async (_v: any, _p: any, keepAlive: () => Promise<boolean>) => {
      db.pubs.get('youtube').upload_session = SESSION_A;
      if (!(await keepAlive())) throw new YoutubeAttemptSuperseded(LOST);
      sent();
      return OK;
    };
  /** Монотонные часы под контролем теста: продление перед отправкой этой площадки (запрос с EXISTS) «длится» lagMs. */
  const slowBeat = (db: ReturnType<typeof fakeDb>, lagMs: number, platform = 'youtube') => {
    let now = 1_000_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const real = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql: string, p: any[] = []) => {
      const r = await real(sql, p);
      if (String(sql).replace(/\s+/g, ' ').includes('EXISTS (SELECT 1 FROM short_publication') && p[2] === platform) now += lagMs;
      return r;
    });
  };
  afterEach(() => jest.restoreAllMocks());

  it('загрузку сменила новая попытка, а строка уже чужая (последняя попытка) — superseded: строку не трогаем, ни набора, ни итога ролика, ни сообщения', async () => {
    const yt = youtube();
    const db = fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 });
    yt.upload.mockImplementation(async () => {
      takeRow(db);
      throw new YoutubeAttemptSuperseded('строку YouTube захватила другая попытка — файл не шлю');
    });
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    // Отдать строку пробовали только со своим жетоном (1) — чужую он не пустил.
    expect(rowFails(db).map((c) => c.p[3])).toEqual([1]);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'publishing', attempts: 2 });
    expect(db.pubs.get('youtube').last_error).toBeUndefined();
    expect(finals(db)).toEqual([]);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(yt.notifyUploaded).not.toHaveBeenCalled();
    expect(db.v.status).toBe('publishing');
  });

  it('ролик взяла новая попытка, а строка ещё своя — строку отдаём как отказ (адрес сессии на месте), итог чужого ролика не пишется', async () => {
    const yt = youtube();
    const db = fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 });
    const upload = uploadLike(db);
    yt.upload.mockImplementation(async (v: any, p: any, keepAlive: () => Promise<boolean>) => {
      db.v.attempts += 1; // ролик взяла новая попытка, строку YouTube — нет
      return upload(v, p, keepAlive);
    });
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed', attempts: 1, upload_session: SESSION_A, last_error: LOST });
    const [release] = rowFails(db);
    expect(release.s).not.toContain('upload_session');
    // Возврат ролика со старым жетоном не прошёл: ролик новой попытки не тронут.
    expect(db.v).toMatchObject({ status: 'publishing', attempts: MAX_PUBLISH_ATTEMPTS + 1 });
    expect(db.v.last_error).toBeUndefined();
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(yt.notifyUploaded).not.toHaveBeenCalled();
  });

  it.each([
    ['не последняя попытка', 'approved', 0],
    ['последняя попытка', 'failed', MAX_PUBLISH_ATTEMPTS - 1],
  ])('продление перед файлом шло дольше минуты (%s) — файла нет, ролик сразу в %s с причиной из строки, без сторожа', async (_name, status, before) => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const yt = youtube();
    const db = fakeDb({ attempts: before });
    const sent = jest.fn();
    yt.upload.mockImplementation(uploadLike(db, sent));
    slowBeat(db, 61_000);
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(sent).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed', upload_session: SESSION_A, last_error: LOST });
    expect(db.v).toMatchObject({ status, last_error: `публикация: youtube: ${LOST}` });
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(yt.notifyUploaded).not.toHaveBeenCalled();
  });

  it.each([
    [61_000, false],
    [59_000, true],
  ])('ответ на продление живости перед файлом шёл %i мс — продлено: %s', async (lagMs, expected) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const yt = youtube();
    const db = fakeDb();
    let alive: boolean | undefined;
    yt.upload.mockImplementation(async (_v: any, _p: any, keepAlive: () => Promise<boolean>) => {
      alive = await keepAlive();
      return OK;
    });
    slowBeat(db, lagMs);
    const { svc } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(alive).toBe(expected);
    expect(warn.mock.calls.some(([m]) => String(m).includes('продление живости заняло 61 с'))).toBe(!expected);
  });

  it('запас после продления: отправка файла на YouTube и предел задержки ответа на продление вместе меньше порога сторожа', () => {
    expect(SEND_TIMEOUT_MS + KEEPALIVE_MAX_LAG_MS).toBeLessThan(STUCK_PUBLISHING_MINUTES * 60_000);
  });

  it('набор по плану: пока качался файл, строку захватила новая попытка — набор не шлём, строку не трогаем', async () => {
    const db = withRows(fakeDb());
    const { svc, tg, storage } = setup(db, '-1003290853538', ['telegram', 'youtube'], youtube(KIT));
    storage.download.mockImplementation(async () => {
      takeRow(db);
      return Buffer.from('bytes');
    });
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'publishing', attempts: 6 });
    expect(finals(db)).toEqual([]);
  });

  it('набор после отказа доступа: пока качался файл, строку захватила новая попытка — набор не шлём', async () => {
    const yt = youtube();
    yt.upload.mockRejectedValue(new YoutubeAuthError('HTTP 400 invalid_grant'));
    const db = withRows(fakeDb());
    const { svc, tg, storage } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    storage.download.mockImplementation(async () => {
      takeRow(db);
      return Buffer.from('bytes');
    });
    await svc.publish(ID);
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'publishing', attempts: 6 });
  });

  it('набор ушёл, а во время сообщения строку захватила новая попытка — запись набора строку новой не трогает', async () => {
    const db = withRows(fakeDb());
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], youtube(KIT));
    tg.sendMessage.mockImplementationOnce(async () => {
      takeRow(db);
      return { message_id: 602 };
    });
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'publishing', attempts: 6 });
    expect(db.pubs.get('youtube').external_id).toBeUndefined();
    // Запись набора — с жетоном строки этой попытки.
    const record = callsOf(db).find((c) => c.s.startsWith('UPDATE short_publication SET status = $3') && c.p[1] === 'youtube');
    expect(record.p[5]).toBe(5);
  });

  it('набор ушёл, а строку тем временем сторож перевёл в failed — набор всё равно записан: второй набор не нужен', async () => {
    const db = withRows(fakeDb());
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], youtube(KIT));
    tg.sendMessage.mockImplementationOnce(async () => {
      db.pubs.get('youtube').status = 'failed'; // сторож: строка failed, жетон тот же
      return { message_id: 602 };
    });
    await svc.publish(ID);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'manual_pending', external_id: '602' });
  });

  it.each([
    ['строка ещё своя (ролик взяла новая попытка) — строку отдаём как отказ', (db: ReturnType<typeof fakeDb>) => { db.v.attempts += 1; }, 'failed', 5],
    ['строку держит новая попытка — ничего не пишем', (db: ReturnType<typeof fakeDb>) => takeRow(db), 'publishing', 6],
  ])('набор: файл ушёл, а продление перед подписью не прошло — подпись не шлём; %s', async (_name, takeOver, rowStatus, rowAttempts) => {
    const db = withRows(fakeDb());
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], youtube(KIT));
    tg.sendDocument.mockImplementationOnce(async () => {
      takeOver(db);
      return { message_id: 601 };
    });
    await svc.publish(ID);
    expect(tg.sendDocument).toHaveBeenCalledTimes(1);
    expect(tg.sendMessage).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: rowStatus, attempts: rowAttempts });
    // Ролик не тронут: у своей строки итог ролика с чужим жетоном не прошёл, у чужой до итога не дошло.
    expect(db.v.status).toBe('publishing');
  });

  it('перед отправкой в канал — продление с жетоном строки telegram', async () => {
    const db = fakeDb();
    db.pubs.set('telegram', { short_id: ID, platform: 'telegram', status: 'failed', attempts: 2 }); // после захвата — 3
    const { svc, tg } = setup(db);
    await svc.publish(ID);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    const beat = callsOf(db).find((c) => c.s.includes('EXISTS') && c.p[2] === 'telegram');
    expect(beat?.p).toEqual([ID, 1, 'telegram', 3]);
  });

  it('продление перед отправкой в канал шло дольше минуты — в канал не шлём: строка telegram в обычном отказе, ролик в очередь', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = fakeDb();
    slowBeat(db, 61_000, 'telegram');
    const { svc, tg } = setup(db);
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'failed', last_error: expect.stringMatching(/продление шло слишком долго/) });
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).not.toMatch(/пост мог выйти/);
  });

  it('отказ YouTube не записался — строку держит другая попытка: выходим без итога ролика', async () => {
    const yt = youtube();
    const db = fakeDb();
    yt.upload.mockImplementation(async () => {
      takeRow(db); // пока шла загрузка, строку захватила новая попытка
      throw new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403);
    });
    const { svc, tg } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'publishing', attempts: 2 });
    expect(finals(db)).toEqual([]);
    expect(db.v.status).toBe('publishing');
    expect(tg.sendDocument).not.toHaveBeenCalled();
  });

  it('отказ Telegram не записался — строку держит другая попытка: к YouTube не идём, итога ролика нет', async () => {
    const db = fakeDb();
    const { svc, tg } = setup(db);
    tg.getBot.mockImplementation(() => {
      takeRow(db, 'telegram');
      return undefined; // бот не поднят — обычный отказ до отправки
    });
    await svc.publish(ID);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'publishing', attempts: 2 });
    expect(finals(db)).toEqual([]);
    expect(db.v.status).toBe('publishing');
    expect(tg.sendDocument).not.toHaveBeenCalled();
  });

  it('записи попытки — с жетонами: отказ площадки — жетон строки из захвата, возврат ролика в очередь — жетон ролика', async () => {
    const yt = youtube();
    yt.upload.mockRejectedValue(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    const { svc, db } = setup(withRows(fakeDb()), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(rowFails(db).map((c) => c.p[3])).toEqual([5]);
    expect(callsOf(db).find((c) => c.s.startsWith("UPDATE short_video SET status = 'approved'")).p[2]).toBe(1);
    expect([db.pubs.get('youtube').status, db.v.status]).toEqual(['failed', 'approved']);
  });

  it('итог ролика — с жетоном ролика: published, а на последней попытке — failed', async () => {
    const ok = youtube();
    ok.upload.mockResolvedValue(OK);
    const a = setup(withRows(fakeDb()), '-1003290853538', ['telegram', 'youtube'], ok);
    await a.svc.publish(ID);
    expect(callsOf(a.db).find((c) => c.s.startsWith("UPDATE short_video SET status = 'published'")).p[1]).toBe(1);
    expect(a.db.v.status).toBe('published');

    const maybe = youtube();
    maybe.upload.mockRejectedValue(new YoutubeMaybeUploaded('отправка файла оборвалась: socket hang up'));
    const b = setup(withRows(fakeDb({ attempts: MAX_PUBLISH_ATTEMPTS - 1 })), '-1003290853538', ['telegram', 'youtube'], maybe);
    await b.svc.publish(ID);
    expect(callsOf(b.db).find((c) => c.s.startsWith("UPDATE short_video SET status = 'failed'")).p[2]).toBe(MAX_PUBLISH_ATTEMPTS);
    expect(b.db.v.status).toBe('failed');
  });

  it('исход Telegram неизвестен — строка и ролик в failed одним запросом, каждый со своим жетоном', async () => {
    const db = fakeDb();
    db.pubs.set('telegram', { short_id: ID, platform: 'telegram', status: 'failed', attempts: 2 }); // после захвата — 3
    const { svc, tg } = setup(db);
    tg.sendVideo.mockRejectedValueOnce(new HttpError("Network request for 'sendVideo' failed!", new Error('socket hang up')));
    await svc.publish(ID);
    const cte = callsOf(db).find((c) => c.s.startsWith('WITH pub AS'));
    expect([cte.p[4], cte.p[5]]).toEqual([3, 1]);
    expect([db.pubs.get('telegram').status, db.v.status]).toEqual(['failed', 'failed']);
  });

  it('исход Telegram неизвестен, а строку уже держит другая попытка — ничего не записано: ни строку, ни ролик не трогаем', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const db = fakeDb();
    const { svc, tg } = setup(db);
    tg.sendVideo.mockImplementationOnce(async () => {
      takeRow(db, 'telegram');
      throw new HttpError("Network request for 'sendVideo' failed!", new Error('socket hang up'));
    });
    await svc.publish(ID);
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'publishing', attempts: 2 });
    expect(db.v.status).toBe('publishing');
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([m]) => String(m).includes('ничего не записано'))).toBe(true);
    expect(logError.mock.calls.some(([m]) => String(m).includes('автоповтора не будет'))).toBe(false);
  });

  it('продление живости перед файлом YouTube — оба жетона, ролика и строки; жетон строки — четвёртым аргументом upload', async () => {
    const yt = youtube();
    let fence: number | undefined;
    const alive: boolean[] = [];
    yt.upload.mockImplementation(async (_v: any, _p: any, keepAlive: () => Promise<boolean>, f: number) => {
      fence = f;
      alive.push(await keepAlive());
      return OK;
    });
    const { svc, db } = setup(withRows(fakeDb()), '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(fence).toBe(5);
    expect(alive).toEqual([true]);
    expect(callsOf(db).find((c) => c.s.includes('EXISTS') && c.p[2] === 'youtube').p).toEqual([ID, 1, 'youtube', 5]);
  });

  it.each([
    ['строку YouTube захватила новая попытка', (db: ReturnType<typeof fakeDb>) => takeRow(db)],
    ['ролик взяла новая попытка', (db: ReturnType<typeof fakeDb>) => { db.v.attempts += 1; }],
  ])('продление живости перед файлом YouTube — false: %s', async (_name, takeOver) => {
    const yt = youtube();
    const db = fakeDb();
    let alive: boolean | undefined;
    yt.upload.mockImplementation(async (_v: any, _p: any, keepAlive: () => Promise<boolean>) => {
      takeOver(db);
      alive = await keepAlive();
      throw new YoutubeAttemptSuperseded(LOST);
    });
    const { svc } = setup(db, '-1003290853538', ['telegram', 'youtube'], yt);
    await svc.publish(ID);
    expect(alive).toBe(false);
  });
});

/** Скачивание из MinIO — со сроком: зависшее скачивание не должно пережить порог сторожа (STUCK_PUBLISHING_MINUTES). */
describe('ShortsPublisherService — срок скачивания файлов ролика', () => {
  /** Хранилище, которое не отвечает: отпускает только по сигналу срока. Без сигнала — отказ сразу. */
  const hang = ({ abortSignal }: any): Promise<Buffer> => {
    if (!abortSignal) return Promise.reject(new Error('скачивание без срока'));
    return new Promise((_, reject) => abortSignal.addEventListener('abort', () => reject(new Error('скачивание прервано по сроку'))));
  };
  afterEach(() => jest.useRealTimers());

  it('в хранилище уходит abortSignal — для канала (видео и обложка) и для набора', async () => {
    const { svc, storage } = setup();
    await svc.publish(ID);
    expect(storage.download).toHaveBeenCalledTimes(3);
    for (const [arg] of storage.download.mock.calls as any[]) expect(arg.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('скачивание для канала не уложилось в срок — сигнал прерван, строка telegram в обычном отказе, а не «исход неизвестен»', async () => {
    jest.useFakeTimers();
    const { svc, tg, storage, db } = setup();
    storage.download.mockImplementation(hang);
    const run = svc.publish(ID);
    await jest.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await run;
    const signals = (storage.download.mock.calls as any[]).map(([arg]) => arg.abortSignal);
    expect(signals).toHaveLength(2);
    expect(signals.every((s) => s?.aborted)).toBe(true);
    expect(tg.sendVideo).not.toHaveBeenCalled();
    expect(db.pubs.get('telegram')).toMatchObject({ status: 'failed', last_error: 'скачивание прервано по сроку' });
    expect(db.v.status).toBe('approved');
    expect(db.v.last_error).not.toMatch(/пост мог выйти/);
  });

  it('скачивание для набора YouTube не уложилось в срок — строка youtube в обычном отказе, набор не ушёл', async () => {
    jest.useFakeTimers();
    const db = fakeDb();
    db.pubs.set('telegram', { short_id: ID, platform: 'telegram', status: 'published', attempts: 1 });
    const { svc, tg, storage } = setup(db);
    storage.download.mockImplementation(hang);
    const run = svc.publish(ID);
    await jest.advanceTimersByTimeAsync(DOWNLOAD_TIMEOUT_MS);
    await run;
    expect(tg.sendDocument).not.toHaveBeenCalled();
    expect(db.pubs.get('youtube')).toMatchObject({ status: 'failed', last_error: 'скачивание прервано по сроку' });
    expect(db.v.status).toBe('approved');
  });
});
