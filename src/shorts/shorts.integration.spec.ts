import * as fs from 'fs';
import * as path from 'path';
import { ConflictException } from '@nestjs/common';
import { Pool } from 'pg';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { claimStage, stageFailed } from './short-jobs';
import { BAD_TIMESTAMP_CODES, VERSION_RE, VERSION_SQL, leaveReview, noteForReview } from './short-review';
import { approveShortIntoSlot } from './short-slot-claim';
import { ShortsApprovalService } from './shorts-approval.service';
import { POST_MAY_BE_OUT, ShortsPublisherService } from './shorts-publisher.service';
import { ShortsSettingsService } from './shorts-settings.service';
import { ShortsTopicService } from './shorts-topic.service';
import { ShortsYoutubeService } from './shorts-youtube.service';
import { LIST_COLUMNS, ShortsController } from './shorts.controller';
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

  it('ссылка YouTube ответом записывается, даже если ролик одобрили в админке, минуя показ в личке (review_chat_id был NULL — rememberPrompt его заполняет)', async () => {
    const v = await insert({ status: 'published' });
    await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'manual_pending')`, [v.id]);
    const tg = { sendMessage: jest.fn(async () => ({ message_id: 42 })) };
    process.env.BLOG_APPROVER_TG_ID = '777';
    const svc = new ShortsApprovalService(pgLike() as any, tg as any, {} as any, {} as any, {} as any);
    // «yt» в сообщении набора: review_chat_id/review_message_id у ролика ещё NULL, но «yt» не
    // проверяет «устарело» — приглашение уходит и должно заполнить review_chat_id сама.
    expect(await svc.handleCallback({ id: 'cb', data: `short:yt:${v.id}`, from: { id: 777 }, message: { chat: { id: 777 }, message_id: 999 } }))
      .toBe(true);
    expect(await svc.handleReplyEdit({
      chat: { id: 777 }, reply_to_message: { message_id: 42 }, message_id: 50, text: 'https://youtu.be/AbCdEfGhIjK',
    })).toBe(true);
    const row = (await pool.query(`SELECT status, url FROM short_publication WHERE short_id = $1 AND platform = 'youtube'`, [v.id])).rows[0];
    expect(row).toEqual({ status: 'manual_done', url: 'https://youtube.com/shorts/AbCdEfGhIjK' });
  });

  it('notifyFailures: claim берёт released и tg_unsent напрямую из Postgres — три разных исхода (живой SQL)', async () => {
    const released = await insert({ status: 'failed', failed_from: 'publishing', last_error: 'x' });
    await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'published')`, [released.id]);
    const notReleased = await insert({ status: 'failed', failed_from: 'publishing', last_error: 'x' });
    await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'failed')`, [notReleased.id]);
    // Платформы — только youtube, и тоже упал: строки telegram нет вовсе (released — false: 'failed'
    // у youtube не входит в RELEASED_SQL, в отличие от manual_pending/manual_done), tg_unsent должен
    // быть false (а не true «по умолчанию»), раз самой строки telegram никогда не было.
    const noTelegram = await insert({ status: 'failed', failed_from: 'publishing', last_error: 'x' });
    await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'failed')`, [noTelegram.id]);

    const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
    process.env.BLOG_APPROVER_TG_ID = '777';
    const svc = new ShortsApprovalService(pgLike() as any, tg as any, {} as any, {} as any, {} as any);
    await svc.notifyFailures(3);
    // Порядок — ORDER BY updated_at (вставлены по очереди, с ожиданием): released, notReleased, noTelegram.
    const texts = tg.sendMessage.mock.calls.map((c: any[]) => String(c[1]));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('вышел не на все площадки');
    expect(texts[0]).toContain('«Повторить» (пост в канале уже вышел, отклонить нельзя).');
    expect(texts[1]).toContain('не вышел на площадки');
    expect(texts[1]).toContain('«Пост вышел» (если пост всё-таки в канале)');
    expect(texts[2]).toContain('не вышел на площадки');
    expect(texts[2]).toContain('«Повторить» или «Отклонить».');
    expect(texts[2]).not.toContain('Пост вышел');
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

  it('каталог при слотах каждый день: семь тем, второе наполнение в ту же неделю доливает расход на следующие позиции', async () => {
    const agents = {
      getAgents: async () => [
        { id: 1, name: 'Миша', description: 'Коуч — цели, привычки и источники мотивации' },
        { id: 10, name: 'Алексей', description: 'Юрист — договоры, споры и работа с судами' },
        { id: 22, name: 'Кира', description: 'Дизайнер — логотипы, фирменный стиль и макеты' },
        { id: 4, name: 'Ирина', description: 'Карьера — резюме, собеседования и переговоры' },
        { id: 7, name: 'Полина', description: 'Врач-терапевт — симптомы, анализы и профилактика' },
        { id: 31, name: 'Ольга', description: 'Психолог — тревога, отношения и самооценка' },
        { id: 32, name: 'Пётр', description: 'Финансы — бюджет, накопления и кредиты' },
        { id: 33, name: 'Анна', description: 'Маркетолог — продвижение, контент и реклама' },
        { id: 34, name: 'Глеб', description: 'Нутрициолог — питание, режим и пищевые привычки' },
        { id: 35, name: 'Вера', description: 'Педагог — учёба детей, мотивация и домашние задания' },
        { id: 36, name: 'Марк', description: 'Риелтор — аренда, покупка жилья и сделки' },
      ],
    };
    const settings = { get: async () => ({ slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18, prepareLeadHours: 24, format: 'skit' }) };
    const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
    const wed = new Date('2026-10-28T15:00:00.000Z'); // ср 18:00 МСК, неделя 44
    const sun = new Date('2026-11-01T07:00:00.000Z'); // вс 10:00 МСК — та же неделя 44

    expect(await topics.refillWeek(wed)).toBe(7);
    // Повтор в тот же день — ничего сверх цели.
    expect(await topics.refillWeek(wed)).toBe(0);
    // Четыре темы ушли в работу (слоты чт–вс).
    await pool.query(
      `UPDATE short_video SET status = 'directing' WHERE id IN (
         SELECT id FROM short_video WHERE source = 'catalog' AND status = 'idea' ORDER BY source_ref LIMIT 4)`,
    );
    expect(await topics.refillWeek(sun)).toBe(4);
    const rows = (await pool.query(`SELECT source_ref, status, assistant_id FROM short_video WHERE source = 'catalog' ORDER BY created_at`)).rows;
    expect(rows.filter((r) => r.status === 'idea')).toHaveLength(7);
    expect(new Set(rows.map((r) => r.source_ref)).size).toBe(11);
    expect(rows.slice(7).map((r) => r.source_ref).sort()).toEqual(
      ['catalog:2026-W44:10', 'catalog:2026-W44:11', 'catalog:2026-W44:8', 'catalog:2026-W44:9'],
    );
    // Открытые идеи — у разных ассистентов.
    const open = rows.filter((r) => r.status === 'idea').map((r) => r.assistant_id);
    expect(new Set(open).size).toBe(7);
  });

  it('list: активная очередь не режется общим лимитом; архив (published/rejected) — по 100 последних на каждый статус (живой SQL)', async () => {
    const oldFailed = await insert({ status: 'failed', failed_from: 'capturing' });
    const publishedRows = await Promise.all(
      Array.from({ length: 105 }, (_, i) => insert({ status: 'published', published_at: new Date(Date.now() + i) })),
    );
    await Promise.all(
      Array.from({ length: 101 }, (_, i) => insert({ status: 'rejected', updated_at: new Date(Date.now() + 10_000 + i) })),
    );
    const ctl = new ShortsController(pgLike() as any, {} as any, {} as any, { publicUrl: () => 'x' } as any);
    const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
    await ctl.action({ action: 'list' }, res);

    expect(res.body).toHaveLength(1 + 100 + 100);
    expect(res.body.some((r: any) => r.id === oldFailed.id)).toBe(true);

    // Не просто count === 100 (это пройдёт и с ASC в окне) — явно проверяем, что остались
    // САМЫЕ НОВЫЕ: 5 самых старых published должны отсутствовать.
    const publishedIds = res.body.filter((r: any) => r.status === 'published').map((r: any) => r.id);
    expect(publishedIds).toHaveLength(100);
    const oldestFive = [...publishedRows].sort((a, b) => a.publishedAt!.getTime() - b.publishedAt!.getTime()).slice(0, 5);
    for (const old of oldestFive) expect(publishedIds).not.toContain(old.id);

    // Лимит архива — per-статус, а не общий на весь архив: rejected капается отдельно от published.
    expect(res.body.filter((r: any) => r.status === 'rejected')).toHaveLength(100);

    // archive_rank — внутренний помощник окна, наружу (в JSON ответа) не должен просочиться.
    expect(res.body.every((r: any) => !('archive_rank' in r))).toBe(true);
  });

  it('list: тонкий SELECT не меняет форму ответа — то же, что раньше давал полный SELECT * (живой SQL)', async () => {
    // Каждое лёгкое поле — не NULL и не то значение, в которое rowToShort превращает
    // отсутствующую колонку (?? null, === true, || 0, ids()): иначе забытая в LIST_COLUMNS
    // колонка совпала бы со своим фолбэком и сверка ничего не поймала бы (так и было —
    // мутационный прогон ревью это показал).
    const v = await insert({
      status: 'pending_review',
      rubric: 'feature', angle: 'roast', angle_locked: true, source: 'manual',
      source_ref: 'test:light-columns-shape', topic_hint: 'подсказка-тест', title: 'Тест списка',
      assistant_id: 10, slug: 'test_slug_shape', lang: 'en', format: 'skit',
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'в', followups: [] },
      capture: { answerText: 'ответ', paragraphs: [] },
      script: { hook: 'h', lines: [] },
      animation: { omniSeconds: 10, skits: {} },
      captions: { telegram: 'TG', vk: 'VK', youtube: { title: 'T', description: 'D', tags: [] } },
      video_key: 'shorts/test/video.mp4', cover_key: 'shorts/test/cover.jpg', duration_ms: 44000,
      slot_at: new Date(Date.now() + 86_400_000), approved_at: new Date(Date.now() - 3_600_000),
      owner_note: 'замечание-тест', writer_feedback: 'отзыв-тест', writer_rounds: 3,
      review_chat_id: 777, review_message_id: 12, note_prompt_ids: [101, 102], yt_prompt_ids: [201],
      lease_until: new Date(Date.now() + 900_000), attempts: 2, last_error: 'ошибка-тест',
      failed_from: 'writing', failure_notified: true, published_at: new Date(Date.now() - 60_000),
    });
    const full = (await pool.query(`SELECT *, ${VERSION_SQL} AS version FROM short_video WHERE id = $1`, [v.id])).rows[0];
    // То же, что делает light() в контроллере — не экспортирован, поэтому воспроизводим здесь.
    const expected: any = rowToShort(full);
    delete expected.capture;
    delete expected.script;
    delete expected.animation;
    delete expected.captions;
    expected.version = full.version;
    expected.publications = [];

    const ctl = new ShortsController(pgLike() as any, {} as any, {} as any, { publicUrl: () => 'x' } as any);
    const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
    await ctl.action({ action: 'list' }, res);
    const row = res.body.find((r: any) => r.id === v.id);
    expect(row).toEqual(expected);
  });

  it('LIST_COLUMNS ∪ тяжёлые поля — ровно все колонки short_video (ловит колонку, забытую в LIST_COLUMNS новой миграцией)', async () => {
    const HEAVY = ['capture', 'script', 'captions', 'animation'];
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'short_video'`,
    );
    const actual = new Set(cols.rows.map((r) => r.column_name as string));
    const declared = new Set<string>([...LIST_COLUMNS, ...HEAVY]);
    const missingFromDeclared = [...actual].filter((c) => !declared.has(c)).sort();
    const extraInDeclared = [...declared].filter((c) => !actual.has(c)).sort();
    expect({ missingFromDeclared, extraInDeclared }).toEqual({ missingFromDeclared: [], extraInDeclared: [] });
  });

  describe('решения из админки — версия и «вышел» на живом SQL', () => {
    const VERSION = '2030-01-01 10:00:00.123456+00';
    const daily = { slotDays: [1, 2, 3, 4, 5, 6, 7], slotHourMsk: 18 };

    it('версия строкой из базы сверяется с микросекундами; округлённая до миллисекунд — нет', async () => {
      const v = await insert({ status: 'pending_review', updated_at: VERSION });
      const version = (await pool.query(`SELECT ${VERSION_SQL} AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
      // VERSION задан с микросекундами .123456 — VERSION_SQL обязан их сохранить, иначе сверка версии ломается.
      expect(version).toMatch(/\.123456[+-]/);
      // Через Date JS: …10:00:00.123Z — микросекунды потеряны.
      const rounded = v.updatedAt.toISOString();
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, rounded)).toBeNull();
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, version)).not.toBeNull();
      const row = (await pool.query(`SELECT status, approved_at FROM short_video WHERE id = $1`, [v.id])).rows[0];
      expect(row.status).toBe('approved');
      expect(row.approved_at).not.toBeNull();
    });

    it('версия не зависит от DateStyle/TimeZone сессии — то же решение проходит под SQL,DMY и Asia/Kolkata', async () => {
      const v = await insert({ status: 'pending_review', owner_note: 'короче', updated_at: VERSION });
      const client = await pool.connect();
      let broken = false;
      try {
        await client.query(`SET DateStyle = 'SQL, DMY'`);
        await client.query(`SET TimeZone = 'Asia/Kolkata'`);
        const version = (await client.query(`SELECT ${VERSION_SQL} AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
        expect(version).toMatch(VERSION_RE);
        expect(version).toMatch(/\.123456[+-]/);
        const weirdPg = { query: (sql: string, params?: any[]) => client.query(sql, params) };
        const result = await noteForReview(weirdPg as any, v, 'без цифр', version);
        expect(result).toMatchObject({ ok: true, short: { status: 'writing', ownerNote: 'короче\nбез цифр' } });
      } catch (e) {
        broken = true;
        throw e;
      } finally {
        await client.query('RESET ALL').catch(() => (broken = true));
        client.release(broken);
      }
    });

    it('вышедший ролик не переснять и не отклонить — даже с верной версией', async () => {
      const v = await insert({
        status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() + 86_400_000), updated_at: VERSION,
      });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'published')`, [v.id]);
      for (const target of ['directing', 'rejected'] as const) {
        expect(await leaveReview(pgLike() as any, v.id, target, VERSION)).toEqual({ ok: false, reason: 'released', status: 'approved' });
      }
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('approved');
    });

    it('redo (admin «Переснять») вышедшего ролика — отказ даже с верной версией; после снятия «вышел» тот же вызов проходит', async () => {
      const v = await insert({ status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() + 86_400_000) });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'published')`, [v.id]);
      const version = (await pool.query(`SELECT ${VERSION_SQL} AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
      const ctl = new ShortsController(pgLike() as any, {} as any, {} as any, {} as any);
      const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
      await expect(ctl.action({ action: 'redo', id: v.id, version }, res)).rejects.toThrow(
        'Ролик уже вышел на площадке — переснять или отклонить нельзя',
      );
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('approved');

      // Пост сняли с канала — «вышел» больше не числится. Та же version (не перечитанная!):
      // отклонённый UPDATE не совпал по WHERE и не трогал updated_at, а эта правка меняет только
      // short_publication — значит, первый отказ был именно от «вышел», а не от устаревшей версии.
      await pool.query(`UPDATE short_publication SET status = 'failed' WHERE short_id = $1`, [v.id]);
      await ctl.action({ action: 'redo', id: v.id, version }, res);
      expect(res.body.status).toBe('directing');
    });

    it('одобрение из админки и кнопка лички одновременно — ролик одобрен один раз', async () => {
      const v = await insert({ status: 'pending_review', updated_at: VERSION });
      const [a, b] = await Promise.all([
        approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, VERSION),
        approveShortIntoSlot(pgLike() as any, v.id, null, daily),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('approved');
    });

    it('замечание с устаревшей версией не пишется; с верной — дописано к прежним, ролик у сценариста', async () => {
      const v = await insert({ status: 'pending_review', owner_note: 'короче', updated_at: VERSION, writer_rounds: 2 });
      expect(await noteForReview(pgLike() as any, v, 'без цифр', '2030-01-01 10:00:00.123+00'))
        .toEqual({ ok: false, reason: 'stale', status: 'pending_review' });
      expect(await noteForReview(pgLike() as any, v, 'без цифр', VERSION))
        .toMatchObject({ ok: true, short: { status: 'writing', ownerNote: 'короче\nбез цифр', writerRounds: 0 } });
    });

    it('одобрение обнуляет счётчик, аренду и ошибку отправки в личку — публикатору достаётся полный бюджет', async () => {
      const v = await insert({
        status: 'pending_review', updated_at: VERSION, attempts: 2,
        lease_until: new Date(Date.now() + 600_000), last_error: 'отправка владельцу: Bad Gateway',
      });
      expect(await approveShortIntoSlot(pgLike() as any, v.id, null, daily, undefined, VERSION)).not.toBeNull();
      const row = (await pool.query(`SELECT status, attempts, lease_until, last_error FROM short_video WHERE id = $1`, [v.id])).rows[0];
      expect(row).toMatchObject({ status: 'approved', attempts: 0, lease_until: null, last_error: null });
    });

    it('версия из базы подходит под VERSION_RE; невозможные даты правильной формы Postgres отвергает кодами из BAD_TIMESTAMP_CODES', async () => {
      const v = await insert({ status: 'pending_review' });
      const version = (await pool.query(`SELECT ${VERSION_SQL} AS version FROM short_video WHERE id = $1`, [v.id])).rows[0].version;
      expect(VERSION_RE.test(version)).toBe(true);
      for (const bad of ['2026-13-45 12:34:56+00', '2026-02-30 12:34:56+00', '2026-10-30 12:34:56+99']) {
        // Форма верна — регулярка пропустит, и решать будет база.
        expect(VERSION_RE.test(bad)).toBe(true);
        const err: any = await pool.query('SELECT $1::timestamptz', [bad]).catch((e) => e);
        expect(BAD_TIMESTAMP_CODES).toContain(err.code);
      }
    });

    it('«Пост вышел» не перезаписывает уже вышедший пост: ссылка и ролик не меняются (живой SQL ON CONFLICT … WHERE)', async () => {
      const v = await insert({ status: 'failed', failed_from: 'publishing', approved_at: new Date() });
      await pool.query(
        `INSERT INTO short_publication (short_id, platform, status, url, external_id)
              VALUES ($1, 'telegram', 'published', 'https://t.me/ainomira/90', '90')`,
        [v.id],
      );
      const ctl = new ShortsController(pgLike() as any, {} as any, {} as any, { publicUrl: () => 'x' } as any);
      const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
      await expect(ctl.action({ action: 'mark_published', id: v.id, url: 'https://t.me/ainomira/91' }, res))
        .rejects.toThrow('Пост уже отмечен вышедшим');
      const pub = (await pool.query(`SELECT url, external_id FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id])).rows[0];
      expect(pub).toEqual({ url: 'https://t.me/ainomira/90', external_id: '90' });
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('failed');
    });

    it('«Пост вышел» на ролике, который в Telegram вовсе не отправляли (платформы — только youtube) — 409, строка не создаётся (живой SQL)', async () => {
      const v = await insert({ status: 'failed', failed_from: 'publishing', approved_at: new Date() });
      // Платформы — только youtube: publish() не создал строку telegram вовсе (вставляет её под
      // each-platform-loop, до отправки) — markPublished не должен завести чужую площадку.
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'youtube', 'manual_pending')`, [v.id]);
      const ctl = new ShortsController(pgLike() as any, {} as any, {} as any, { publicUrl: () => 'x' } as any);
      const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
      await expect(ctl.action({ action: 'mark_published', id: v.id, url: 'https://t.me/ainomira/91' }, res))
        .rejects.toThrow('В канал этот ролик не отправлялся — «Пост вышел» не нужен, нажмите «Повторить»');
      const pub = await pool.query(`SELECT 1 FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id]);
      expect(pub.rowCount).toBe(0);
      expect((await pool.query(`SELECT status FROM short_video WHERE id = $1`, [v.id])).rows[0].status).toBe('failed');
    });

    it('retry: ролик увели из failed между чтением и записью — видео проверяется первым, 409 не трогает строку площадки', async () => {
      const v = await insert({ status: 'failed', failed_from: 'publishing', approved_at: new Date() });
      await pool.query(`INSERT INTO short_publication (short_id, platform, status) VALUES ($1, 'telegram', 'failed')`, [v.id]);
      let raced = false;
      const racing = {
        query: async (sql: string, params?: any[]) => {
          const r = await pool.query(sql, params);
          if (!raced && sql.includes('SELECT * FROM short_video WHERE id = $1')) {
            raced = true;
            // Гонка: кто-то другой увёл ролик из failed между чтением retry (load) и его записью.
            await pool.query(`UPDATE short_video SET status = 'approved' WHERE id = $1`, [v.id]);
          }
          return r;
        },
        getClient: () => pool.connect(),
      };
      const ctl = new ShortsController(racing as any, {} as any, {} as any, {} as any);
      const res: any = { status: () => res, json: (b: any) => ((res.body = b), res) };
      await expect(ctl.action({ action: 'retry', id: v.id }, res)).rejects.toThrow('Ролик успел уйти из упавших — обновите список');
      const pub = (await pool.query(`SELECT status FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id])).rows[0];
      expect(pub.status).toBe('failed');
    });
  });

  describe('«Отклонить» у идеи на живом SQL', () => {
    const settings = {
      get: async () => ({ slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24, format: 'skit' }),
    };
    const agents = {
      getAgents: async () => [
        { id: 1, name: 'Миша', description: 'Коуч — цели, привычки и источники мотивации' },
        { id: 10, name: 'Алексей', description: 'Юрист — договоры, споры и работа с судами' },
        { id: 22, name: 'Кира', description: 'Дизайнер — логотипы, фирменный стиль и макеты' },
        { id: 4, name: 'Ирина', description: 'Карьера — резюме, собеседования и переговоры' },
      ],
    };
    const reply = () => {
      const r: any = { status: () => r, json: (b: any) => ((r.body = b), r) };
      return r;
    };

    it('отклонённую идею не берёт ни автозапуск, ни «Запустить сейчас» по её id', async () => {
      const idea = await insert({ status: 'idea', topic_key: 'manual:залог', topic_hint: 'Залог при аренде квартиры' });
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      const r = reply();
      await ctl.action({ action: 'reject', id: idea.id }, r);
      expect(r.body.status).toBe('rejected');

      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      expect(await topics.start({ force: true })).toBeNull();
      expect(await topics.start({ id: idea.id, force: true })).toBeNull();
      const row = (await pool.query(`SELECT status, slot_at FROM short_video WHERE id = $1`, [idea.id])).rows[0];
      expect(row).toEqual({ status: 'rejected', slot_at: null });
    });

    it('вместо отклонённой темы каталога пополнение недели заводит другую, на следующей позиции', async () => {
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      const wed = new Date('2026-10-28T15:00:00.000Z'); // ср 18:00 МСК, неделя 44
      expect(await topics.refillWeek(wed)).toBe(3);
      const first = (await pool.query(
        `SELECT id FROM short_video WHERE source = 'catalog' AND status = 'idea' ORDER BY source_ref LIMIT 1`,
      )).rows[0];
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      await ctl.action({ action: 'reject', id: first.id }, reply());

      expect(await topics.refillWeek(wed)).toBe(1);
      const rows = (await pool.query(
        `SELECT source_ref, status, assistant_id FROM short_video WHERE source = 'catalog' ORDER BY source_ref`,
      )).rows;
      expect(rows.filter((x) => x.status === 'idea')).toHaveLength(3);
      expect(rows.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect(rows.map((x) => x.source_ref)).toContain('catalog:2026-W44:4');
      // Отклонённая тема каталога считается «показанной» (shown исключает только failed) —
      // новая позиция уходит ассистенту, которого каталог никогда не показывал (22, Кира),
      // а не повторно тому же (1, Миша), чья идея только что отклонена: иначе «отклонено
      // считается показанным» молча перестало бы работать, а разница видна только по assistant_id.
      expect(rows.find((x) => x.source_ref === 'catalog:2026-W44:4')?.assistant_id).toBe(22);
    });

    it('отклонённый заказ можно заказать снова; открытый — дубль (null)', async () => {
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      const order = { topic: 'Разнос плохого договора аренды квартиры', rubric: 'assistant' as const };
      const first = await topics.addManual(order);
      expect(first).not.toBeNull();
      expect(await topics.addManual(order)).toBeNull();

      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      await ctl.action({ action: 'reject', id: first!.id }, reply());
      const again = await topics.addManual(order);
      expect(again).not.toBeNull();
      expect(again!.id).not.toBe(first!.id);

      // sourceRef — как у /short (повтор доставки того же сообщения Telegram): дедуп держит
      // уникальный индекс независимо от статуса, отказ его не освобождает — в отличие от
      // обычного ручного заказа без sourceRef, который выше заказался снова после отказа.
      const viaTg = { topic: 'Жалоба на отказ страховой в выплате по ОСАГО', rubric: 'assistant' as const, sourceRef: 'tg:1:2' };
      const delivered = await topics.addManual(viaTg);
      expect(delivered).not.toBeNull();
      await ctl.action({ action: 'reject', id: delivered!.id }, reply());
      expect(await topics.addManual(viaTg)).toBeNull();
      // Новый заказ без sourceRef, по другой теме, — проходит как обычно.
      const fresh = await topics.addManual({ topic: 'Совсем другой вопрос про расторжение договора аренды', rubric: 'assistant' as const });
      expect(fresh).not.toBeNull();
    });

    it('гонка «Отклонить» с автозапуском той же идеи — ровно одна сторона побеждает, статус и slot_at согласованы', async () => {
      // Случайная гонка через Promise.all: «Отклонить» (2 запроса) почти всегда опережает
      // «Запустить» (settings/agents + транзакция из нескольких запросов), так что ветка
      // started здесь почти не проверяется на практике — обе стороны детерминированно
      // проверены ниже, держащими транзакцию (гонка, детерминированная: …).
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      // TRUNCATE в beforeEach — между it, не между итерациями одного теста: у каждой гонки своя идея.
      for (let i = 0; i < 10; i++) {
        const idea = await insert({ status: 'idea', topic_key: `manual:гонка-${i}`, topic_hint: `Гонка ${i}` });
        const [rejectOutcome, started] = await Promise.all([
          ctl.action({ action: 'reject', id: idea.id }, reply()).then(() => 'rejected', (e) => e),
          topics.start({ id: idea.id, force: true }),
        ]);
        const row = (await pool.query(`SELECT status, slot_at FROM short_video WHERE id = $1`, [idea.id])).rows[0];
        if (started) {
          // Автозапуск успел первым: «Отклонить» не нашёл идею (условие на статус не совпало) — отказ.
          expect(rejectOutcome).toBeInstanceOf(ConflictException);
          expect(row.status).toBe('directing');
          expect(row.slot_at).not.toBeNull();
        } else {
          // «Отклонить» успел первым: автозапуск не нашёл idea — null, строка осталась отклонённой.
          expect(rejectOutcome).toBe('rejected');
          expect(row.status).toBe('rejected');
          expect(row.slot_at).toBeNull();
        }
      }
    });

    /**
     * Ждём, пока вторая сторона гонки застынет на блокировке строки (а не просто
     * выполняется): без этого COMMIT ниже мог бы уйти раньше, чем держащийся UPDATE
     * вообще попытался записать, и тест ничего не доказал бы. До ~5 с.
     */
    async function waitForLockWaiter(): Promise<void> {
      for (let i = 0; i < 50; i++) {
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted`);
        if (rows[0].n > 0) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('гонка не дошла до блокировки строки за ~5 с — тест не доказывает то, что должен');
    }

    it('гонка, детерминированная: автозапуск (условно) успел первым — «Отклонить» читает idea, но запись блокирована и отказывает по месту', async () => {
      const idea = await insert({ status: 'idea', topic_key: 'manual:гонка-a', topic_hint: 'Гонка A' });
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      const holder = await pool.connect();
      let broken = false;
      try {
        await holder.query('BEGIN');
        // Имитация записи start() — тем же условием WHERE status = 'idea', что в реальном коде.
        await holder.query(
          `UPDATE short_video SET status = 'directing', slot_at = now() + interval '1 day', updated_at = now()
            WHERE id = $1 AND status = 'idea'`,
          [idea.id],
        );
        const p = ctl.action({ action: 'reject', id: idea.id }, reply());
        // reject.load() читает ещё committed 'idea' (holder не закоммичен) и идёт в
        // rejectIdea — её UPDATE требует ту же строку и застывает на блокировке holder'а.
        await waitForLockWaiter();
        await holder.query('COMMIT');
        await expect(p).rejects.toThrow('Идея уже в работе — отклонить можно будет готовый ролик. Обновите список.');
      } catch (e) {
        broken = await holder.query('ROLLBACK').then(() => false, () => true);
        throw e;
      } finally {
        holder.release(broken);
      }
      const row = (await pool.query(`SELECT status, slot_at FROM short_video WHERE id = $1`, [idea.id])).rows[0];
      expect(row.status).toBe('directing');
      expect(row.slot_at).not.toBeNull();
    });

    it('гонка, детерминированная: «Отклонить» (условно) успел первым — автозапуск читает idea, но запись блокирована и возвращает null', async () => {
      const idea = await insert({ status: 'idea', topic_key: 'manual:гонка-b', topic_hint: 'Гонка B' });
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      const holder = await pool.connect();
      let broken = false;
      try {
        await holder.query('BEGIN');
        await holder.query(`UPDATE short_video SET status = 'rejected', updated_at = now() WHERE id = $1 AND status = 'idea'`, [idea.id]);
        const p = topics.start({ id: idea.id, force: true });
        // start() находит idea своим чтением (holder не закоммичен), планирует и натыкается
        // на ту же блокировку строки в собственном UPDATE — тот же механизм, что у reject.
        await waitForLockWaiter();
        await holder.query('COMMIT');
        expect(await p).toBeNull();
      } catch (e) {
        broken = await holder.query('ROLLBACK').then(() => false, () => true);
        throw e;
      } finally {
        holder.release(broken);
      }
      const row = (await pool.query(`SELECT status, slot_at FROM short_video WHERE id = $1`, [idea.id])).rows[0];
      expect(row).toEqual({ status: 'rejected', slot_at: null });
    });
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

      it('исход Telegram неизвестен, а устаревший итог последней попытки уже перевёл ролик в failed с чужой причиной — живой SQL: причина «пост мог выйти», уведомление снова', async () => {
        const v = await insert({
          status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', captions: CAPTIONS,
        });
        const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
        const settings = { get: async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' }) };
        const sendVideo = jest.fn(async () => {
          // Устаревший finishAttempt последней попытки с совпавшим жетоном; владелец о нём уже уведомлён.
          await pool.query(
            `UPDATE short_video SET status = 'failed', failed_from = 'publishing', last_error = 'публикация: telegram: publishing',
                    failure_notified = true WHERE id = $1`,
            [v.id],
          );
          throw new Error('socket hang up');
        });
        const publisher = new ShortsPublisherService(pgLike() as any, { sendVideo } as any, storage as any, settings as any);
        await publisher.publish(v.id);
        const row = (await pool.query(`SELECT status, failed_from, failure_notified, last_error FROM short_video WHERE id = $1`, [v.id])).rows[0];
        expect(row).toMatchObject({ status: 'failed', failed_from: 'publishing', failure_notified: false });
        expect(row.last_error).toContain(POST_MAY_BE_OUT);
        expect((await pool.query(`SELECT status FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id])).rows[0].status).toBe('failed');
      });

      it('исход Telegram неизвестен, а ролик упал на другом этапе (пересъёмка после устаревшего возврата) — живой SQL: ролик не тронут, строка в failed', async () => {
        const v = await insert({
          status: 'approved', approved_at: new Date(), slot_at: new Date(Date.now() - 60_000),
          video_key: 'shorts/v/video.mp4', cover_key: 'shorts/v/cover.jpg', captions: CAPTIONS,
        });
        const storage = { download: jest.fn(async () => Buffer.from('bytes')) };
        const settings = { get: async () => ({ platforms: ['telegram'], tgChannelChatId: '-1001000000001' }) };
        const sendVideo = jest.fn(async () => {
          // Устаревший возврат в очередь → «Переснять» (leave: approved_at = NULL) → пересъёмка упала.
          await pool.query(
            `UPDATE short_video SET status = 'failed', failed_from = 'directing', approved_at = NULL,
                    last_error = 'режиссёр: релей молчит', failure_notified = true WHERE id = $1`,
            [v.id],
          );
          throw new Error('socket hang up');
        });
        const publisher = new ShortsPublisherService(pgLike() as any, { sendVideo } as any, storage as any, settings as any);
        await publisher.publish(v.id);
        expect((await pool.query(`SELECT status, failed_from, last_error, failure_notified FROM short_video WHERE id = $1`, [v.id])).rows[0])
          .toEqual({ status: 'failed', failed_from: 'directing', last_error: 'режиссёр: релей молчит', failure_notified: true });
        expect((await pool.query(`SELECT status FROM short_publication WHERE short_id = $1 AND platform = 'telegram'`, [v.id])).rows[0].status).toBe('failed');
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
