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
  const settings = { get: jest.fn(async () => ({ slotDays: [2, 4, 6] })), update: jest.fn(async (p: any) => p) };
  const topics = { addManual: jest.fn(async () => ({ id: 'new' })), start: jest.fn(async (): Promise<any> => ({ id: ID, status: 'directing' })) };
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
    expect(upd[1]).toEqual([ID, 'capture_queued', 'capturing']);

    const pub = setup((sql) => (sql.includes('RETURNING') ? { rows: [video({ status: 'approved' })] } : { rows: [video({ failed_from: 'publishing', approved_at: '2026-10-25T00:00:00Z' })] }));
    await pub.ctl.action({ action: 'retry', id: ID }, res());
    expect(pub.pg.query.mock.calls.some((c: any[]) => String(c[0]).includes("UPDATE short_publication SET status = 'pending'"))).toBe(true);

    const never = setup(() => ({ rows: [video({ failed_from: 'publishing', approved_at: null })] }));
    await expect(never.ctl.action({ action: 'retry', id: ID }, res())).rejects.toBeInstanceOf(ConflictException);
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
    expect(r.body).toEqual({ slotDays: [2, 4, 6] });
    await ctl.action({ action: 'update_settings', settings: { slotHourMsk: 19 } }, res());
    expect(settings.update).toHaveBeenCalledWith({ slotHourMsk: 19 });
    await expect(ctl.action({ action: 'update_settings', settings: { slotHourMsk: 99 } }, res())).rejects.toBeInstanceOf(BadRequestException);
  });

  it('неизвестное действие — 400', async () => {
    await expect(setup().ctl.action({ action: 'boom' }, res())).rejects.toBeInstanceOf(BadRequestException);
  });
});
