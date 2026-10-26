import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import type { Script, ShortAnimation, SkitKind, SkitPlan } from '../types';
import { animateRun, type AnimateDeps } from './run-animate';

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

const LINES: Record<SkitKind, string[]> = {
  conflict: ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'],
  punchline: ['Три года — нормальный износ.', 'Га-га… ладно.'],
};

function plan(kind: SkitKind, lines = LINES[kind], fingerprint = `fp-${kind}`, keyframeFingerprint = `kf-${kind}`): SkitPlan {
  return {
    skit: {
      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'hallway',
      opening: 'at the door',
      action: 'argue',
      lines: lines.map((text, i) => ({ hero: i % 2 ? 'kesha' : 'galina', text })),
    },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: `kf ${kind} ${keyframeFingerprint}`,
    videoPrompt: `video ${kind}: ${lines.join(' / ')}`,
    keyframeFingerprint,
    fingerprint,
  };
}

/** Папка ролика с script.json и портретами; клип-фикстура — 8 с, 720×1280, синус. */
function setup(skits = { conflict: plan('conflict'), punchline: plan('punchline') }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  const runDir = path.join(root, 'run');
  const troupeDir = path.join(root, 'troupe');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(troupeDir, 'v1'), { recursive: true });
  for (const h of ['galina', 'kesha']) ff('-f', 'lavfi', '-i', 'color=c=white:s=64x128', '-frames:v', '1', path.join(troupeDir, 'v1', `${h}.png`));
  const clip = path.join(root, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=green:s=720x1280:d=8', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip);
  writeScript(runDir, skits);
  return { root, runDir, troupeDir, clip: fs.readFileSync(clip), png: fs.readFileSync(path.join(troupeDir, 'v1', 'kesha.png')) };
}

function writeScript(runDir: string, skits: { conflict: SkitPlan; punchline: SkitPlan }) {
  const script = { hook: 'Зацепка', voice: 'madirus', lines: [], final: { assistantsCount: 18 }, skits } as unknown as Script;
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(script));
}

const kindOf = (prompt: string): SkitKind => (prompt.includes('punchline') ? 'punchline' : 'conflict');

/** Подделка Google и SpeechKit. «Услышанное» по умолчанию — реплики своей сценки. */
function fakes(
  env: ReturnType<typeof setup>,
  o: {
    heard?: (kind: SkitKind, attempt: number) => string;
    start?: (kind: SkitKind, n: number) => void;
    clip?: (kind: SkitKind, n: number) => Buffer;
    keyframeDelayMs?: Partial<Record<SkitKind, number>>;
    keyframeImage?: { data: Buffer; mime: string };
    recognize?: (kind: SkitKind, attempt: number) => string;
  } = {},
) {
  const calls = { keyframe: [] as Array<{ kind: SkitKind; refs: number }>, start: [] as SkitKind[], startMime: [] as string[] };
  const ids = new Map<string, { kind: SkitKind; n: number }>();
  const deps: AnimateDeps = {
    keyframe: async (prompt, refs) => {
      const kind = kindOf(prompt);
      calls.keyframe.push({ kind, refs: refs.length });
      const delay = o.keyframeDelayMs?.[kind] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return o.keyframeImage ?? { data: env.png, mime: 'image/png' };
    },
    startClip: async (prompt, image) => {
      const kind = kindOf(prompt);
      const n = calls.start.filter((k) => k === kind).length + 1;
      calls.start.push(kind);
      calls.startMime.push(image.mime);
      o.start?.(kind, n);
      const id = `id-${calls.start.length}`;
      ids.set(id, { kind, n });
      return id;
    },
    waitClip: async (id) => {
      const { kind, n } = ids.get(id)!;
      return o.clip ? o.clip(kind, n) : env.clip;
    },
    recognize: async (_ogg, ctx) => (o.recognize ?? o.heard ?? ((kind: SkitKind) => LINES[kind].join(' ')))(ctx.kind, ctx.attempt),
    troupeDir: env.troupeDir,
  };
  return { deps, calls };
}

const readAnim = (runDir: string): ShortAnimation => JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8'));

test('обе сценки: кадры по очереди, клипы, речь сошлась, секунды Omni посчитаны', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env);
  const anim = await animateRun(env.runDir, deps);
  assert.deepEqual(calls.keyframe, [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual([...calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.omniSeconds, 16);
  for (const kind of ['conflict', 'punchline'] as const) {
    const s = anim.skits[kind]!;
    assert.equal(s.fingerprint, `fp-${kind}`);
    assert.equal(s.keyframe, `keyframes/kf-${kind}.png`);
    assert.equal(s.attempts, 1);
    assert.equal(s.cues.length, 2);
    assert.ok(Math.abs(s.durationMs - 8000) < 200, `длина ${s.durationMs}`);
    assert.ok(fs.statSync(path.join(env.runDir, s.clip)).size > 1000);
    assert.ok(fs.existsSync(path.join(env.runDir, s.keyframe)));
  }
  assert.deepEqual(readAnim(env.runDir), anim);
});

test('повторный запуск с теми же сценками ничего не генерирует', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const again = fakes(env);
  const anim = await animateRun(env.runDir, again.deps);
  assert.deepEqual(again.calls, { keyframe: [], start: [], startMime: [] });
  assert.equal(anim.omniSeconds, 16);
});

test('правка реплик развязки — новый клип с прежнего кадра, конфликт не трогается', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  LINES.punchline = lines;
  try {
    writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
    const second = fakes(env);
    const anim = await animateRun(env.runDir, second.deps);
    assert.deepEqual(second.calls.keyframe, []);
    assert.deepEqual(second.calls.start, ['punchline']);
    assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
    assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline-2');
    assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline.png');
    assert.equal(anim.omniSeconds, 24);
  } finally {
    LINES.punchline = ['Три года — нормальный износ.', 'Га-га… ладно.'];
  }
});

test('новое место конфликта перерисовывает обе сценки: развязка — по новому кадру конфликта', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  writeScript(env.runDir, {
    conflict: plan('conflict', LINES.conflict, 'fp-conflict-2', 'kf-conflict-2'),
    punchline: plan('punchline', LINES.punchline, 'fp-punchline-2', 'kf-punchline-2'),
  });
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.keyframe, [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual([...second.calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline-2.png');
  assert.equal(anim.omniSeconds, 32);
});

test('речь не сошлась — пересъёмка клипа без нового кадра', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, { heard: (kind, attempt) => (kind === 'conflict' && attempt === 1 ? '' : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.length, 2);
  assert.equal(anim.omniSeconds, 24);
});

test('отказ фильтра — новая попытка с прежним кадром: по нему уже нарисована развязка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_rejected', 'omni: отказ фильтра', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.filter((k) => k.kind === 'conflict').length, 1);
  assert.equal(anim.omniSeconds, 16, 'несостоявшийся запуск не списывается');
});

test('битый файл от Omni — пересъёмка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { clip: (kind, n) => (kind === 'conflict' && n === 1 ? Buffer.from('not a video') : env.clip) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
});

test('квота — сразу ошибка без повтора, секунды не списаны, готовая сценка сохранена', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_quota', 'omni: квота', false);
    },
  });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => e instanceof StudioError && e.code === 'google_quota');
  assert.equal(calls.start.filter((k) => k === 'conflict').length, 1);
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.equal(anim.skits.conflict, undefined);
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline');
});

test('предел секунд Omni на ролик', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { keyframeDelayMs: { punchline: 50 } });
  await assert.rejects(
    animateRun(env.runDir, { ...deps, maxOmniSeconds: 8 }),
    (e: unknown) => e instanceof StudioError && e.code === 'omni_budget' && !e.retryable && /предел — 8 с/.test(e.message),
  );
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.ok(anim.skits.conflict);
});

test('три несовпадения речи — сдаётся с причиной', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => e instanceof StudioError && e.code === 'speech_mismatch' && !e.retryable && /после 3 попыток/.test(e.message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 32);
});

test('в сценарии нет сценок — ошибка до трат', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify({ hook: 'x', voice: 'v', lines: [], final: { assistantsCount: 18 } }));
  await assert.rejects(
    animateRun(root, {} as AnimateDeps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('нет портрета героя — ошибка без повтора', async () => {
  const env = setup();
  fs.rmSync(path.join(env.troupeDir, 'v1', 'kesha.png'));
  await assert.rejects(
    animateRun(env.runDir, fakes(env).deps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid' && /kesha/.test(e.message),
  );
});

test('кадр в JPEG сохраняется .jpg и уходит в Omni как image/jpeg', { timeout: 120_000 }, async () => {
  const env = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  const { deps, calls } = fakes(env, { keyframeImage: { data: jpeg, mime: 'image/jpeg' } });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.keyframe, 'keyframes/kf-conflict.jpg');
  assert.deepEqual(calls.startMime, ['image/jpeg', 'image/jpeg']);
});

test('запуск с потерянным ответом — секунды не возвращаются: генерация могла начаться', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_failed', 'omni: запуск — ответ потерян, генерация могла начаться', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(anim.omniSeconds, 24);
});

test('распознавание упало — перезапуск берёт уже оплаченный клип, а не снимает новый', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    recognize: (kind) => {
      if (kind === 'conflict') throw new StudioError('stt', 'stt: распознать речь не удалось', false);
      return LINES[kind].join(' ');
    },
  });
  await assert.rejects(animateRun(env.runDir, first.deps), (e: unknown) => e instanceof StudioError && e.code === 'stt');
  assert.equal(readAnim(env.runDir).omniSeconds, 16);
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, []);
  assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
  assert.equal(anim.omniSeconds, 16);
});

test('новая громкость — сценка переобрабатывается из оплаченного клипа, без Omni', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = await animateRun(env.runDir, fakes(env).deps);
  assert.match(first.skits.conflict!.post, /^lufs=-19;/);
  const second = fakes(env);
  const anim = await animateRun(env.runDir, { ...second.deps, lufs: -23 });
  assert.deepEqual(second.calls.start, []);
  assert.deepEqual(second.calls.keyframe, []);
  assert.match(anim.skits.conflict!.post, /^lufs=-23;/);
  assert.match(anim.skits.punchline!.post, /^lufs=-23;/);
  assert.equal(anim.omniSeconds, 16);
});
