/**
 * Очередь студии против живого Postgres — той же миграцией, что катит API
 * (src/shorts/migrations/001_shorts.sql): так контракт колонок проверяется на
 * настоящей схеме.
 *
 * База ОДНОРАЗОВАЯ: перед каждым тестом TRUNCATE. Гард отказывается работать с
 * базой приложения и с непустой short_video — до наката миграции.
 *
 *   sudo -u postgres psql -qc "CREATE ROLE studioit LOGIN PASSWORD 'studioit'"
 *   sudo -u postgres psql -qc "CREATE DATABASE studio_it OWNER studioit"
 *   STUDIO_PG_URL=postgresql://studioit:studioit@127.0.0.1:5432/studio_it npm run test:db
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { StudioError } from '../errors';
import { claimJob, completeCapture, completeRender, failJob, minAnswerChars, type StoredCapture } from './db';

const DB_URL = process.env.STUDIO_PG_URL;
const MIGRATION = fileURLToPath(new URL('../../../src/shorts/migrations/001_shorts.sql', import.meta.url));
const skip = DB_URL ? false : 'нет STUDIO_PG_URL — нужна одноразовая база (рецепт в шапке файла)';

describe('очередь студии против живого Postgres', { skip }, () => {
  let pool: pg.Pool;
  let ours = false;

  before(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    const probe = await pool.query(
      `SELECT to_regclass('public.ai_profiles_consolidated') AS app, to_regclass('public.short_video') AS shorts`,
    );
    if (probe.rows[0].app) throw new Error('STUDIO_PG_URL указывает на базу приложения — нужна одноразовая');
    if (probe.rows[0].shorts) {
      const n = await pool.query('SELECT count(*)::int AS n FROM short_video');
      if (n.rows[0].n > 0) throw new Error('в short_video уже есть строки — нужна одноразовая база');
    }
    await pool.query(fs.readFileSync(MIGRATION, 'utf8'));
    ours = true;
  });

  beforeEach(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
  });

  after(async () => {
    if (ours) await pool.query('TRUNCATE short_publication, short_video');
    await pool?.end();
  });

  const scene = { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Вопрос', followups: [] };

  async function insert(status: string, extra: Record<string, unknown> = {}): Promise<string> {
    const cols: Record<string, unknown> = { rubric: 'assistant', source: 'manual', topic_key: 't', status, scene: JSON.stringify(scene), ...extra };
    const keys = Object.keys(cols);
    const r = await pool.query(
      `INSERT INTO short_video (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      keys.map((k) => cols[k]),
    );
    return r.rows[0].id;
  }

  const row = async (id: string) => (await pool.query('SELECT * FROM short_video WHERE id = $1', [id])).rows[0];

  it('задание забирается один раз; брошенное упавшим процессом — снова, с новой попыткой', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    assert.equal(job?.id, id);
    assert.equal(job?.attempts, 1);
    assert.deepEqual(job?.scene, scene);
    assert.equal((await row(id)).status, 'capturing');
    assert.equal(await claimJob(pool, 'capture'), null);

    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const again = await claimJob(pool, 'capture');
    assert.deepEqual([again?.id, again?.attempts], [id, 2]);
  });

  it('съёмка готова — writing и съёмка в базе', async () => {
    const id = await insert('capture_queued');
    await claimJob(pool, 'capture');
    const capture = { scene, questionShotKey: 'shorts/x/capture-1/question.png', answerShotKey: 'shorts/x/capture-1/answer.png', paragraphs: [{ n: 1, text: 'a' }] } as unknown as StoredCapture;
    assert.equal(await completeCapture(pool, id, capture), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.lease_until, r.capture.answerShotKey], ['writing', 0, null, 'shorts/x/capture-1/answer.png']);
  });

  it('сборка готова — pending_review без сообщения владельцу, с файлами', async () => {
    const id = await insert('render_queued', { review_message_id: 55 });
    await claimJob(pool, 'render');
    assert.equal(await completeRender(pool, id, { videoKey: 'shorts/x/video.mp4', coverKey: 'shorts/x/cover.jpg', durationMs: 44000 }), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.video_key, r.duration_ms, r.review_message_id], ['pending_review', 'shorts/x/video.mp4', 44000, null]);
  });

  it('сбой с повтором — пауза в очереди; без повтора — failed с этапом', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    assert.equal(await failJob(pool, job!, new StudioError('answer_rejected', 'ответ не годится', true)), 'retry');
    const r = await row(id);
    assert.deepEqual([r.status, r.last_error], ['capture_queued', 'съёмка: ответ не годится']);
    assert.ok(new Date(r.lease_until).getTime() > Date.now());
    assert.equal(await claimJob(pool, 'capture'), null);

    await pool.query(`UPDATE short_video SET lease_until = NULL WHERE id = $1`, [id]);
    const second = await claimJob(pool, 'capture');
    assert.equal(await failJob(pool, second!, new StudioError('wrong_assistant', 'не тот ассистент', false)), 'failed');
    const f = await row(id);
    assert.deepEqual([f.status, f.failed_from, f.failure_notified], ['failed', 'capturing', false]);
  });

  it('озвучка длиннее 60 с — сценарий назад сценаристу; после трёх кругов — failed', async () => {
    const id = await insert('render_queued', { writer_rounds: 1 });
    const job = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, job!, new StudioError('too_long', 'timeline: ролик 63.2 с — длиннее 60 с', false)), 'writer');
    const r = await row(id);
    assert.deepEqual([r.status, r.writer_feedback], ['writing', 'озвучка: timeline: ролик 63.2 с — длиннее 60 с']);

    await pool.query(`UPDATE short_video SET status = 'render_queued', writer_rounds = 3 WHERE id = $1`, [id]);
    const last = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, last!, new StudioError('too_long', 'снова длинно', false)), 'failed');
  });

  it('порог длины ответа — из настроек', async () => {
    assert.equal(await minAnswerChars(pool), 400);
    await pool.query('UPDATE short_settings SET min_answer_chars = 500 WHERE id = 1');
    assert.equal(await minAnswerChars(pool), 500);
    await pool.query('UPDATE short_settings SET min_answer_chars = 400 WHERE id = 1');
  });
});
