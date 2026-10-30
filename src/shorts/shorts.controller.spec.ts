jest.mock('./short-slot-claim', () => ({
  ...jest.requireActual('./short-slot-claim'),
  approveShortIntoSlot: jest.fn(),
}));

import { BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { NoFreeSlotError } from '../blog/blog-slots';
import { VERSION_SQL } from './short-review';
import { SHORT_SLOT_INDEX, approveShortIntoSlot } from './short-slot-claim';
import { ShortOrderError } from './shorts-topic.service';
import { ShortsController } from './shorts.controller';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const VERSION = '2026-10-30 12:34:56.123456+00';
const video = (over: Record<string, any> = {}) => ({
  id: ID, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't', status: 'failed',
  failed_from: 'capturing', video_key: 'shorts/v/video.mp4', cover_key: null, ...over,
});

function res() {
  const r: any = {};
  r.status = jest.fn(() => r);
  r.json = jest.fn((body: any) => {
    r.body = body;
    return r;
  });
  return r;
}

function setup(answer: (sql: string, params: any[]) => any = () => ({ rows: [], rowCount: 0 })) {
  // Транзакция-заглушка (как fakeTx в shorts-topic.service.spec.ts): BEGIN/COMMIT/ROLLBACK —
  // своим ответом, остальное — тем же `answer`, что и у пула.
  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) =>
      sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' ? { rows: [], rowCount: 0 } : answer(sql, params)),
    release: jest.fn(),
  };
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => answer(sql, params)),
    getClient: jest.fn(async () => client),
  };
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6], format: 'chat' })), update: jest.fn(async (p: any) => p) };
  const topics = {
    addManual: jest.fn(async () => ({ id: 'new' })),
    start: jest.fn(async (): Promise<any> => ({ id: ID, status: 'directing' })),
    refillWeek: jest.fn(async () => 7),
  };
  const storage = { publicUrl: jest.fn((b: string, k: string) => `https://minio.test/${b}/${k}`) };
  const ctl = new ShortsController(pg as any, settings as any, topics as any, storage as any);
  return { ctl, pg, client, settings, topics, storage };
}

describe('POST admin/shorts', () => {
  it('закрыт JWT и правами админа', () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, ShortsController.prototype.action);
    expect(guards).toEqual([JwtGuard, AdminGuard]);
  });

  it('list — ролики со статусами площадок', async () => {
    const { ctl } = setup((sql) =>
      sql.includes('FROM short_publication')
        ? { rows: [{ short_id: ID, platform: 'telegram', status: 'published' }] }
        : { rows: [video({ status: 'published' })] });
    const r = res();
    await ctl.action({ action: 'list' }, r);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].publications[0]).toMatchObject({ platform: 'telegram', status: 'published' });
  });

  it('get — ссылки на видео; кривой id — 400, нет ролика — 404', async () => {
    const { ctl } = setup((sql) => (sql.includes('FROM short_video') ? { rows: [video()] } : { rows: [] }));
    const r = res();
    await ctl.action({ action: 'get', id: ID }, r);
    expect(r.body.videoUrl).toBe('https://minio.test/linkeon-smm-videos/shorts/v/video.mp4');
    expect(r.body.coverUrl).toBeNull();
    await expect(ctl.action({ action: 'get', id: 'x' }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(setup().ctl.action({ action: 'get', id: ID }, res())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('list — без тяжёлых полей, с версией строкой из базы', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.includes('FROM short_publication')
        ? { rows: [] }
        : {
            rows: [video({
              status: 'pending_review', version: VERSION,
              capture: { answerText: 'x' }, script: { hook: 'h' }, animation: { omniSeconds: 16 }, captions: { telegram: 'TG' },
            })],
          },
    );
    const r = res();
    await ctl.action({ action: 'list' }, r);
    expect(String(pg.query.mock.calls[0][0])).toContain(VERSION_SQL);
    expect(r.body[0].version).toBe(VERSION);
    for (const heavy of ['capture', 'script', 'animation', 'captions']) expect(r.body[0]).not.toHaveProperty(heavy);
    expect(r.body[0]).toMatchObject({ id: ID, status: 'pending_review', publications: [] });
  });

  it('list — активная очередь без общего лимита; архив (published/rejected) — по 100 последних на каждый статус', async () => {
    const { ctl, pg } = setup((sql) => (sql.includes('FROM short_publication') ? { rows: [] } : { rows: [video({ status: 'failed' })] }));
    await ctl.action({ action: 'list' }, res());
    const sql = String(pg.query.mock.calls[0][0]);
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY status ORDER BY COALESCE(published_at, updated_at) DESC)');
    expect(sql).toContain("status NOT IN ('published', 'rejected') OR archive_rank <= 100");
  });

  it('list — внутренний SELECT перечисляет только лёгкие поля (не SELECT *): scene остаётся, тяжёлые поля не тащит из Postgres', async () => {
    const { ctl, pg } = setup((sql) => (sql.includes('FROM short_publication') ? { rows: [] } : { rows: [video({ status: 'failed' })] }));
    await ctl.action({ action: 'list' }, res());
    const sql = String(pg.query.mock.calls[0][0]);
    // Явный перечень, а не SELECT * (иначе capture/script/animation/captions снова ехали бы в Node,
    // чтобы тут же быть выброшенными light() ниже).
    expect(sql).toMatch(/SELECT id, rubric, angle, angle_locked, source, source_ref, topic_key, topic_hint, title,/);
    expect(sql).toMatch(/\bscene\b/);
    for (const heavy of ['capture', 'script', 'animation', 'captions']) {
      expect(sql).not.toMatch(new RegExp(`\\b${heavy}\\b`));
    }
  });

  it('get — версия и ссылки на файлы с меткой версии', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.includes('FROM short_video') ? { rows: [video({ version: VERSION, cover_key: 'shorts/v/cover.jpg' })] } : { rows: [] });
    const r = res();
    await ctl.action({ action: 'get', id: ID }, r);
    expect(r.body.version).toBe(VERSION);
    expect(r.body.videoUrl).toBe(`https://minio.test/linkeon-smm-videos/shorts/v/video.mp4?v=${encodeURIComponent(VERSION)}`);
    expect(r.body.coverUrl).toBe(`https://minio.test/linkeon-smm-videos/shorts/v/cover.jpg?v=${encodeURIComponent(VERSION)}`);
    // Версию даёт сам SELECT get: без алиаса заглушка молчала бы, а на стенде каждое решение получало бы 400.
    expect(String(pg.query.mock.calls[0][0])).toContain(VERSION_SQL);
    // Закодированная метка — литералом: пробел, двоеточия и «+» не должны пройти сырыми.
    expect(r.body.videoUrl).toBe('https://minio.test/linkeon-smm-videos/shorts/v/video.mp4?v=2026-10-30%2012%3A34%3A56.123456%2B00');
  });

  it('order — поля заказа; ошибка проверки — 400', async () => {
    const { ctl, topics } = setup();
    await ctl.action({ action: 'order', topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 }, res());
    expect(topics.addManual).toHaveBeenCalledWith({ topic: 'Разнос плохого договора', rubric: 'assistant', angle: 'roast', assistantId: 10 });
    topics.addManual.mockRejectedValueOnce(new ShortOrderError('тема — от 10 до 4000 знаков, сейчас 3'));
    await expect(ctl.action({ action: 'order', topic: 'abc' }, res())).rejects.toBeInstanceOf(BadRequestException);
    topics.addManual.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(ctl.action({ action: 'order', topic: 'Разнос плохого договора' }, res())).rejects.not.toBeInstanceOf(BadRequestException);
  });

  it('start_now — запуск в обход ограничений; нечего запускать — 409', async () => {
    const { ctl, topics } = setup();
    await ctl.action({ action: 'start_now', id: ID }, res());
    expect(topics.start).toHaveBeenCalledWith({ id: ID, force: true });
    topics.start.mockResolvedValueOnce(null);
    await expect(ctl.action({ action: 'start_now' }, res())).rejects.toBeInstanceOf(ConflictException);
  });

  it('refill_topics — каталог недели сейчас, не дожидаясь воскресенья; ответ — сколько тем заведено', async () => {
    const { ctl, topics } = setup();
    const r = res();
    await ctl.action({ action: 'refill_topics' }, r);
    expect(topics.refillWeek).toHaveBeenCalledTimes(1);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(r.body).toEqual({ added: 7 });
  });

  it('publish_now — только одобренный; занятый момент — 409 slot_taken', async () => {
    const ok = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ status: 'approved' })] }));
    const r = res();
    await ok.ctl.action({ action: 'publish_now', id: ID }, r);
    expect(ok.pg.query.mock.calls.some((c: any[]) => String(c[0]).includes('SET slot_at = now()'))).toBe(true);

    const notApproved = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [] } : { rows: [video({ status: 'pending_review' })] }));
    await expect(notApproved.ctl.action({ action: 'publish_now', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);

    const conflict = setup((sql) => {
      if (sql.startsWith('UPDATE')) throw Object.assign(new Error('dup'), { code: '23505', constraint: SHORT_SLOT_INDEX });
      return { rows: [video({ status: 'approved' })] };
    });
    const err: any = await conflict.ctl.action({ action: 'publish_now', id: ID }, res()).catch((e: any) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ error: 'slot_taken', message: 'Этот момент уже занят другим роликом — попробуйте через минуту' });
  });

  it('retry — с этапа, на котором упал; публикация — только одобренного, и только после видео (одна транзакция)', async () => {
    const capture = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'capture_queued' })] } : { rows: [video()] }));
    await capture.ctl.action({ action: 'retry', id: ID }, res());
    const upd = capture.client.query.mock.calls.find((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed'")) as any[];
    // Без замечания owner_note не трогается (COALESCE с NULL); без from — и формат.
    expect(upd[1]).toEqual([ID, 'capture_queued', 'capturing', null, null]);

    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    const calls = pub.client.query.mock.calls;
    const videoIdx = calls.findIndex((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed' AND failed_from = $3"));
    const pubIdx = calls.findIndex((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'pending'"));
    expect(videoIdx).toBeGreaterThanOrEqual(0);
    expect(pubIdx).toBeGreaterThan(videoIdx);

    const never = setup(() => ({ rows: [video({ failed_from: 'publishing', approved_at: null })] }));
    await expect(never.ctl.action({ action: 'retry', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
  });

  it('retry — публикации не трогаются, если видео не обновилось: 409 до записи площадок, в одной транзакции', async () => {
    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await expect(pub.ctl.action({ action: 'retry', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
    const touchedPublications = (c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'pending'");
    expect(pub.pg.query.mock.calls.some(touchedPublications) || pub.client.query.mock.calls.some(touchedPublications)).toBe(false);
    expect(pub.pg.getClient).toHaveBeenCalled();
    expect(pub.client.query.mock.calls.some((c: any[]) => c[0] === 'ROLLBACK')).toBe(true);
  });

  it('retry — площадки бросили ошибку после успешного видео: ROLLBACK, COMMIT не зовётся', async () => {
    const pub = setup((sql) => {
      if (sql.includes("UPDATE short_publication SET status = 'pending'")) throw new Error('connection terminated');
      if (sql.includes('RETURNING')) return { rows: [video({ status: 'approved' })] };
      return { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] };
    });
    await expect(pub.ctl.action({ action: 'retry', id: ID }, res())).rejects.toThrow('connection terminated');
    const calls = pub.client.query.mock.calls.map((c: any[]) => c[0]);
    expect(calls).toContain('ROLLBACK');
    expect(calls).not.toContain('COMMIT');
  });

  it('retry публикации не обнуляет счётчик строк площадок — это жетон попытки публикатора', async () => {
    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    const reset = pub.client.query.mock.calls
      .map((c: any[]) => String(c[0]).replace(/\s+/g, ' '))
      .find((s: string) => s.startsWith("UPDATE short_publication SET status = 'pending'"));
    expect(reset).toBeDefined();
    expect(reset).not.toMatch(/attempts/);
  });

  const retryWrite = (client: any) =>
    client.query.mock.calls.find((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed' AND failed_from = $3")) as any[];

  it('retry { from: directing, note } — с режиссёра, а не с этапа падения; замечание дописано к прежним', async () => {
    // Сценарист дважды просил другую сцену — повтор с writing упал бы тем же.
    const failed = video({ failed_from: 'writing', owner_note: 'Сценарист: нужен вопрос про субаренду\nСценарист: ответ слишком общий' });
    const { ctl, client } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'directing', failed_from: null })] } : { rows: [failed] }));
    await ctl.action({ action: 'retry', id: ID, from: 'directing', note: 'Возьми вопрос про возврат залога' }, res());
    const upd = retryWrite(client);
    expect(String(upd[0])).toContain('owner_note = COALESCE($4::text, owner_note)');
    expect(String(upd[0])).toContain('writer_rounds = 0');
    expect(String(upd[0])).toContain('format = COALESCE($5::text, format)');
    // Замечание — новый круг: отзыв студии о прошлой озвучке сбрасывается, без замечания — остаётся.
    expect(String(upd[0])).toContain('writer_feedback = CASE WHEN $4::text IS NULL THEN writer_feedback ELSE NULL END');
    expect(upd[1]).toEqual([
      ID, 'directing', 'writing',
      'Сценарист: нужен вопрос про субаренду\nСценарист: ответ слишком общий\nВозьми вопрос про возврат залога',
      'chat',
    ]);
  });

  it('retry { from: writing } — новый текст по той же съёмке', async () => {
    const failed = video({ failed_from: 'rendering', capture: { answerText: 'ответ', paragraphs: [] } });
    const { ctl, client } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'writing', failed_from: null })] } : { rows: [failed] }));
    await ctl.action({ action: 'retry', id: ID, from: 'writing' }, res());
    // С from — формат из настроек: «Только чат» после снятой модели Omni.
    expect(retryWrite(client)[1]).toEqual([ID, 'writing', 'rendering', null, 'chat']);
  });

  it('retry { from, note } — 5000 ведущих пробелов перед текстом не превращают замечание в пустое (trim до среза, как у note)', async () => {
    const failed = video({ failed_from: 'writing' });
    const { ctl, client } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'directing', failed_from: null })] } : { rows: [failed] }));
    const note = `${' '.repeat(5000)}важное замечание`;
    await ctl.action({ action: 'retry', id: ID, from: 'directing', note }, res());
    expect(retryWrite(client)[1][3]).toBe('важное замечание');
  });

  it('retry { from } у упавшей публикации — 409: её повторяют только своим путём', async () => {
    const pub = video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z', capture: { paragraphs: [] } });
    for (const from of ['directing', 'writing']) {
      const { ctl, pg } = setup(() => ({ rows: [pub] }));
      await expect(ctl.action({ action: 'retry', id: ID, from }, res())).rejects.toBeInstanceOf(ConflictException);
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
    }
    const { ctl } = setup(() => ({ rows: [pub] }));
    await expect(ctl.action({ action: 'retry', id: ID, from: 'directing' }, res())).rejects.toThrow(
      'Упавшую публикацию не переснять с этапа: «Повторить» повторит отправку, «Пост вышел» отметит вышедший пост',
    );
  });

  it('retry { from: writing } без съёмки — 409 «нечего писать»', async () => {
    const { ctl, pg } = setup(() => ({ rows: [video({ failed_from: 'capturing', capture: null })] }));
    await expect(ctl.action({ action: 'retry', id: ID, from: 'writing' }, res())).rejects.toThrow('Нового текста не будет: съёмки нет — нажмите «Новая сцена»');
    expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });

  it('retry — неизвестный from или note не строкой — 400', async () => {
    const { ctl } = setup(() => ({ rows: [video()] }));
    await expect(ctl.action({ action: 'retry', id: ID, from: 'rendering' }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.action({ action: 'retry', id: ID, from: 'directing', note: 42 }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reject — упавший ролик отклоняется, если нигде не вышел', async () => {
    const { ctl, pg } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'rejected' })] } : { rows: [video()] }));
    const r = res();
    await ctl.action({ action: 'reject', id: ID }, r);
    const upd = pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'rejected'")) as any[];
    const sql = String(upd[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("WHERE id = $1 AND status = 'failed'");
    expect(sql).toContain("AND NOT EXISTS (SELECT 1 FROM short_publication p WHERE p.short_id = short_video.id AND p.status IN ('published', 'manual_pending', 'manual_done'))");
    expect(upd[1]).toEqual([ID]);
    expect(r.body.status).toBe('rejected');
  });

  it('reject — ролик уже вышел на площадке — 409; в работе — 409; ждущий решения без версии — 400', async () => {
    const released = setup((sql) => {
      if (sql.includes('RETURNING')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'failed', released: true }] };
      return { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] };
    });
    await expect(released.ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(/уже вышел/);

    const writing = setup(() => ({ rows: [video({ status: 'writing', failed_from: null })] }));
    await expect(writing.ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
    expect(writing.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);

    const review = setup(() => ({ rows: [video({ status: 'pending_review', failed_from: null })] }));
    await expect(review.ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(review.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });

  it('mark_published — отмечает telegram вышедшим и возвращает ролик в approved', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    const r = res();
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, r);

    // UPDATE, не INSERT: строку телеграма создаёт только publish() (до отправки) — markPublished
    // не должен завести площадку, которой на самом деле не отправляли (платформы — только youtube).
    const upd = client.query.mock.calls.find((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'published'")) as any[];
    expect(String(upd[0])).toContain("WHERE short_id = $1 AND platform = 'telegram' AND status <> 'published'");
    expect(upd[1]).toEqual([ID, 'https://t.me/ainomira/777', '777']);
    expect(client.query.mock.calls.some((c: any[]) => String(c[0]).includes('INSERT INTO short_publication'))).toBe(false);

    const updVideo = client.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'approved'")) as any[];
    expect(String(updVideo[0])).toContain("WHERE id = $1 AND status = 'failed' AND failed_from = 'publishing'");
    expect(updVideo[1]).toEqual([ID]);

    expect(r.body.videoUrl).toBe('https://minio.test/linkeon-smm-videos/shorts/v/video.mp4');
  });

  it('mark_published — первый запрос транзакции блокирует short_video (тот же порядок, что у retry — без deadlock 40P01)', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res());
    const writes = client.query.mock.calls.filter((c: any[]) => c[0] !== 'BEGIN' && c[0] !== 'COMMIT' && c[0] !== 'ROLLBACK');
    expect(String(writes[0][0])).toContain('FOR NO KEY UPDATE');
    expect(String(writes[0][0])).toContain('FROM short_video');
    expect(writes[0][1]).toEqual([ID]);
  });

  it('mark_published — приватный канал t.me/c/<id>/<номер> — тоже принимается', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/c/1234567890/42' }, res());
    const upd = client.query.mock.calls.find((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'published'")) as any[];
    expect(upd[1]).toEqual([ID, 'https://t.me/c/1234567890/42', '42']);
  });

  it('mark_published — ссылка с пробелами и переносом вокруг — сохраняется обрезанной', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    await ctl.action({ action: 'mark_published', id: ID, url: '  https://t.me/ainomira/777 \n' }, res());
    const upd = client.query.mock.calls.find((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'published'")) as any[];
    expect(upd[1]).toEqual([ID, 'https://t.me/ainomira/777', '777']);
  });

  it('mark_published — ссылка не похожа на пост Telegram — 400', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const bad = (url: string) => setup(() => ({ rows: [v] })).ctl.action({ action: 'mark_published', id: ID, url }, res());
    await expect(bad('https://vk.com/wall1_2')).rejects.toBeInstanceOf(BadRequestException);
    await expect(bad('https://t.me/ainomira')).rejects.toBeInstanceOf(BadRequestException);
    await expect(bad('не ссылка')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('mark_published — ролик не упавший на публикации (или не одобрялся) — 409', async () => {
    const approved = video({ status: 'approved', failed_from: null, approved_at: '2026-10-20T00:00:00Z' });
    await expect(setup(() => ({ rows: [approved] })).ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res()))
      .rejects.toBeInstanceOf(ConflictException);

    const neverApproved = video({ failed_from: 'publishing', approved_at: null });
    await expect(setup(() => ({ rows: [neverApproved] })).ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res()))
      .rejects.toBeInstanceOf(ConflictException);

    const otherStage = video({ failed_from: 'capturing', approved_at: '2026-10-20T00:00:00Z' });
    await expect(setup(() => ({ rows: [otherStage] })).ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res()))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('mark_published — слот «сейчас» занят — 409 slot_taken', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl } = setup((sql) => {
      if (sql.includes('FROM short_video') && !sql.includes('UPDATE')) return { rows: [v] };
      if (sql.includes('UPDATE short_video') && sql.includes("SET status = 'approved'")) {
        throw Object.assign(new Error('dup'), { code: '23505', constraint: SHORT_SLOT_INDEX });
      }
      return { rows: [], rowCount: 1 };
    });
    const err: any = await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res()).catch((e: any) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ error: 'slot_taken', message: 'Этот момент уже занят другим роликом — попробуйте через минуту' });
  });

  it('mark_published — пост уже отмечен вышедшим (упал YouTube после поста) — 409, ссылка не перезаписывается', async () => {
    const failedPub = video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' });
    const { ctl, client } = setup((sql) => {
      if (sql.includes("UPDATE short_publication SET status = 'published'")) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT 1 FROM short_publication')) return { rows: [{ x: 1 }], rowCount: 1 };
      return { rows: [failedPub], rowCount: 1 };
    });
    await expect(ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/91' }, res()))
      .rejects.toThrow('Пост уже отмечен вышедшим — «Пост вышел» не нужен, нажмите «Повторить»');
    expect(client.query.mock.calls.some((c: any[]) => String(c[0]).includes("SET status = 'approved'"))).toBe(false);
  });

  it('mark_published — ролик никогда не отправлялся в Telegram (платформы — только youtube) — 409, строка не создаётся', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => {
      if (sql.includes("UPDATE short_publication SET status = 'published'")) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT 1 FROM short_publication')) return { rows: [], rowCount: 0 };
      return { rows: [v], rowCount: 1 };
    });
    await expect(ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res()))
      .rejects.toThrow('В канал этот ролик не отправлялся — «Пост вышел» не нужен, нажмите «Повторить»');
    expect(client.query.mock.calls.some((c: any[]) => String(c[0]).includes('INSERT INTO short_publication'))).toBe(false);
    expect(client.query.mock.calls.some((c: any[]) => String(c[0]).includes("SET status = 'approved'"))).toBe(false);
  });

  it('mark_published — решение логируется без ссылки на пост', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`admin/shorts mark_published ${ID}: approved`));
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('t.me/ainomira/777');
    logSpy.mockRestore();
  });

  it('настройки: чтение, правка с проверкой', async () => {
    const { ctl, settings } = setup();
    const r = res();
    await ctl.action({ action: 'get_settings' }, r);
    expect(r.body).toEqual({ slotDays: [2, 4, 6], format: 'chat' });
    await ctl.action({ action: 'update_settings', settings: { slotHourMsk: 19 } }, res());
    expect(settings.update).toHaveBeenCalledWith({ slotHourMsk: 19 });
    await expect(ctl.action({ action: 'update_settings', settings: { slotHourMsk: 99 } }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * M4: вкладка, которая шлёт настройки целиком, повторяет и режим YouTube. Неизменённый режим —
   * 200, поле не пишется; включить другой — 400; manual (аварийная остановка) — пишется.
   */
  it('update_settings — неизменённый режим YouTube не ошибка; другой не-manual — 400; manual — пишется', async () => {
    const { ctl, settings } = setup();
    settings.get.mockResolvedValue({ slotDays: [2, 4, 6], format: 'chat', youtubeMode: 'public' } as any);
    const r = res();
    await ctl.action({ action: 'update_settings', settings: { slotHourMsk: 19, youtubeMode: 'public' } }, r);
    expect(r.status).toHaveBeenCalledWith(200);
    expect(settings.update).toHaveBeenLastCalledWith({ slotHourMsk: 19 });
    await expect(ctl.action({ action: 'update_settings', settings: { youtubeMode: 'unlisted' } }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(settings.update).toHaveBeenCalledTimes(1);
    await ctl.action({ action: 'update_settings', settings: { youtubeMode: 'manual' } }, res());
    expect(settings.update).toHaveBeenLastCalledWith({ youtubeMode: 'manual' });
  });

  it('update_settings — сбой чтения текущих настроек — не 400: база, а не плохой запрос', async () => {
    const { ctl, settings } = setup();
    settings.get.mockRejectedValueOnce(new Error('Connection terminated unexpectedly'));
    const run = ctl.action({ action: 'update_settings', settings: { slotHourMsk: 19 } }, res());
    await expect(run).rejects.toThrow('Connection terminated unexpectedly');
    await expect(run).rejects.not.toBeInstanceOf(BadRequestException);
    expect(settings.update).not.toHaveBeenCalled();
  });

  it('неизвестное действие — 400', async () => {
    await expect(setup().ctl.action({ action: 'boom' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('POST admin/shorts — решение по готовому ролику', () => {
  const review = (over: Record<string, any> = {}) =>
    video({ status: 'pending_review', failed_from: null, slot_at: '2030-01-03T15:00:00.000Z', ...over });
  beforeEach(() => (approveShortIntoSlot as jest.Mock).mockReset());

  it('approve — общая запись одобрения со слотом и версией; ответ — перечитанный ролик', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue({
      slot: new Date('2030-01-03T15:00:00.000Z'), now: new Date('2030-01-01T00:00:00.000Z'),
    });
    let loads = 0;
    const { ctl, pg } = setup((sql) =>
      sql.includes('FROM short_video') ? { rows: [review(loads++ ? { status: 'approved' } : {})] } : { rows: [] });
    const r = res();
    await ctl.action({ action: 'approve', id: ID, version: VERSION }, r);
    expect(approveShortIntoSlot).toHaveBeenCalledWith(
      pg, ID, new Date('2030-01-03T15:00:00.000Z'), expect.objectContaining({ slotDays: [2, 4, 6] }), undefined, VERSION,
    );
    expect(r.body.status).toBe('approved');
  });

  it('approve — решение логируется одной строкой: id и итоговый статус', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    (approveShortIntoSlot as jest.Mock).mockResolvedValue({
      slot: new Date('2030-01-03T15:00:00.000Z'), now: new Date('2030-01-01T00:00:00.000Z'),
    });
    let loads = 0;
    const { ctl } = setup((sql) =>
      sql.includes('FROM short_video') ? { rows: [review(loads++ ? { status: 'approved' } : {})] } : { rows: [] });
    await ctl.action({ action: 'approve', id: ID, version: VERSION }, res());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`admin/shorts approve ${ID}: approved`));
    logSpy.mockRestore();
  });

  it('approve — без версии или с кривой — 400, запись не зовётся', async () => {
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.action({ action: 'approve', id: ID, version: '2026-10-30' }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(approveShortIntoSlot).not.toHaveBeenCalled();
  });

  it('approve — версия разошлась — 409 version_conflict', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'pending_review', released: false }] } : { rows: [review()] });
    const err: any = await ctl.action({ action: 'approve', id: ID, version: VERSION }, res()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      error: 'version_conflict', message: 'Ролик изменился, пока был открыт: на экране устаревшая версия',
    });
  });

  it('approve — ролик уже не ждёт решения — 409 словами, без внутренних статусов', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'approved', released: false }] } : { rows: [review()] });
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Одобрить можно только ролик, который ждёт решения; этот — одобрен. Обновите список.',
    );
  });

  it('версия похожа на дату, но невозможна (месяц 13) — 400, а не 500 от Postgres', async () => {
    (approveShortIntoSlot as jest.Mock).mockRejectedValue(
      Object.assign(new Error('date/time field value out of range'), { code: '22008' }),
    );
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID, version: '2026-13-45 12:34:56+00' }, res()))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('approve — устаревшая карточка вышедшего ролика — «уже вышел», а не статус', async () => {
    (approveShortIntoSlot as jest.Mock).mockResolvedValue(null);
    const { ctl } = setup((sql) =>
      sql.includes('AS released') ? { rows: [{ status: 'published', released: true }] } : { rows: [review()] });
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Ролик уже вышел на площадке — решение по нему не принять',
    );
  });

  it('approve — нет свободного слота — 409 с причиной', async () => {
    (approveShortIntoSlot as jest.Mock).mockRejectedValue(new NoFreeSlotError('все 60 ближайших слотов расписания заняты'));
    const { ctl } = setup(() => ({ rows: [review()] }));
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toThrow(/Не одобрил: все 60/);
  });

  it('redo — к режиссёру через общую запись, версия — в условии записи', async () => {
    const { ctl, pg } = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [review({ status: 'directing' })] } : { rows: [review()] }));
    const r = res();
    await ctl.action({ action: 'redo', id: ID, version: VERSION }, r);
    const [sql, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(sql).toContain('AND updated_at = $4::timestamptz');
    expect(params).toEqual([ID, 'directing', ['pending_review', 'approved'], VERSION]);
    expect(r.body.status).toBe('directing');
  });

  it('redo — ролик уже вышел — 409 «уже вышел на площадке»', async () => {
    const { ctl } = setup((sql) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'approved', released: true }] };
      return { rows: [review({ status: 'approved' })] };
    });
    await expect(ctl.action({ action: 'redo', id: ID, version: VERSION }, res())).rejects.toThrow(
      'Ролик уже вышел на площадке — переснять или отклонить нельзя',
    );
  });

  it('reject ждущего решения — через общую запись с версией', async () => {
    const { ctl, pg } = setup((sql) => (sql.startsWith('UPDATE') ? { rows: [review({ status: 'rejected' })] } : { rows: [review()] }));
    const r = res();
    await ctl.action({ action: 'reject', id: ID, version: VERSION }, r);
    const [, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(params).toEqual([ID, 'rejected', ['pending_review', 'approved'], VERSION]);
    expect(r.body.status).toBe('rejected');
  });

  it('note — замечание дописано к прежним, ролик у сценариста; пустое — 400', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.startsWith('UPDATE') ? { rows: [review({ status: 'writing' })] } : { rows: [review({ owner_note: 'короче' })] });
    const r = res();
    await ctl.action({ action: 'note', id: ID, version: VERSION, text: '  без цифр  ' }, r);
    const [sql, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(sql).toContain("status = 'writing'");
    expect(params).toEqual([ID, 'короче\nбез цифр', VERSION]);
    expect(r.body.status).toBe('writing');
    await expect(ctl.action({ action: 'note', id: ID, version: VERSION, text: '   ' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('note — 5000 ведущих пробелов перед текстом не превращают замечание в пустое (trim до среза)', async () => {
    const { ctl, pg } = setup((sql) =>
      sql.startsWith('UPDATE') ? { rows: [review({ status: 'writing' })] } : { rows: [review()] });
    const text = `${' '.repeat(5000)}важное замечание`;
    await ctl.action({ action: 'note', id: ID, version: VERSION, text }, res());
    const [, params] = pg.query.mock.calls.find((c: any[]) => String(c[0]).startsWith('UPDATE')) as any[];
    expect(params[1]).toContain('важное замечание');
  });

  it('note — решение логируется без текста замечания', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { ctl } = setup((sql) =>
      sql.startsWith('UPDATE') ? { rows: [review({ status: 'writing' })] } : { rows: [review()] });
    await ctl.action({ action: 'note', id: ID, version: VERSION, text: 'секретный текст замечания' }, res());
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`admin/shorts note ${ID}: writing`));
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain('секретный текст замечания');
    logSpy.mockRestore();
  });

  it('reject упавшего с версией — версия в условии записи; разошлась — version_conflict', async () => {
    const ok = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'rejected' })] } : { rows: [video()] }));
    await ok.ctl.action({ action: 'reject', id: ID, version: VERSION }, res());
    const upd = ok.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'rejected'")) as any[];
    expect(String(upd[0])).toContain('AND updated_at = $2::timestamptz');
    expect(upd[1]).toEqual([ID, VERSION]);

    const stale = setup((sql) => {
      if (sql.includes('RETURNING')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'failed', released: false }] };
      return { rows: [video()] };
    });
    const err: any = await stale.ctl.action({ action: 'reject', id: ID, version: VERSION }, res()).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ error: 'version_conflict' });
  });

  it('reject в работе — отказ словами, без внутренних имён статусов', async () => {
    const { ctl } = setup(() => ({ rows: [video({ status: 'writing', failed_from: null })] }));
    await expect(ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(
      'Отклонить можно упавший, ждущий решения или запланированный ролик; этот — у сценариста. Обновите список.',
    );
  });

  it('note к одобренному — «этот — одобрен»; без версии — 400', async () => {
    const { ctl } = setup((sql) => {
      if (sql.startsWith('UPDATE')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'approved', released: false }] };
      return { rows: [review({ status: 'approved' })] };
    });
    await expect(ctl.action({ action: 'note', id: ID, version: VERSION, text: 'короче' }, res())).rejects.toThrow(
      'Замечание можно только к ролику, который ждёт решения; этот — одобрен. Обновите список.',
    );
    await expect(ctl.action({ action: 'note', id: ID, text: 'короче' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('кривой id — 400; ролика нет — 404', async () => {
    const { ctl } = setup(() => ({ rows: [] }));
    await expect(ctl.action({ action: 'redo', id: 'x', version: VERSION }, res())).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.action({ action: 'approve', id: ID, version: VERSION }, res())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('обрыв базы на решении — не 400: в 400 превращаются только коды невозможной даты при переданной версии', async () => {
    (approveShortIntoSlot as jest.Mock).mockRejectedValue(Object.assign(new Error('connection terminated'), { code: '57P01' }));
    const { ctl } = setup(() => ({ rows: [review()] }));
    const err: any = await ctl.action({ action: 'approve', id: ID, version: VERSION }, res()).catch((e) => e);
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect(err.message).toBe('connection terminated');
  });

  it('версия не передана — код невозможной даты (22008) не превращается в 400, а летит наружу', async () => {
    const { ctl } = setup((sql) => {
      if (sql.includes('RETURNING')) throw Object.assign(new Error('date/time field value out of range'), { code: '22008' });
      return { rows: [video()] }; // video() по умолчанию — status: 'failed'
    });
    const err: any = await ctl.action({ action: 'reject', id: ID }, res()).catch((e: any) => e);
    expect(err).not.toBeInstanceOf(BadRequestException);
    expect(err.code).toBe('22008');
  });

  it('reject упавшего с кривой версией — 400, запись не зовётся', async () => {
    const { ctl, pg } = setup(() => ({ rows: [video()] }));
    await expect(ctl.action({ action: 'reject', id: ID, version: 'не версия' }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
});
