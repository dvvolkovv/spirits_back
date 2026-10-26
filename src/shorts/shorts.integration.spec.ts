import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { claimStage, stageFailed } from './short-jobs';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { rowToShort } from './shorts.types';

/**
 * Ролики против живого Postgres — то, что решает SQL, а не код вокруг него.
 *
 * КАК ГОНЯТЬ. База ОДНОРАЗОВАЯ: beforeEach делает TRUNCATE. Гард отказывается
 * работать с базой приложения и с непустой short_video — до наката миграции.
 *
 *   sudo -u postgres psql -qc "CREATE ROLE shortsit LOGIN PASSWORD 'shortsit'"
 *   sudo -u postgres psql -qc "CREATE DATABASE shorts_it OWNER shortsit"
 *   SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts
 *
 * Без SHORTS_PG_URL файл пропускается (skipped), а не зеленеет.
 */
const PG = process.env.SHORTS_PG_URL;
const maybe = PG ? describe : describe.skip;
const MIGRATION = path.join(__dirname, 'migrations', '001_shorts.sql');

maybe('ролики против живого Postgres', () => {
  jest.setTimeout(60_000);
  let pool: Pool;
  let ours = false;
  const pgLike = () => ({ query: (sql: string, params?: any[]) => pool.query(sql, params), getClient: () => pool.connect() });

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    const probe = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS app, to_regclass('public.short_video') AS shorts`,
    );
    if (probe.rows[0].app) throw new Error('SHORTS_PG_URL указывает на базу приложения — нужна одноразовая (рецепт в шапке файла)');
    if (probe.rows[0].shorts) {
      const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
      if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база, TRUNCATE их сотрёт');
    }
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    ours = true;
  });

  beforeEach(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
  });

  afterAll(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
    await pool?.end();
  });

  /** Строка ролика; объекты — в jsonb строкой, массивы и даты — как есть. */
  async function insert(over: Record<string, any>) {
    const cols: Record<string, any> = { rubric: 'assistant', source: 'manual', topic_key: 't', ...over };
    const keys = Object.keys(cols);
    const values = keys.map((k) => {
      const v = cols[k];
      return v !== null && typeof v === 'object' && !(v instanceof Date) && !Array.isArray(v) ? JSON.stringify(v) : v;
    });
    const r = await pool.query(
      `INSERT INTO short_video (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      values,
    );
    return rowToShort(r.rows[0]);
  }

  it('повторный накат не ждёт открытую пишущую транзакцию', async () => {
    await insert({});
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE short_video SET topic_hint = 'держу строку'`);
      await holder.query(`UPDATE short_settings SET slot_hour_msk = 19 WHERE id = 1`);
      const t0 = Date.now();
      await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('два одобрения в один планируемый слот — разные слоты, планируемый достаётся одному', async () => {
    const schedule = { slotDays: [2, 4, 6], slotHourMsk: 18 };
    const planned = new Date('2026-10-27T15:00:00.000Z');
    const clock = () => new Date('2026-10-26T12:00:00.000Z');
    const a = await insert({ status: 'pending_review', slot_at: planned });
    const b = await insert({ status: 'pending_review', slot_at: planned });
    const [ra, rb] = await Promise.all([
      approveShortIntoSlot(pgLike() as any, a.id, planned, schedule, clock),
      approveShortIntoSlot(pgLike() as any, b.id, planned, schedule, clock),
    ]);
    expect([ra.slot.toISOString(), rb.slot.toISOString()].sort()).toEqual(['2026-10-27T15:00:00.000Z', '2026-10-29T15:00:00.000Z']);
    const rows = await pool.query(`SELECT status, approved_at FROM short_video`);
    expect(rows.rows.every((r) => r.status === 'approved' && r.approved_at)).toBe(true);
  });

  it('этап забирает один процесс; повтор ждёт паузу; три неудачи — failed', async () => {
    const v = await insert({ status: 'directing' });
    const [x, y] = await Promise.all([claimStage(pool, 'directing'), claimStage(pool, 'directing')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const first = x ?? y;
    expect(first.attempts).toBe(1);

    expect(await stageFailed(pool, first, 'режиссёр', new Error('релей молчит'))).toBe('retry');
    expect(await claimStage(pool, 'directing')).toBeNull();

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const second = await claimStage(pool, 'directing');
    expect(second.attempts).toBe(2);
    await stageFailed(pool, second, 'режиссёр', new Error('релей молчит'));

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const third = await claimStage(pool, 'directing');
    expect(await stageFailed(pool, third, 'режиссёр', new Error('релей молчит'))).toBe('failed');
    const row = (await pool.query(`SELECT * FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect([row.status, row.failed_from, row.failure_notified, row.last_error]).toEqual(['failed', 'directing', false, 'режиссёр: релей молчит']);
  });

  it('аренда истекла посреди работы: опоздавший процесс не трогает чужой захват; зависшая последняя попытка — failed', async () => {
    const v = await insert({ status: 'directing' });
    const a = await claimStage(pool, 'directing');
    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    const b = await claimStage(pool, 'directing');
    expect(b.attempts).toBe(2);
    expect(await stageFailed(pool, a, 'режиссёр', new Error('поздно'))).toBe('gone');
    const kept = (await pool.query(`SELECT attempts, last_error, lease_until > now() + interval '15 minutes' AS long FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(kept).toEqual({ attempts: 2, last_error: null, long: true });

    await pool.query(`UPDATE short_video SET attempts = 3, lease_until = now() - interval '1 second' WHERE id = $1`, [v.id]);
    expect(await claimStage(pool, 'directing')).toBeNull();
    const row = (await pool.query(`SELECT status, failed_from, failure_notified FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(row).toEqual({ status: 'failed', failed_from: 'directing', failure_notified: false });
  });

  it('ответ на приглашение узнаётся по большому id сообщения, замечание уводит ролик на переписку', async () => {
    const v = await insert({ status: 'pending_review', review_chat_id: 77, review_message_id: 12, note_prompt_ids: [9007199254740] });
    const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
    process.env.BLOG_APPROVER_TG_ID = '77';
    const svc = new ShortsApprovalService(pgLike() as any, tg as any, {} as any, {} as any, {} as any);
    expect(await svc.handleReplyEdit({ chat: { id: 77 }, reply_to_message: { message_id: 9007199254740 }, message_id: 50, text: 'короче' })).toBe(true);
    const row = (await pool.query(`SELECT status, owner_note FROM short_video WHERE id = $1`, [v.id])).rows[0];
    expect(row).toEqual({ status: 'writing', owner_note: 'короче' });
  });

  it('две публикации одновременно — одна отправка в канал', async () => {
    const v = await insert({
      status: 'approved', slot_at: new Date(Date.now() - 60_000), approved_at: new Date(),
      video_key: 'shorts/x/video.mp4', cover_key: 'shorts/x/cover.jpg', duration_ms: 44000, slug: 'x_0000',
      captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'T', description: 'D', tags: [] } },
    });
    const tg = { sendVideo: jest.fn(async () => ({ message_id: 501, chat: { id: -1001000000001, username: 'linkeontest' } })) };
    const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
    const settings = { get: jest.fn(async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' })) };
    const publisher = new ShortsPublisherService(pgLike() as any, tg as any, storage as any, settings as any);
    await Promise.all([publisher.publish(v.id), publisher.publish(v.id)]);
    expect(tg.sendVideo).toHaveBeenCalledTimes(1);
    expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('published');
    const pub = (await pool.query(`SELECT status, external_id, url FROM short_publication WHERE short_id = $1`, [v.id])).rows[0];
    expect(pub).toEqual({ status: 'published', external_id: '501', url: 'https://t.me/linkeontest/501' });
  });

  it('сторож: зависшая отправка в канал — failed без повтора; прочие — в очередь или failed по попыткам; свежие не трогает', async () => {
    // Слоты разные: одобренные и публикуемые держат уникальный индекс слота.
    const base = Date.now() - 3600_000;
    const mk = (attempts: number, shiftMin: number) =>
      insert({ status: 'publishing', attempts, approved_at: new Date(), slot_at: new Date(base + shiftMin * 60_000) });
    const tgStuck = await mk(1, 0);
    const ytStuck = await mk(1, 1);
    const ytLast = await mk(3, 2);
    const fresh = await mk(1, 3);
    const pub = (id: string, platform: string, status: string) =>
      pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, $2, $3)`, [id, platform, status]);
    await pub(tgStuck.id, 'telegram', 'publishing');
    await pub(ytStuck.id, 'telegram', 'published');
    await pub(ytStuck.id, 'youtube', 'publishing');
    await pub(ytLast.id, 'youtube', 'publishing');
    await pub(fresh.id, 'telegram', 'publishing');
    await pool.query(`UPDATE short_video SET updated_at = now() - interval '11 minutes' WHERE id = ANY($1::uuid[])`, [[tgStuck.id, ytStuck.id, ytLast.id]]);

    const publisher = new ShortsPublisherService(pgLike() as any, {} as any, {} as any, {} as any);
    await publisher.rearmStuck();
    await publisher.rearmStuck(); // повторный проход ничего не меняет

    const video = async (id: string) =>
      (await pool.query(`SELECT status, failed_from, failure_notified FROM short_video WHERE id = $1`, [id])).rows[0];
    const rows = async (id: string) =>
      (await pool.query(`SELECT platform, status, last_error FROM short_publication WHERE short_id = $1 ORDER BY platform`, [id])).rows;

    // Исход отправки в канал неизвестен — без автоповтора: владелец проверит канал.
    expect(await video(tgStuck.id)).toEqual({ status: 'failed', failed_from: 'publishing', failure_notified: false });
    const [tgRow] = await rows(tgStuck.id);
    expect([tgRow.platform, tgRow.status]).toEqual(['telegram', 'failed']);
    expect(tgRow.last_error).toMatch(/^пост мог выйти — проверьте канал/);

    expect((await video(ytStuck.id)).status).toBe('approved');
    expect((await rows(ytStuck.id)).map((r) => [r.platform, r.status])).toEqual([['telegram', 'published'], ['youtube', 'failed']]);

    expect(await video(ytLast.id)).toEqual({ status: 'failed', failed_from: 'publishing', failure_notified: false });

    expect((await video(fresh.id)).status).toBe('publishing');
    expect((await rows(fresh.id))[0].status).toBe('publishing');
  });
});
