// Деньги и падения оживления на стыке: настоящие runAnimate (jobs.ts), animateRun
// (run-animate.ts) и s3Storage (storage.ts); подделаны S3-клиент, очередь и Google.
// Сценарии — из ревью плана 4 (задачи 10–14): каждый раньше платил Omni дважды,
// терял счёт кадров или ронял ролик в failed без нужды.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StudioError } from '../errors';
import { animateRun } from '../animate/run-animate';
import type { Scene, Script, ShortAnimation, SkitKind, SkitPlan } from '../types';
import type { FailOutcome, Job, Queue, StoredCapture } from './db';
import { runOne, type JobDeps } from './jobs';
import { s3Storage } from './storage';

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const LINES: Record<SkitKind, string[]> = {
  conflict: ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'],
  punchline: ['Три года — нормальный износ.', 'Га-га… ладно.'],
};
function plan(kind: SkitKind): SkitPlan {
  return {
    skit: {
      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'hallway', opening: 'at the door', action: 'argue',
      lines: LINES[kind].map((text, i) => ({ hero: i % 2 ? 'kesha' : 'galina', text })),
    },
    troupeVersion: 'v1', heroes: ['galina', 'kesha'],
    keyframePrompt: `kf ${kind}`, videoPrompt: `video ${kind}: ${LINES[kind].join(' / ')}`,
    keyframeFingerprint: `kf-${kind}`, fingerprint: `fp-${kind}`,
  } as SkitPlan;
}
const scene: Scene = { kind: 'chat', assistantId: 10, assistantName: 'Алекс', question: 'q', followups: [] };
const script = {
  hook: 'Залог за обои?', voice: 'madirus',
  lines: [{ id: 'q', scene: 'question', text: 'Вопрос' }, { id: 'a1', scene: 'answer', text: 'Ответ', box: 1 }, { id: 'f', scene: 'final', text: 'Финал' }],
  final: { assistantsCount: 18 },
  skits: { conflict: plan('conflict'), punchline: plan('punchline') },
} as unknown as Script;
const capture = { scene, questionShotKey: 'q', answerShotKey: 'a', boxes: [{ n: 1, top: 0, height: 10, text: 'a' }], paragraphs: [] } as unknown as StoredCapture;
const kindOf = (p: string): SkitKind => (p.includes('punchline') ? 'punchline' : 'conflict');
const key = (rel: string) => `shorts/${ID}/${rel}`;

const roots: string[] = [];
test.after(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

function env() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-money-'));
  roots.push(root);
  const troupeDir = path.join(root, 'troupe');
  fs.mkdirSync(path.join(troupeDir, 'v1'), { recursive: true });
  for (const h of ['galina', 'kesha']) ff('-f', 'lavfi', '-i', 'color=c=white:s=64x128', '-frames:v', '1', path.join(troupeDir, 'v1', `${h}.png`));
  const clipFile = path.join(root, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=green:s=720x1280:d=8', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipFile);
  return { root, troupeDir, clip: fs.readFileSync(clipFile), png: fs.readFileSync(path.join(troupeDir, 'v1', 'kesha.png')) };
}

/** S3 как его видит s3Storage: put падает N раз по ключу, get по ключу отдаёт половину тела и рвётся; delete удаляет. */
class FakeS3 {
  objects = new Map<string, Buffer>();
  putFail = new Map<string, number>();
  getPartial = new Map<string, number>();
  puts: string[] = [];
  async send(cmd: any) {
    const name = cmd.constructor.name;
    const k = cmd.input.Key as string;
    if (name === 'PutObjectCommand') {
      const n = this.putFail.get(k) ?? 0;
      if (n > 0) {
        this.putFail.set(k, n - 1);
        throw Object.assign(new Error('MinIO: 503 Slow Down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });
      }
      this.objects.set(k, Buffer.from(cmd.input.Body));
      this.puts.push(k);
      return {};
    }
    if (name === 'GetObjectCommand') {
      const b = this.objects.get(k);
      if (!b) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      const n = this.getPartial.get(k) ?? 0;
      if (n > 0) {
        this.getPartial.set(k, n - 1);
        const half = b.subarray(0, Math.floor(b.length / 2));
        let sent = false;
        return {
          Body: new Readable({
            read() {
              if (!sent) { sent = true; this.push(half); } else setTimeout(() => this.destroy(new Error('socket hang up')), 20);
            },
          }),
        };
      }
      return { Body: Readable.from([b]) };
    }
    if (name === 'DeleteObjectCommand') {
      this.objects.delete(k);
      return {};
    }
    throw new Error(`unexpected ${name}`);
  }
}

/** Строка short_video в памяти; запись — по номеру захвата, как в db.ts. */
function fakeDb(o: { animation?: ShortAnimation | null; saveThrow?: (a: ShortAnimation) => boolean } = {}) {
  const row = { status: 'animate_queued', attempts: 0, animation: (o.animation ?? null) as ShortAnimation | null };
  const fails: Array<{ err: StudioError; outcome: FailOutcome }> = [];
  const queue: Queue = {
    async claim(kind) {
      if (kind !== 'animate' || row.status !== 'animate_queued') return null;
      row.status = 'animating';
      row.attempts += 1;
      return { id: ID, kind, attempts: row.attempts, writerRounds: 0, scene, capture, script, animation: row.animation ? structuredClone(row.animation) : null } as Job;
    },
    async saveAnimation(job, a) {
      if (row.status !== 'animating' || row.attempts !== job.attempts) return false;
      if (o.saveThrow?.(a)) throw new Error('Connection terminated unexpectedly');
      row.animation = structuredClone(a);
      return true;
    },
    async completeAnimate(job, a) {
      if (row.status !== 'animating' || row.attempts !== job.attempts) return false;
      Object.assign(row, { status: 'render_queued', attempts: 0, animation: structuredClone(a) });
      return true;
    },
    async fail(job, err) {
      const outcome: FailOutcome = err.retryable && job.attempts < 3 ? 'retry' : 'failed';
      row.status = outcome === 'retry' ? 'animate_queued' : 'failed';
      fails.push({ err, outcome });
      return outcome;
    },
    async completeCapture() { throw new Error('нет'); },
    async completeRender() { throw new Error('нет'); },
    async minAnswerChars() { return 400; },
    async maxOmniSeconds() { return 48; },
  };
  /** «Повторить» из failed (shorts.controller.ts retry): animate_queued, attempts = 0. */
  const retry = () => { assert.equal(row.status, 'failed'); row.status = 'animate_queued'; row.attempts = 0; };
  return { queue, row, fails, retry };
}

function google(e: ReturnType<typeof env>, o: { wait?: (id: string) => Buffer } = {}) {
  const calls = { keyframe: [] as SkitKind[], start: [] as SkitKind[], recognize: [] as SkitKind[] };
  let n = 0;
  return {
    calls,
    deps: {
      keyframe: async (prompt: string) => {
        calls.keyframe.push(kindOf(prompt));
        return { data: Buffer.concat([e.png, Buffer.from(`#${++n}`)]), mime: 'image/png' };
      },
      startClip: async (prompt: string) => {
        const k = kindOf(prompt);
        calls.start.push(k);
        return `id-${k}-${calls.start.filter((x) => x === k).length}`;
      },
      waitClip: async (id: string) => (o.wait ? o.wait(id) : e.clip),
      recognize: async (_ogg: Buffer, ctx: { kind: SkitKind }) => {
        calls.recognize.push(ctx.kind);
        return LINES[ctx.kind].join(' ');
      },
      troupeDir: e.troupeDir,
    },
  };
}

function worker(workRoot: string, db: ReturnType<typeof fakeDb>, s3: FakeS3, g: ReturnType<typeof google>): JobDeps {
  return {
    queue: db.queue,
    storage: s3Storage({ endpoint: 'http://x', accessKey: 'a', secretKey: 's', bucket: 'b' } as any, s3),
    workRoot,
    capture: async () => { throw new Error('нет'); },
    render: async () => { throw new Error('нет'); },
    animate: (runDir, hooks) =>
      animateRun(runDir, { ...g.deps, maxOmniSeconds: hooks.maxOmniSeconds, onSave: hooks.onSave, onFile: hooks.onFile, onDiscard: hooks.onDiscard }),
    log: () => {},
    saveRetryDelaysMs: [1, 1],
  };
}

const animDir = (workRoot: string) => path.join(workRoot, ID, 'animate');
const partFiles = (dir: string): string[] =>
  fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.includes('.part-')) : [];

test('обрыв скачивания из MinIO — ни обрезанного raw.mp4, ни новой оплаты: следующий захват докачивает', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  // Прошлый захват на другом сервере: оба клипа оплачены и выгружены, процесс убит посреди обработки.
  s3.objects.set(key('keyframes/kf-conflict.png'), e.png);
  s3.objects.set(key('keyframes/kf-punchline.png'), e.png);
  s3.objects.set(key('skits/fp-conflict/raw.mp4'), e.clip);
  s3.objects.set(key('skits/fp-punchline/raw.mp4'), e.clip);
  const db = fakeDb({ animation: { omniSeconds: 16, keyframes: 2, skits: {}, pending: {} } });
  const workRoot = path.join(e.root, 'jobs');
  s3.getPartial.set(key('skits/fp-conflict/raw.mp4'), 1);

  const g1 = google(e);
  await runOne(worker(workRoot, db, s3, g1));
  assert.deepEqual(db.fails.map((f) => f.outcome), ['retry']);
  assert.equal(fs.existsSync(path.join(animDir(workRoot), 'skits/fp-conflict/raw.mp4')), false);
  assert.deepEqual(partFiles(animDir(workRoot)), []);

  const g2 = google(e);
  await runOne(worker(workRoot, db, s3, g2));
  assert.equal(db.row.status, 'render_queued');
  assert.deepEqual([...g1.calls.start, ...g2.calls.start], []);
  assert.equal(db.row.animation?.omniSeconds, 16);
});

test('база моргнула на записи id генерации — запись повторяется, задание не падает, клип оплачен один раз', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  let thrown = false;
  const db = fakeDb({
    saveThrow: (a) => {
      if (!thrown && a.pending?.conflict) {
        thrown = true;
        return true;
      }
      return false;
    },
  });
  const g = google(e);
  await runOne(worker(path.join(e.root, 'jobs'), db, s3, g));
  assert.equal(thrown, true);
  assert.deepEqual(db.fails, []);
  assert.equal(db.row.status, 'render_queued');
  assert.equal(g.calls.start.filter((k) => k === 'conflict').length, 1);
});

test('база лежит дольше повторов записи — failed, а «Повторить» на том же сервере дожидается id из своей папки', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  let n = 0;
  const db = fakeDb({ saveThrow: (a) => !!a.pending?.conflict && ++n <= 10 });
  const workRoot = path.join(e.root, 'jobs');
  const g1 = google(e);
  await runOne(worker(workRoot, db, s3, g1));
  assert.equal(db.row.status, 'failed');
  assert.equal(db.row.animation?.pending?.conflict, undefined);
  n = 100; // база ожила
  db.retry();
  const g2 = google(e);
  await runOne(worker(workRoot, db, s3, g2));
  assert.equal(db.row.status, 'render_queued');
  assert.equal([...g1.calls.start, ...g2.calls.start].filter((k) => k === 'conflict').length, 1);
});

test('кадр не выгрузился — счёт кадров верный, повтор выгружает кадр из папки', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  s3.putFail.set(key('keyframes/kf-conflict.png'), 1);
  const db = fakeDb();
  const workRoot = path.join(e.root, 'jobs');
  const g1 = google(e);
  await runOne(worker(workRoot, db, s3, g1));
  assert.deepEqual(db.fails.map((f) => f.outcome), ['retry']);
  assert.equal(db.row.animation?.keyframes, g1.calls.keyframe.length);
  const g2 = google(e);
  await runOne(worker(workRoot, db, s3, g2));
  assert.equal(db.row.status, 'render_queued');
  assert.ok(s3.objects.has(key('keyframes/kf-conflict.png')));
  assert.equal(db.row.animation?.keyframes, g1.calls.keyframe.length + g2.calls.keyframe.length);
});

test('кадр, не выгрузившийся на сервере A, доходит до MinIO — на сервере B конфликт переснимается, ролик не застревает в failed', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  s3.putFail.set(key('keyframes/kf-conflict.png'), 1);
  const db = fakeDb();
  const rootA = path.join(e.root, 'serverA');
  await runOne(worker(rootA, db, s3, google(e)));
  // Сервер A: генерация конфликта трижды не дождалась срока — failed, id в базе.
  const gA = google(e, {
    wait: (id) => {
      if (id.startsWith('id-conflict')) throw new StudioError('omni_timeout', 'omni: не дождались клипа за 6 мин', true);
      return e.clip;
    },
  });
  await runOne(worker(rootA, db, s3, gA));
  assert.equal(db.row.status, 'failed');
  // «Повторить» на сервере B (или через неделю, когда pruneOld убрал папку A): генерация у Google провалена.
  db.retry();
  const gB = google(e, {
    wait: (id) => {
      if (id === 'id-conflict-1') throw new StudioError('omni_failed', 'omni: генерация провалена', true);
      return e.clip;
    },
  });
  await runOne(worker(path.join(e.root, 'serverB'), db, s3, gB));
  assert.equal(db.row.status, 'render_queued');
});

test('моргнул MinIO на выгрузке raw.mp4 — повтор задания с паузой, а не три мгновенные «попытки» Omni и failed', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  s3.putFail.set(key('skits/fp-conflict/raw.mp4'), 3);
  const db = fakeDb();
  const g = google(e);
  await runOne(worker(path.join(e.root, 'jobs'), db, s3, g));
  assert.equal(db.fails[0]?.outcome, 'retry');
  assert.doesNotMatch(db.fails[0].err.message, /после \d+ попыток/);
  assert.equal(g.calls.start.filter((k) => k === 'conflict').length, 1);
});

test('clip.mp4 не выгрузился — повтор без нового клипа, попытка сценки не потрачена', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  s3.putFail.set(key('skits/fp-conflict/clip.mp4'), 1);
  const db = fakeDb();
  const workRoot = path.join(e.root, 'jobs');
  const g1 = google(e);
  await runOne(worker(workRoot, db, s3, g1));
  assert.deepEqual(db.fails.map((f) => f.outcome), ['retry']);
  const g2 = google(e);
  await runOne(worker(workRoot, db, s3, g2));
  assert.equal(db.row.status, 'render_queued');
  assert.equal([...g1.calls.start, ...g2.calls.start].filter((k) => k === 'conflict').length, 1);
  assert.equal(db.row.animation?.skits.conflict?.attempts, 1);
});

function googleR6(e: ReturnType<typeof env>, wrongConflictCalls: number[], quotaIds: string[]) {
  const g = google(e, {
    wait: (id) => {
      if (quotaIds.includes(id)) throw new StudioError('google_quota', 'omni: квота исчерпана', false);
      return e.clip;
    },
  });
  let conflictCalls = 0;
  const base = g.deps.recognize;
  g.deps.recognize = async (ogg: Buffer, ctx: { kind: SkitKind }) => {
    if (ctx.kind === 'conflict') {
      conflictCalls++;
      if (wrongConflictCalls.includes(conflictCalls)) {
        g.calls.recognize.push(ctx.kind);
        return 'совсем другие слова про погоду';
      }
    }
    return base(ogg, ctx);
  };
  return g;
}

test('брак удаляется и из MinIO — «Повторить» дожидается запущенной генерации, а не достаёт брак и не платит снова', { timeout: 120_000 }, async () => {
  const e = env();
  const s3 = new FakeS3();
  const db = fakeDb();
  const workRoot = path.join(e.root, 'jobs');
  // Захват 1: клип конфликта 1 не прошёл сверку речи (брак); клип 2 запущен, ожидание упёрлось в квоту — failed, id в базе.
  const g1 = googleR6(e, [1, 2], ['id-conflict-2']);
  await runOne(worker(workRoot, db, s3, g1));
  assert.equal(db.row.status, 'failed');
  assert.equal(db.row.animation?.pending?.conflict?.id, 'id-conflict-2');
  assert.equal(s3.objects.has(key('skits/fp-conflict/raw.mp4')), false);
  db.retry();
  // Тот же сервер, квота вернулась. Локальный брак отложен в rejected-*.mp4, в MinIO его нет.
  const g2 = googleR6(e, [], []);
  const waited: string[] = [];
  const w2 = g2.deps.waitClip;
  g2.deps.waitClip = async (id: string) => {
    waited.push(id);
    return w2(id);
  };
  await runOne(worker(workRoot, db, s3, g2));
  assert.equal(db.row.status, 'render_queued');
  assert.ok(waited.includes('id-conflict-2'));
  assert.deepEqual(g2.calls.start, []);
  assert.equal([...g1.calls.start, ...g2.calls.start].filter((k) => k === 'conflict').length, 2);
});
