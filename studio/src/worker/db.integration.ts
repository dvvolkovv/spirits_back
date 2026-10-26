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
import {
  LEASE_MINUTES, MAX_JOB_ATTEMPTS, claimJob, completeAnimate, completeCapture, completeRender, failJob, maxOmniSeconds, minAnswerChars,
  saveAnimation, type StoredCapture,
} from './db';

const DB_URL = process.env.STUDIO_PG_URL;
const MIGRATIONS = ['001_shorts.sql', '002_skits.sql'].map((f) => fileURLToPath(new URL(`../../../src/shorts/migrations/${f}`, import.meta.url)));
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
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(f, 'utf8'));
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

  it('брошенное задание на последней попытке не забирается; аренда ещё идёт — не трогается', async () => {
    const past = new Date(Date.now() - 60_000);
    const swept = await insert('rendering', { attempts: MAX_JOB_ATTEMPTS, lease_until: past });
    const live = await insert('rendering', { attempts: MAX_JOB_ATTEMPTS, lease_until: new Date(Date.now() + 600_000) });
    const abandoned = await insert('rendering', { attempts: MAX_JOB_ATTEMPTS - 1, lease_until: past });
    const job = await claimJob(pool, 'render');
    assert.deepEqual([job?.id, job?.attempts], [abandoned, MAX_JOB_ATTEMPTS]);
    assert.equal((await row(swept)).status, 'failed');
    assert.deepEqual([(await row(live)).status, (await row(live)).attempts], ['rendering', MAX_JOB_ATTEMPTS]);
    assert.equal(await claimJob(pool, 'render'), null);
  });

  it('последняя попытка с истёкшей арендой — при следующем захвате failed, владельцу напишет API', async () => {
    const past = new Date(Date.now() - 60_000);
    const render = await insert('rendering', { attempts: MAX_JOB_ATTEMPTS, lease_until: past, failure_notified: true });
    const capture = await insert('capturing', { attempts: MAX_JOB_ATTEMPTS, lease_until: null, failure_notified: true });

    assert.equal(await claimJob(pool, 'render'), null);
    const r = await row(render);
    assert.deepEqual(
      [r.status, r.failed_from, r.failure_notified, r.lease_until, r.last_error],
      ['failed', 'rendering', false, null, `сборка: задание не завершилось за ${LEASE_MINUTES} мин — рабочий процесс студии упал или завис`],
    );
    assert.equal((await row(capture)).status, 'capturing', 'захват сборки чужую очередь не трогает');

    assert.equal(await claimJob(pool, 'capture'), null);
    const c = await row(capture);
    assert.deepEqual(
      [c.status, c.failed_from, c.failure_notified, c.last_error],
      ['failed', 'capturing', false, `съёмка: задание не завершилось за ${LEASE_MINUTES} мин — рабочий процесс студии упал или завис`],
    );
  });

  it('оживление: захват отдаёт итог прошлых попыток; по ходу и итог — только своим захватом; готово — render_queued', async () => {
    const before = { omniSeconds: 8, keyframes: 1, skits: {}, pending: { conflict: { id: 'gen-1', fingerprint: 'fp' } } };
    const id = await insert('animate_queued', { animation: JSON.stringify(before) });
    const job = await claimJob(pool, 'animate');
    assert.deepEqual([job?.id, job?.attempts, (await row(id)).status], [id, 1, 'animating']);
    assert.deepEqual(job?.animation, before);

    const mid = { ...before, omniSeconds: 16 };
    assert.equal(await saveAnimation(pool, job!, mid), true);
    assert.deepEqual((await row(id)).animation, mid);
    assert.equal(await saveAnimation(pool, { ...job!, attempts: 2 }, before), false, 'чужой захват не пишет');

    const done = { omniSeconds: 16, keyframes: 2, skits: {}, pending: {} };
    assert.equal(await completeAnimate(pool, job!, done), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.lease_until, r.animation], ['render_queued', 0, null, done]);
    assert.equal(await saveAnimation(pool, job!, before), false, 'после итога задание уже не на оживлении');
  });

  it('оживление упало без повтора — failed с этапа animating; с повтором — назад в очередь с паузой', async () => {
    const a = await insert('animate_queued');
    const ja = await claimJob(pool, 'animate');
    assert.equal(await failJob(pool, ja!, new StudioError('omni_budget', 'лимит пересъёмок сценок', false)), 'failed');
    const ra = await row(a);
    assert.deepEqual([ra.status, ra.failed_from, ra.last_error], ['failed', 'animating', 'оживление: лимит пересъёмок сценок']);

    const b = await insert('animate_queued');
    const jb = await claimJob(pool, 'animate');
    assert.equal(await failJob(pool, jb!, new StudioError('unknown', 'ECONNRESET', true)), 'retry');
    const rb = await row(b);
    assert.equal(rb.status, 'animate_queued');
    assert.ok(new Date(rb.lease_until).getTime() > Date.now());
  });

  it('предел секунд Omni — из настроек', async () => {
    assert.equal(await maxOmniSeconds(pool), 48);
    await pool.query('UPDATE short_settings SET max_omni_seconds = 96 WHERE id = 1');
    try {
      assert.equal(await maxOmniSeconds(pool), 96);
    } finally {
      await pool.query('UPDATE short_settings SET max_omni_seconds = 48 WHERE id = 1');
    }
  });

  it('съёмка готова — writing и съёмка в базе', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    const capture = { scene, questionShotKey: 'shorts/x/capture-1/question.png', answerShotKey: 'shorts/x/capture-1/answer.png', paragraphs: [{ n: 1, text: 'a' }] } as unknown as StoredCapture;
    assert.equal(await completeCapture(pool, job!, capture), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.attempts, r.lease_until, r.capture.answerShotKey], ['writing', 0, null, 'shorts/x/capture-1/answer.png']);
  });

  it('сборка готова — pending_review без сообщения владельцу, с файлами', async () => {
    const id = await insert('render_queued', { review_message_id: 55 });
    const job = await claimJob(pool, 'render');
    assert.equal(await completeRender(pool, job!, { videoKey: 'shorts/x/video.mp4', coverKey: 'shorts/x/cover.jpg', durationMs: 44000 }), true);
    const r = await row(id);
    assert.deepEqual([r.status, r.video_key, r.duration_ms, r.review_message_id], ['pending_review', 'shorts/x/video.mp4', 44000, null]);
  });

  it('опоздавшая сборка: аренда истекла, задание забрал другой процесс — ни сбой, ни итог не пишутся', async () => {
    const id = await insert('render_queued');
    const late = await claimJob(pool, 'render');
    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    const current = await claimJob(pool, 'render');
    assert.deepEqual([late?.attempts, current?.attempts], [1, 2]);
    const before = await row(id);

    assert.equal(await failJob(pool, late!, new StudioError('tts', 'SpeechKit не ответил', true)), 'gone');
    assert.equal(await failJob(pool, late!, new StudioError('no_input', 'нет сценария', false)), 'gone');
    assert.equal(await failJob(pool, { ...late!, writerRounds: 1 }, new StudioError('too_long', 'длинно', false)), 'gone');
    assert.equal(await failJob(pool, { ...late!, writerRounds: 3 }, new StudioError('too_long', 'длинно', false)), 'gone');
    assert.equal(await completeRender(pool, late!, { videoKey: 'v', coverKey: 'c', durationMs: 1 }), false);
    assert.deepEqual(await row(id), before);

    assert.equal(await completeRender(pool, current!, { videoKey: 'shorts/x/video.mp4', coverKey: 'shorts/x/cover.jpg', durationMs: 44000 }), true);
    assert.equal((await row(id)).status, 'pending_review');
  });

  it('опоздавшая съёмка — false, захват нового процесса цел', async () => {
    const id = await insert('capture_queued');
    const late = await claimJob(pool, 'capture');
    await pool.query(`UPDATE short_video SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    await claimJob(pool, 'capture');
    const before = await row(id);
    const capture = { scene, questionShotKey: 'q', answerShotKey: 'a' } as unknown as StoredCapture;
    assert.equal(await completeCapture(pool, late!, capture), false);
    assert.deepEqual(await row(id), before);
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

  it('озвучка длиннее 60 с — сценарий назад сценаристу; после третьего круга — failed с этапа сценариста', async () => {
    const id = await insert('render_queued', { writer_rounds: 2 });
    const job = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, job!, new StudioError('too_long', 'timeline: ролик 63.2 с — длиннее 60 с', false)), 'writer');
    const r = await row(id);
    assert.deepEqual(
      [r.status, r.writer_feedback, r.attempts, r.lease_until],
      ['writing', 'озвучка: timeline: ролик 63.2 с — длиннее 60 с', 0, null],
    );

    // Сценарист сдал третий вариант: writer_rounds + 1, отзыв студии стёрт (shorts-writer.service.ts).
    await pool.query(`UPDATE short_video SET status = 'render_queued', writer_rounds = 3, writer_feedback = NULL WHERE id = $1`, [id]);
    const last = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, last!, new StudioError('too_long', 'timeline: ролик 61.0 с — длиннее 60 с', false)), 'failed');
    const f = await row(id);
    assert.deepEqual(
      [f.status, f.failed_from, f.writer_feedback, f.failure_notified, f.lease_until, f.last_error],
      ['failed', 'writing', 'озвучка: timeline: ролик 61.0 с — длиннее 60 с', false, null, 'сборка: timeline: ролик 61.0 с — длиннее 60 с'],
    );
  });

  it('сценарий, отвергнутый студией (script_invalid), — назад сценаристу; после третьего круга — failed с этапа сценариста', async () => {
    const id = await insert('render_queued', { writer_rounds: 2 });
    const job = await claimJob(pool, 'render');
    const message = 'render: сценарий не прошёл проверку:\n- зацепка длиннее 8 слов';
    assert.equal(await failJob(pool, job!, new StudioError('script_invalid', message, false)), 'writer');
    const r = await row(id);
    assert.deepEqual([r.status, r.writer_feedback, r.attempts, r.lease_until], ['writing', message, 0, null]);

    // Сценарист сдал третий вариант: writer_rounds + 1, отзыв студии стёрт (shorts-writer.service.ts).
    await pool.query(`UPDATE short_video SET status = 'render_queued', writer_rounds = 3, writer_feedback = NULL WHERE id = $1`, [id]);
    const last = await claimJob(pool, 'render');
    assert.equal(await failJob(pool, last!, new StudioError('script_invalid', message, false)), 'failed');
    const f = await row(id);
    assert.deepEqual([f.status, f.failed_from, f.writer_feedback, f.failure_notified, f.lease_until], ['failed', 'writing', message, false, null]);
  });

  it('last_error: у незнакомой ошибки — только первая строка; предел 1000 — по символам', async () => {
    const id = await insert('capture_queued');
    const job = await claimJob(pool, 'capture');
    const unknown = new StudioError('unknown', 'page.goto: net::ERR_CONNECTION_RESET\nCall log:\n  - navigating to "https://test.example/chat"', true);
    assert.equal(await failJob(pool, job!, unknown), 'retry');
    assert.equal((await row(id)).last_error, 'съёмка: page.goto: net::ERR_CONNECTION_RESET');

    await pool.query(`UPDATE short_video SET lease_until = NULL WHERE id = $1`, [id]);
    const second = await claimJob(pool, 'capture');
    assert.equal(await failJob(pool, second!, new StudioError('answer_rejected', `x${'😀'.repeat(1200)}`, true)), 'retry');
    // 9 символов «съёмка: x» и 991 эмодзи; .slice по UTF-16 оставил бы 495 эмодзи и половину суррогатной пары.
    assert.equal((await row(id)).last_error, `съёмка: x${'😀'.repeat(991)}`);
  });

  it('порог длины ответа — из настроек', async () => {
    assert.equal(await minAnswerChars(pool), 400);
    await pool.query('UPDATE short_settings SET min_answer_chars = 500 WHERE id = 1');
    assert.equal(await minAnswerChars(pool), 500);
    await pool.query('UPDATE short_settings SET min_answer_chars = 400 WHERE id = 1');
  });
});
