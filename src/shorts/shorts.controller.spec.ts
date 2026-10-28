import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AdminGuard } from '../common/guards/admin.guard';
import { JwtGuard } from '../common/guards/jwt.guard';
import { SHORT_SLOT_INDEX } from './short-slot-claim';
import { ShortOrderError } from './shorts-topic.service';
import { ShortsController } from './shorts.controller';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
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
    await expect(conflict.ctl.action({ action: 'publish_now', id: ID }, res())).rejects.toThrow('slot_taken');
  });

  it('retry — с этапа, на котором упал; публикация — только одобренного', async () => {
    const capture = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'capture_queued' })] } : { rows: [video()] }));
    await capture.ctl.action({ action: 'retry', id: ID }, res());
    const upd = capture.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed'")) as any[];
    // Без замечания owner_note не трогается (COALESCE с NULL); без from — и формат.
    expect(upd[1]).toEqual([ID, 'capture_queued', 'capturing', null, null]);

    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    expect(pub.pg.query.mock.calls.some((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'pending'"))).toBe(true);

    const never = setup(() => ({ rows: [video({ failed_from: 'publishing', approved_at: null })] }));
    await expect(never.ctl.action({ action: 'retry', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
  });

  it('retry публикации не обнуляет счётчик строк площадок — это жетон попытки публикатора', async () => {
    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    const reset = pub.pg.query.mock.calls
      .map((c: any[]) => String(c[0]).replace(/\s+/g, ' '))
      .find((s: string) => s.startsWith("UPDATE short_publication SET status = 'pending'"));
    expect(reset).toBeDefined();
    expect(reset).not.toMatch(/attempts/);
  });

  const retryWrite = (pg: any) =>
    pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("WHERE id = $1 AND status = 'failed' AND failed_from = $3")) as any[];

  it('retry { from: directing, note } — с режиссёра, а не с этапа падения; замечание дописано к прежним', async () => {
    // Сценарист дважды просил другую сцену — повтор с writing упал бы тем же.
    const failed = video({ failed_from: 'writing', owner_note: 'Сценарист: нужен вопрос про субаренду\nСценарист: ответ слишком общий' });
    const { ctl, pg } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'directing', failed_from: null })] } : { rows: [failed] }));
    await ctl.action({ action: 'retry', id: ID, from: 'directing', note: 'Возьми вопрос про возврат залога' }, res());
    const upd = retryWrite(pg);
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
    const { ctl, pg } = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'writing', failed_from: null })] } : { rows: [failed] }));
    await ctl.action({ action: 'retry', id: ID, from: 'writing' }, res());
    // С from — формат из настроек: «Только чат» после снятой модели Omni.
    expect(retryWrite(pg)[1]).toEqual([ID, 'writing', 'rendering', null, 'chat']);
  });

  it('retry { from } у упавшей публикации — 409: её повторяют только своим путём', async () => {
    const pub = video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z', capture: { paragraphs: [] } });
    for (const from of ['directing', 'writing']) {
      const { ctl, pg } = setup(() => ({ rows: [pub] }));
      await expect(ctl.action({ action: 'retry', id: ID, from }, res())).rejects.toBeInstanceOf(ConflictException);
      expect(pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
    }
  });

  it('retry { from: writing } без съёмки — 409 «нечего писать»', async () => {
    const { ctl, pg } = setup(() => ({ rows: [video({ failed_from: 'capturing', capture: null })] }));
    await expect(ctl.action({ action: 'retry', id: ID, from: 'writing' }, res())).rejects.toThrow(/нечего писать — нет съёмки/);
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

  it('reject — ролик уже вышел на площадке — 409; не упавший — 409', async () => {
    const released = setup((sql) => {
      if (sql.includes('RETURNING')) return { rows: [] };
      if (sql.includes('AS released')) return { rows: [{ status: 'failed', released: true }] };
      return { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] };
    });
    await expect(released.ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(/уже вышел/);

    const review = setup(() => ({ rows: [video({ status: 'pending_review', failed_from: null })] }));
    await expect(review.ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
    expect(review.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });

  it('mark_published — отмечает telegram вышедшим и возвращает ролик в approved', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    const r = res();
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, r);

    const upsert = client.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO short_publication')) as any[];
    expect(upsert[1]).toEqual([ID, 'https://t.me/ainomira/777', '777']);

    const upd = client.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'approved'")) as any[];
    expect(String(upd[0])).toContain("WHERE id = $1 AND status = 'failed' AND failed_from = 'publishing'");
    expect(upd[1]).toEqual([ID]);

    expect(r.body.videoUrl).toBe('https://minio.test/linkeon-smm-videos/shorts/v/video.mp4');
  });

  it('mark_published — приватный канал t.me/c/<id>/<номер> — тоже принимается', async () => {
    const v = video({ failed_from: 'publishing', approved_at: '2026-10-20T00:00:00Z' });
    const { ctl, client } = setup((sql) => (sql.includes('FROM short_video') && !sql.includes('UPDATE') ? { rows: [v] } : { rows: [], rowCount: 1 }));
    await ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/c/1234567890/42' }, res());
    const upsert = client.query.mock.calls.find((c: any[]) => String(c[0]).includes('INSERT INTO short_publication')) as any[];
    expect(upsert[1]).toEqual([ID, 'https://t.me/c/1234567890/42', '42']);
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
    await expect(ctl.action({ action: 'mark_published', id: ID, url: 'https://t.me/ainomira/777' }, res())).rejects.toThrow('slot_taken');
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
