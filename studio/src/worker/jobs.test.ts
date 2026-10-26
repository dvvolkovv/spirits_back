import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import type { RenderResult } from '../render/run-render';
import type { CaptureResult, Scene, Script } from '../types';
import type { FailOutcome, Job, Queue, RenderOutput, StoredCapture } from './db';
import { coverKey, pruneOld, runOne, shotKey, videoKey, type JobDeps } from './jobs';
import type { Storage } from './storage';

const ID = '6f1c2a9e-0d4b-4c3e-9a51-3b2f7c8d9e10';
const scene: Scene = { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Вопрос', followups: [] };
const script = { hook: 'h', voice: 'madirus', lines: [], final: { assistantsCount: 18 } } as unknown as Script;

/** written — что вернут записи итога; failOutcome — исход сбоя. jobs — задания, с которыми звали очередь. */
function fakeQueue(jobs: Partial<Record<'capture' | 'render', Job>>, opts: { written?: boolean; failOutcome?: FailOutcome } = {}) {
  const calls: Record<string, unknown[]> = { capture: [], render: [], fail: [], claim: [], jobs: [] };
  const queue: Queue = {
    async claim(kind) {
      calls.claim.push(kind);
      const job = jobs[kind] ?? null;
      delete jobs[kind];
      return job;
    },
    async completeCapture(j, capture) {
      calls.capture.push([j.id, capture]);
      calls.jobs.push(j);
      return opts.written ?? true;
    },
    async completeRender(j, out) {
      calls.render.push([j.id, out]);
      calls.jobs.push(j);
      return opts.written ?? true;
    },
    async fail(j, err): Promise<FailOutcome> {
      calls.fail.push([j.id, err]);
      calls.jobs.push(j);
      return opts.failOutcome ?? 'retry';
    },
    async minAnswerChars() {
      return 500;
    },
  };
  return { queue, calls };
}

function fakeStorage() {
  const files = new Map<string, string>();
  const storage: Storage = {
    async put(key, file) {
      files.set(key, fs.readFileSync(file, 'utf8'));
    },
    async get(key, dest) {
      fs.writeFileSync(dest, files.get(key) ?? '');
    },
  };
  return { storage, files };
}

function deps(over: Partial<JobDeps> & Pick<JobDeps, 'queue' | 'storage'>): JobDeps {
  return {
    workRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'studio-jobs-')),
    capture: async () => {
      throw new Error('съёмка не ожидалась');
    },
    render: async () => {
      throw new Error('сборка не ожидалась');
    },
    log: () => {},
    ...over,
  };
}

const job = (kind: 'capture' | 'render', over: Partial<Job> = {}): Job => ({
  id: ID, kind, attempts: 1, writerRounds: 0, scene, capture: null, script: null, ...over,
});

test('съёмка: снимки — в MinIO под ключами попытки, съёмка — в базу без путей', async () => {
  const { queue, calls } = fakeQueue({ capture: job('capture', { attempts: 2 }) });
  const { storage, files } = fakeStorage();
  let minChars = 0;
  const d = deps({
    queue,
    storage,
    capture: async (s, runDir, min) => {
      minChars = min;
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(runDir, 'question.png'), 'вопрос');
      fs.writeFileSync(path.join(runDir, 'answer.png'), 'ответ');
      return { scene: s, questionShot: 'question.png', answerShot: 'answer.png', boxes: [], paragraphs: [] } as unknown as CaptureResult;
    },
  });
  assert.equal(await runOne(d), true);
  assert.equal(minChars, 500);
  assert.equal(files.get(shotKey(ID, 2, 'answer.png')), 'ответ');
  const [id, stored] = calls.capture[0] as [string, StoredCapture & Record<string, unknown>];
  assert.equal(id, ID);
  assert.equal(stored.questionShotKey, `shorts/${ID}/capture-2/question.png`);
  assert.equal('questionShot' in stored, false);
});

test('сборка: снимки из MinIO, сценарий и съёмка файлами, видео и обложка — в MinIO', async () => {
  const capture = { scene, questionShotKey: 'q-key', answerShotKey: 'a-key', boxes: [], paragraphs: [] } as unknown as StoredCapture;
  const { queue, calls } = fakeQueue({ render: job('render', { capture, script }) });
  const { storage, files } = fakeStorage();
  files.set('q-key', 'вопрос');
  files.set('a-key', 'ответ');
  const d = deps({
    queue,
    storage,
    render: async (runDir): Promise<RenderResult> => {
      assert.equal(fs.readFileSync(path.join(runDir, 'answer.png'), 'utf8'), 'ответ');
      const c = JSON.parse(fs.readFileSync(path.join(runDir, 'capture.json'), 'utf8'));
      assert.deepEqual([c.questionShot, c.answerShot, 'answerShotKey' in c], ['question.png', 'answer.png', false]);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')), script);
      fs.writeFileSync(path.join(runDir, 'video.mp4'), 'видео');
      fs.writeFileSync(path.join(runDir, 'cover.jpg'), 'обложка');
      return { video: path.join(runDir, 'video.mp4'), cover: path.join(runDir, 'cover.jpg'), problems: [], durationSec: 44.2 };
    },
  });
  assert.equal(await runOne(d), true);
  assert.equal(files.get(videoKey(ID)), 'видео');
  assert.equal(files.get(coverKey(ID)), 'обложка');
  assert.deepEqual(calls.render[0], [ID, { videoKey: `shorts/${ID}/video.mp4`, coverKey: `shorts/${ID}/cover.jpg`, durationMs: 44200 } satisfies RenderOutput]);
});

test('сборка — первой: ролик ближе к концу пути', async () => {
  const { queue, calls } = fakeQueue({ capture: job('capture'), render: job('render') });
  await runOne(deps({ queue, storage: fakeStorage().storage }));
  assert.equal(calls.claim[0], 'render');
});

test('проверка файла не прошла — video_invalid с повтором', async () => {
  const capture = { scene, questionShotKey: 'q', answerShotKey: 'a' } as unknown as StoredCapture;
  const { queue, calls } = fakeQueue({ render: job('render', { capture, script }) });
  const d = deps({
    queue,
    storage: fakeStorage().storage,
    render: async (runDir) => ({ video: path.join(runDir, 'v'), cover: path.join(runDir, 'c'), problems: ['тишина 3.1 с с 23.0 с'], durationSec: 44 }),
  });
  await runOne(d);
  const [, err] = calls.fail[0] as [string, StudioError];
  assert.deepEqual([err.code, err.retryable], ['video_invalid', true]);
  assert.match(err.message, /тишина 3.1 с/);
});

test('незнакомая ошибка — unknown с повтором; задание без сцены — no_input без повтора', async () => {
  const a = fakeQueue({ capture: job('capture') });
  await runOne(deps({ queue: a.queue, storage: fakeStorage().storage, capture: async () => { throw new Error('ECONNRESET'); } }));
  assert.deepEqual([(a.calls.fail[0] as [string, StudioError])[1].code, (a.calls.fail[0] as [string, StudioError])[1].retryable], ['unknown', true]);

  const b = fakeQueue({ capture: job('capture', { scene: null }) });
  await runOne(deps({ queue: b.queue, storage: fakeStorage().storage }));
  assert.deepEqual([(b.calls.fail[0] as [string, StudioError])[1].code, (b.calls.fail[0] as [string, StudioError])[1].retryable], ['no_input', false]);
});

const GONE = 'задание забрал другой процесс — итог не записан';

test('итог и сбой — по захвату: очередь получает само задание с номером попытки', async () => {
  const capture = { scene, questionShotKey: 'q', answerShotKey: 'a' } as unknown as StoredCapture;
  const claimed = job('render', { attempts: 2, capture, script });
  const { queue, calls } = fakeQueue({ render: claimed });
  await runOne(deps({
    queue,
    storage: fakeStorage().storage,
    render: async (runDir) => {
      fs.writeFileSync(path.join(runDir, 'video.mp4'), 'видео');
      fs.writeFileSync(path.join(runDir, 'cover.jpg'), 'обложка');
      return { video: path.join(runDir, 'video.mp4'), cover: path.join(runDir, 'cover.jpg'), problems: [], durationSec: 40 };
    },
  }));
  assert.equal(calls.jobs[0], claimed);

  const claimedCapture = job('capture', { attempts: 3 });
  const b = fakeQueue({ capture: claimedCapture });
  await runOne(deps({ queue: b.queue, storage: fakeStorage().storage, capture: async () => { throw new Error('ECONNRESET'); } }));
  assert.equal(b.calls.jobs[0], claimedCapture);
});

test('задание забрал другой процесс: сбой — gone, итог — false; без исключения, строка в лог', async () => {
  const failLog: string[] = [];
  const a = fakeQueue({ capture: job('capture') }, { failOutcome: 'gone' });
  const did = await runOne(deps({
    queue: a.queue,
    storage: fakeStorage().storage,
    log: (line) => failLog.push(line),
    capture: async () => { throw new Error('ECONNRESET'); },
  }));
  assert.equal(did, true);
  assert.ok(failLog.some((line) => line.includes(`capture ${ID}`) && line.includes(GONE)), failLog.join('\n'));

  const doneLog: string[] = [];
  const capture = { scene, questionShotKey: 'q', answerShotKey: 'a' } as unknown as StoredCapture;
  const b = fakeQueue({ render: job('render', { capture, script }) }, { written: false });
  await runOne(deps({
    queue: b.queue,
    storage: fakeStorage().storage,
    log: (line) => doneLog.push(line),
    render: async (runDir) => {
      fs.writeFileSync(path.join(runDir, 'video.mp4'), 'видео');
      fs.writeFileSync(path.join(runDir, 'cover.jpg'), 'обложка');
      return { video: path.join(runDir, 'video.mp4'), cover: path.join(runDir, 'cover.jpg'), problems: [], durationSec: 40 };
    },
  }));
  assert.equal(b.calls.fail.length, 0, 'неудавшаяся запись итога — не сбой задания');
  assert.ok(doneLog.some((line) => line.includes(`render ${ID}`) && line.includes(GONE)), doneLog.join('\n'));
  assert.equal(doneLog.some((line) => line.includes('готово')), false, doneLog.join('\n'));
});

test('нет заданий — false', async () => {
  assert.equal(await runOne(deps({ queue: fakeQueue({}).queue, storage: fakeStorage().storage })), false);
});

test('старые рабочие папки удаляются, свежие — нет', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-prune-'));
  fs.mkdirSync(path.join(root, 'old'));
  fs.mkdirSync(path.join(root, 'fresh'));
  const weekAgo = new Date(Date.now() - 8 * 86_400_000);
  fs.utimesSync(path.join(root, 'old'), weekAgo, weekAgo);
  assert.equal(pruneOld(root, 7), 1);
  assert.deepEqual(fs.readdirSync(root), ['fresh']);
  assert.equal(pruneOld(path.join(root, 'нет такой'), 7), 0);
});
