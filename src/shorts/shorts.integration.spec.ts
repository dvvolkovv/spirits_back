import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { claimStage, stageFailed } from './short-jobs';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';
import { ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsYoutubeService } from './shorts-youtube.service';
import { rowToShort } from './shorts.types';
import { YoutubeAttemptSuperseded, YoutubeNotUploaded } from './youtube/youtube-errors';

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
const MIGRATIONS = ['001_shorts.sql', '002_skits.sql', '003_youtube.sql'].map((f) => path.join(__dirname, 'migrations', f));
const migrate = async (pool: Pool) => {
  for (const f of MIGRATIONS) await pool.query(fs.readFileSync(f, 'utf8'));
};

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
    await migrate(pool);
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
      await migrate(pool);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('002 поверх базы после 001: CHECK статуса пересоздаётся один раз и без потерь, ролики целы и chat', async () => {
    // С чистого листа: на постоянной базе 002 уже накачена, и ветка пересоздания иначе не проверялась бы.
    await pool.query('DROP TABLE short_publication, short_video, short_settings');
    await pool.query(fs.readFileSync(MIGRATIONS[0], 'utf8'));
    const OLD = ['idea', 'directing', 'capture_queued', 'capturing', 'writing', 'render_queued', 'rendering', 'pending_review',
      'approved', 'publishing', 'published', 'rejected', 'failed'];
    for (const status of OLD) await insert({ status });
    await migrate(pool);
    const statusChecks = `SELECT conname, oid FROM pg_constraint
      WHERE conrelid = 'public.short_video'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%''render_queued''%'`;
    const first = (await pool.query(statusChecks)).rows;
    expect(first.map((r) => r.conname)).toEqual(['short_video_status_002']);
    await migrate(pool);
    expect((await pool.query(statusChecks)).rows).toEqual(first);
    // Сортировка — в JS: порядок Postgres зависит от правил сравнения базы.
    const rows = await pool.query('SELECT status, format FROM short_video');
    expect(rows.rows.map((r) => r.status).sort()).toEqual([...OLD].sort());
    expect(new Set(rows.rows.map((r) => r.format))).toEqual(new Set(['chat']));
    expect((await insert({ status: 'animating' })).format).toBe('chat');
    await insert({ status: 'animate_queued', format: 'skit' });
    await expect(insert({ status: 'dancing' })).rejects.toThrow(/short_video_status_002/);
    await expect(insert({ format: 'cartoon' })).rejects.toThrow(/check/);
    const s = await pool.query('SELECT format, max_omni_seconds FROM short_settings WHERE id = 1');
    expect(s.rows[0]).toEqual({ format: 'skit', max_omni_seconds: 48 });
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

  describe('YouTube против живой базы', () => {
    const OWNER = 37948399;
    const saved = { ...process.env };
    const reply = (status: number, data: any = {}, headers: any = {}) => ({ status, data, headers });
    const reset = async () => {
      await pool.query('TRUNCATE short_youtube_account');
      await pool.query(`UPDATE short_settings SET youtube_mode = 'manual' WHERE id = 1`);
    };

    beforeAll(() => {
      Object.assign(process.env, {
        BLOG_APPROVER_TG_ID: String(OWNER),
        YOUTUBE_OAUTH_CLIENT_ID: 'cid',
        YOUTUBE_OAUTH_CLIENT_SECRET: 'GOCSPX-it-secret',
        PUBLIC_BASE_URL: 'https://test.linkeon.io',
        CALENDAR_SECRET_KEY: 'k'.repeat(32),
      });
    });
    beforeEach(reset);
    afterAll(async () => {
      await reset();
      process.env = saved;
    });

    /** Ответы Google по очереди; функция — ответ с побочным действием (чужой захват строки в этот момент). */
    function service(responses: any[]) {
      const http = jest.fn(async (req: any) => {
        const queued = responses.shift();
        if (!queued) throw new Error('лишний запрос');
        const n = typeof queued === 'function' ? await queued(req) : queued;
        if (n instanceof Error) throw n;
        return n;
      });
      const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
      const storage = { download: jest.fn(async () => Buffer.from('video-bytes')) };
      const svc = new ShortsYoutubeService(pgLike() as any, tg as any, storage as any, new ShortsSettingsService(pgLike() as any));
      svc.http = http as any;
      return { svc, http, tg };
    }

    it('003: умолчание manual, CHECK режима, колонка сессии', async () => {
      const def = await pool.query(
        `SELECT column_default FROM information_schema.columns WHERE table_name = 'short_settings' AND column_name = 'youtube_mode'`,
      );
      expect(def.rows[0].column_default).toContain('manual');
      await expect(pool.query(`UPDATE short_settings SET youtube_mode = 'private' WHERE id = 1`)).rejects.toThrow();
      const col = await pool.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'short_publication' AND column_name = 'upload_session'`,
      );
      expect(col.rowCount).toBe(1);
    });

    it('подключение пишет аккаунт и режим; повторное — та же единственная строка', async () => {
      const ok = () => [
        reply(200, { access_token: 'a', refresh_token: 'refresh-xyz', scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly' }),
        reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title: 'Linkeon' } }] }),
      ];
      const { svc } = service([...ok(), ...ok()]);
      const state = () => new URL(svc.connectUrl(OWNER)).searchParams.get('state');
      expect((await svc.completeConnect({ code: 'c1', state: state() })).status).toBe(200);
      expect((await svc.completeConnect({ code: 'c2', state: state() })).status).toBe(200);
      const acc = await pool.query('SELECT * FROM short_youtube_account');
      expect(acc.rowCount).toBe(1);
      expect(acc.rows[0]).toMatchObject({ id: 1, channel_id: 'UCu_Pq4rFXmTT8CDG27O_i2A', status: 'connected' });
      expect(decryptSecret(acc.rows[0].refresh_token_enc)).toBe('refresh-xyz');
      const s = await pool.query('SELECT youtube_mode FROM short_settings WHERE id = 1');
      expect(s.rows[0]).toEqual({ youtube_mode: 'unlisted' });
    });

    it('сессия загрузки: адрес в строке youtube до файла и после загрузки (стирает публикатор вместе с published)', async () => {
      await pool.query(`INSERT INTO short_youtube_account (id, channel_id, refresh_token_enc) VALUES (1, 'UCx', $1)`, [encryptSecret('refresh-xyz')]);
      const v = await insert({
        status: 'publishing',
        video_key: 'shorts/v/video.mp4',
        captions: { telegram: 't', vk: 'v', youtube: { title: 'T', description: 'D', tags: [] } },
      });
      // Строку захватила попытка с жетоном 1 — его и передаём.
      await pool.query(`INSERT INTO short_publication (short_id, platform, status, attempts) VALUES ($1, 'youtube', 'publishing', 1)`, [v.id]);
      const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=it1';
      const read = async () =>
        (await pool.query(`SELECT upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [v.id])).rows[0].upload_session;
      let seen: string | null = null;
      const { svc } = service([reply(200, { access_token: 'a' }), reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' })]);
      const out = await svc.upload(v, 'unlisted', async () => {
        seen = await read();
        return true;
      }, 1);
      expect(out.videoId).toBe('abcdefghijk');
      expect(seen).toBe(SESSION);
      expect(await read()).toBe(SESSION);
    });

    it('публикатор пишет published и стирает адрес сессии одним запросом (живой SQL recordSent)', async () => {
      const v = await insert({
        status: 'approved',
        approved_at: new Date(),
        slot_at: new Date(Date.now() - 60_000),
        video_key: 'shorts/v/video.mp4',
        cover_key: 'shorts/v/cover.jpg',
        captions: { telegram: 't', vk: 'v', youtube: { title: 'T', description: 'D', tags: [] } },
      });
      await pool.query(
        `INSERT INTO short_publication (short_id, platform, status, upload_session)
         VALUES ($1, 'telegram', 'published', NULL), ($1, 'youtube', 'pending', $2)`,
        [v.id, 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=it2'],
      );
      const youtube = {
        uploadPlan: async () => ({ kind: 'upload', privacy: 'unlisted' }),
        upload: async () => ({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: true }),
        notifyUploaded: jest.fn(async () => undefined),
      };
      const settings = { get: async () => ({ platforms: ['telegram', 'youtube'], tgChannelChatId: '-1003290853538' }) };
      const publisher = new ShortsPublisherService(pgLike() as any, {} as any, {} as any, settings as any, youtube as any);
      await publisher.publish(v.id);
      const row = (await pool.query(
        `SELECT status, external_id, upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`,
        [v.id],
      )).rows[0];
      expect(row).toEqual({ status: 'published', external_id: 'abcdefghijk', upload_session: null });
      expect((await pool.query('SELECT status FROM short_video WHERE id = $1', [v.id])).rows[0].status).toBe('published');
      expect(youtube.notifyUploaded).toHaveBeenCalledWith(v.id, null);
    });

    it('отзыв доступа и сообщение о загрузке — SQL против живой схемы', async () => {
      await pool.query(`INSERT INTO short_youtube_account (id, channel_id, refresh_token_enc) VALUES (1, 'UCx', $1)`, [encryptSecret('refresh-xyz')]);
      const v = await insert({
        status: 'publishing',
        video_key: 'shorts/v/video.mp4',
        captions: { telegram: 't', vk: 'v', youtube: { title: 'T', description: 'D', tags: [] } },
      });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status, attempts) VALUES ($1, 'youtube', 'publishing', 1)`, [v.id]);
      const a = service([reply(400, { error: 'invalid_grant', error_description: 'revoked' })]);
      await a.svc.upload(v, 'unlisted', async () => true, 1).catch(() => undefined);
      const acc = await pool.query('SELECT status, last_error FROM short_youtube_account');
      expect(acc.rows[0]).toEqual({ status: 'revoked', last_error: 'HTTP 400 invalid_grant: revoked' });
      await pool.query(
        `UPDATE short_publication SET status = 'published', url = 'https://youtube.com/shorts/abcdefghijk' WHERE short_id = $1`,
        [v.id],
      );
      const b = service([]);
      await b.svc.notifyUploaded(v.id, 'public');
      expect(b.tg.sendMessage).toHaveBeenCalledWith(OWNER, 'Вышло на YouTube (публично): https://youtube.com/shorts/abcdefghijk', expect.anything());
    });

    /**
     * Жетон попытки — attempts из захвата строки YouTube и ролика. Попытка A зависла дольше
     * порога сторожа; ролик и строку взяла B. Записи A с её жетоном не должны проходить.
     */
    describe('жетон попытки', () => {
      const CAPTIONS = { telegram: 't', vk: 'v', youtube: { title: 'T', description: 'D', tags: [] as string[] } };
      const S_A = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fence-a';
      const S_B = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fence-b';
      const connect = () =>
        pool.query(`INSERT INTO short_youtube_account (id, channel_id, refresh_token_enc) VALUES (1, 'UCx', $1)`, [encryptSecret('refresh-xyz')]);
      const ytRow = async (id: string) =>
        (await pool.query(`SELECT status, attempts, upload_session FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [id])).rows[0];
      const videoRow = async (id: string) => (await pool.query(`SELECT status, attempts, last_error FROM short_video WHERE id = $1`, [id])).rows[0];
      const caught = (p: Promise<unknown>): Promise<any> => p.then(() => 'прошло', (e) => e);

      it('вариант 1: строку держит B (жетон 2, её адрес) — у A YoutubeAttemptSuperseded, к Google ни запроса, строка B цела', async () => {
        await connect();
        const v = await insert({ status: 'publishing', attempts: 2, video_key: 'shorts/v/video.mp4', captions: CAPTIONS });
        await pool.query(
          `INSERT INTO short_publication (short_id, platform, status, attempts, upload_session) VALUES ($1, 'youtube', 'publishing', 2, $2)`,
          [v.id, S_B],
        );
        const { svc, http } = service([]);
        expect(await caught(svc.upload({ ...v, attempts: 1 }, 'unlisted', async () => true, 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
        expect(http).not.toHaveBeenCalled();
        expect(await ytRow(v.id)).toEqual({ status: 'publishing', attempts: 2, upload_session: S_B });
      });

      it('захват сессии проигран: пока A начинала сессию, строку захватила B — адрес не записан, файла нет', async () => {
        await connect();
        const v = await insert({ status: 'publishing', attempts: 1, video_key: 'shorts/v/video.mp4', captions: CAPTIONS });
        await pool.query(`INSERT INTO short_publication (short_id, platform, status, attempts) VALUES ($1, 'youtube', 'publishing', 1)`, [v.id]);
        const { svc, http } = service([
          reply(200, { access_token: 'a' }),
          async () => {
            await pool.query(`UPDATE short_publication SET attempts = 2 WHERE short_id = $1 AND platform = 'youtube'`, [v.id]);
            return reply(200, {}, { location: S_A });
          },
        ]);
        expect(await caught(svc.upload(v, 'unlisted', async () => true, 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
        expect(http.mock.calls.map(([req]) => req.method)).toEqual(['POST', 'POST']); // токен и начало сессии, PUT файла нет
        expect(await ytRow(v.id)).toEqual({ status: 'publishing', attempts: 2, upload_session: null });
      });

      it('старая попытка не трогает чужое: живость перед файлом — false, отказ не записан, итог ролика не проходит', async () => {
        const v = await insert({
          status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', captions: CAPTIONS,
        });
        await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'pending')`, [v.id]);
        const seen: { fence?: number; alive?: boolean } = {};
        const youtube = {
          uploadPlan: async () => ({ kind: 'upload', privacy: 'unlisted' }),
          upload: async (_v: any, _p: any, keepAlive: () => Promise<boolean>, fence: number) => {
            seen.fence = fence;
            // Пока A висела, сторож вернул ролик в очередь, и ролик и строку захватила B.
            await pool.query(`UPDATE short_video SET attempts = 2 WHERE id = $1`, [v.id]);
            await pool.query(`UPDATE short_publication SET attempts = 2 WHERE short_id = $1 AND platform = 'youtube'`, [v.id]);
            seen.alive = await keepAlive();
            throw new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403);
          },
          notifyUploaded: jest.fn(async () => undefined),
        };
        const settings = { get: async () => ({ platforms: ['youtube'], tgChannelChatId: null }) };
        const publisher = new ShortsPublisherService(pgLike() as any, {} as any, {} as any, settings as any, youtube as any);
        await publisher.publish(v.id);
        expect(seen).toEqual({ fence: 1, alive: false });
        const held = { status: 'publishing', attempts: 2, last_error: null };
        expect(await videoRow(v.id)).toEqual(held);
        expect(await ytRow(v.id)).toEqual({ status: 'publishing', attempts: 2, upload_session: null });
        // Итог ролика с жетоном A тоже не проходит.
        const stale = { ...v, status: 'publishing' as const, attempts: 1 };
        await (publisher as any).finishAttempt(stale, 'публикация: старая попытка');
        await (publisher as any).settle(stale, ['youtube']);
        expect(await videoRow(v.id)).toEqual(held);
        expect(youtube.notifyUploaded).not.toHaveBeenCalled();
        // С жетоном B тот же запрос проходит: отказ A — от жетона, а не от сломанного SQL.
        await (publisher as any).finishAttempt({ ...stale, attempts: 2 }, 'публикация: попытка B');
        expect(await videoRow(v.id)).toEqual({ status: 'approved', attempts: 2, last_error: 'публикация: попытка B' });
      });

      it('исход Telegram неизвестен — живой SQL: строка и ролик в failed одним запросом; строку взяла другая попытка — не трогаем ни её, ни ролик', async () => {
        const mk = (minutesAgo: number) =>
          insert({
            status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - minutesAgo * 60_000),
            video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', captions: CAPTIONS,
          });
        const tgRow = async (id: string) =>
          (await pool.query(`SELECT status, attempts FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [id])).rows[0];
        const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
        const settings = { get: async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' }) };
        const publisherWith = (sendVideo: () => Promise<any>) =>
          new ShortsPublisherService(pgLike() as any, { sendVideo: jest.fn(sendVideo) } as any, storage as any, settings as any);

        const a = await mk(1);
        await publisherWith(async () => {
          throw new Error('socket hang up');
        }).publish(a.id);
        expect(await tgRow(a.id)).toEqual({ status: 'failed', attempts: 1 });
        expect(await videoRow(a.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: expect.stringMatching(/^публикация: telegram: пост мог выйти/) });

        const b = await mk(2);
        await publisherWith(async () => {
          await pool.query(`UPDATE short_publication SET attempts = 2 WHERE short_id = $1 AND platform = 'telegram'`, [b.id]);
          throw new Error('socket hang up');
        }).publish(b.id);
        expect(await tgRow(b.id)).toEqual({ status: 'publishing', attempts: 2 });
        expect(await videoRow(b.id)).toEqual({ status: 'publishing', attempts: 1, last_error: null });
      });

      it('исход Telegram неизвестен, а ролик посреди отправки вернула в очередь устаревшая попытка — живой SQL: строка своя, ролик гасится в failed, второго поста нет', async () => {
        const v = await insert({
          status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', captions: CAPTIONS,
        });
        const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
        const settings = { get: async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' }) };
        const sendVideo = jest.fn(async () => {
          // Устаревший finishAttempt с обнулённым и совпавшим жетоном ролика вернул ролик в очередь.
          await pool.query(`UPDATE short_video SET status = 'approved' WHERE id = $1`, [v.id]);
          throw new Error('socket hang up');
        });
        const publisher = new ShortsPublisherService(pgLike() as any, { sendVideo } as any, storage as any, settings as any);
        await publisher.publish(v.id);
        const row = (await pool.query(`SELECT status, last_error FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id])).rows[0];
        expect(row.status).toBe('failed');
        expect(row.last_error).toMatch(/^пост мог выйти/);
        expect((await pool.query(`SELECT status, failed_from, failure_notified FROM short_video WHERE id = $1`, [v.id])).rows[0])
          .toEqual({ status: 'failed', failed_from: 'publishing', failure_notified: false });
        await publisher.publish(v.id); // следующий тик: ролик не в approved — в канал второй раз не уходит
        expect(sendVideo).toHaveBeenCalledTimes(1);
      });

      it('набор: запись manual_pending — с жетоном строки; строку, которую тем временем захватила новая попытка, не переписывает (живой SQL)', async () => {
        const mk = (minutesAgo: number) =>
          insert({
            status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - minutesAgo * 60_000),
            video_key: 'shorts/v/video.mp4', captions: CAPTIONS,
          });
        const kitRow = async (id: string) =>
          (await pool.query(`SELECT status, attempts, external_id FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [id])).rows[0];
        const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
        const settings = { get: async () => ({ platforms: ['youtube'], tgChannelChatId: null }) };
        // Без сервиса YouTube публикатор шлёт набор.
        const publisherWith = (sendMessage: () => Promise<any>) =>
          new ShortsPublisherService(
            pgLike() as any,
            { sendDocument: jest.fn(async () => ({ message_id: 601 })), sendMessage: jest.fn(sendMessage) } as any,
            storage as any,
            settings as any,
          );

        const a = await mk(1);
        await publisherWith(async () => ({ message_id: 602 })).publish(a.id);
        expect(await kitRow(a.id)).toEqual({ status: 'manual_pending', attempts: 1, external_id: '602' });
        expect((await videoRow(a.id)).status).toBe('published');

        const b = await mk(2);
        await publisherWith(async () => {
          await pool.query(`UPDATE short_publication SET attempts = attempts + 1 WHERE short_id = $1 AND platform = 'youtube'`, [b.id]);
          return { message_id: 603 };
        }).publish(b.id);
        expect(await kitRow(b.id)).toEqual({ status: 'publishing', attempts: 2, external_id: null });
      });

      it('проигравшая попытка отдаёт свою строку: новая захватывает её, спрашивает YouTube о старом адресе (308 без Range), стирает и грузит заново — один PUT с файлом', async () => {
        await connect();
        await pool.query(`UPDATE short_settings SET youtube_mode = 'unlisted' WHERE id = 1`);
        delete process.env.YOUTUBE_CHANNEL_ID;
        const S_C = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=fence-c';
        const v = await insert({
          status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', captions: CAPTIONS,
        });
        await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'pending')`, [v.id]);
        const { svc, http, tg } = service([
          // Попытка A: токен и начало сессии — в этот момент ролик взяла новая попытка B (строку YouTube — нет).
          reply(200, { access_token: 'a' }),
          async () => {
            await pool.query(`UPDATE short_video SET attempts = attempts + 1 WHERE id = $1`, [v.id]);
            return reply(200, {}, { location: S_A });
          },
          // Попытка C: токен, вопрос о сессии A (308 без Range — байтов нет), новая сессия, файл.
          reply(200, { access_token: 'c' }),
          reply(308),
          reply(200, {}, { location: S_C }),
          reply(201, { id: 'cccccccccc1' }),
        ]);
        const settings = { get: async () => ({ platforms: ['youtube'], tgChannelChatId: null }) };
        const publisher = new ShortsPublisherService(pgLike() as any, {} as any, {} as any, settings as any, svc);

        await publisher.publish(v.id); // A: адрес S_A лёг в строку, продление перед файлом не прошло
        expect(await ytRow(v.id)).toEqual({ status: 'failed', attempts: 1, upload_session: S_A });
        expect(await videoRow(v.id)).toMatchObject({ status: 'publishing', attempts: 2 });
        // B строку YouTube не взяла (её держала A) и вернула ролик в очередь.
        await pool.query(`UPDATE short_video SET status = 'approved' WHERE id = $1`, [v.id]);

        await publisher.publish(v.id); // C
        const calls = http.mock.calls.map(([req]) => req);
        expect(calls.filter((r) => r.method === 'PUT' && Buffer.isBuffer(r.data)).map((r) => r.url)).toEqual([S_C]);
        expect(calls.filter((r) => r.method === 'PUT' && !Buffer.isBuffer(r.data)).map((r) => [r.url, r.headers['Content-Range']]))
          .toEqual([[S_A, 'bytes */11']]);
        expect(await ytRow(v.id)).toEqual({ status: 'published', attempts: 2, upload_session: null });
        expect(await videoRow(v.id)).toEqual({ status: 'published', attempts: 3, last_error: null });
        // Сообщение о загрузке уходит без ожидания — ждём его, чтобы запрос не пережил тест.
        for (let i = 0; i < 100 && !tg.sendMessage.mock.calls.length; i++) await new Promise((r) => setTimeout(r, 20));
        expect(tg.sendMessage).toHaveBeenCalledWith(OWNER, expect.stringContaining('https://youtube.com/shorts/cccccccccc1'), expect.anything());
      });

      it('сторож вернул зависшую попытку в очередь — новая получает жетон 2, записи с жетоном 1 после этого не проходят', async () => {
        await connect();
        const v = await insert({
          status: 'publishing', attempts: 1, approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', captions: CAPTIONS,
        });
        await pool.query(
          `INSERT INTO short_publication (short_id, platform, status, attempts, upload_session) VALUES ($1, 'youtube', 'publishing', 1, $2)`,
          [v.id, S_A],
        );
        await pool.query(`UPDATE short_video SET updated_at = now() - interval '11 minutes' WHERE id = $1`, [v.id]);
        const stale = { ...v }; // попытка A: ролик в publishing, жетон 1
        const fences: number[] = [];
        const checks: Record<string, unknown> = {};
        let publisher: ShortsPublisherService;
        const youtube = {
          uploadPlan: async () => ({ kind: 'upload', privacy: 'unlisted' }),
          upload: async (_v: any, _p: any, keepAlive: () => Promise<boolean>, fence: number) => {
            fences.push(fence);
            // Посреди загрузки B просыпается A с жетоном 1.
            checks.aliveA = await (publisher as any).keepAliveFenced(stale, 'youtube', 1);
            checks.uploadA = await caught(service([]).svc.upload(stale, 'unlisted', async () => true, 1));
            await (publisher as any).finishAttempt(stale, 'публикация: старая попытка');
            checks.videoAfterA = await videoRow(v.id);
            checks.aliveB = await keepAlive();
            return { videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false };
          },
          notifyUploaded: jest.fn(async () => undefined),
        };
        const settings = { get: async () => ({ platforms: ['youtube'], tgChannelChatId: null }) };
        publisher = new ShortsPublisherService(pgLike() as any, {} as any, {} as any, settings as any, youtube as any);

        await publisher.rearmStuck();
        expect((await videoRow(v.id)).status).toBe('approved');
        expect(await ytRow(v.id)).toEqual({ status: 'failed', attempts: 1, upload_session: S_A });

        await publisher.publish(v.id);
        expect(fences).toEqual([2]);
        expect(checks.aliveA).toBe(false);
        expect(checks.uploadA).toBeInstanceOf(YoutubeAttemptSuperseded);
        // Возврат в очередь от A не прошёл: у ролика B — причина сторожа, а не «старая попытка».
        expect(checks.videoAfterA).toEqual({ status: 'publishing', attempts: 2, last_error: expect.stringMatching(/вернулся в очередь/) });
        expect(checks.aliveB).toBe(true);
        expect(await videoRow(v.id)).toEqual({ status: 'published', attempts: 2, last_error: null });
        expect(await ytRow(v.id)).toEqual({ status: 'published', attempts: 2, upload_session: null });
      });
    });
  });
});
