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

const roots: string[] = [];
test.after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

/** Папка ролика с script.json и портретами; клип-фикстура — 8 с, 720×1280, синус. */
function setup(skits = { conflict: plan('conflict'), punchline: plan('punchline') }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  roots.push(root);
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

/**
 * Подделка Google и SpeechKit. Кадры — разные байты на каждый вызов (PNG и
 * номер), «услышанное» по умолчанию — реплики своей сценки.
 */
function fakes(
  env: ReturnType<typeof setup>,
  o: {
    heard?: (kind: SkitKind, call: number) => string;
    start?: (kind: SkitKind, n: number) => void;
    wait?: (kind: SkitKind, n: number) => Buffer;
    keyframe?: (kind: SkitKind, n: number) => void;
    keyframeDelayMs?: Partial<Record<SkitKind, number>>;
    keyframeImage?: { data: Buffer; mime: string };
  } = {},
) {
  const calls = {
    keyframe: [] as Array<{ kind: SkitKind; refs: number; last?: Buffer }>,
    start: [] as SkitKind[],
    startMime: [] as string[],
    wait: [] as string[],
    recognize: 0,
    images: [] as Buffer[],
  };
  const ids = new Map<string, { kind: SkitKind; n: number }>();
  const recognized: Record<SkitKind, number> = { conflict: 0, punchline: 0 };
  const deps: AnimateDeps = {
    keyframe: async (prompt, refs) => {
      const kind = kindOf(prompt);
      const n = calls.keyframe.filter((k) => k.kind === kind).length + 1;
      calls.keyframe.push({ kind, refs: refs.length, last: refs[refs.length - 1]?.data });
      o.keyframe?.(kind, n);
      const delay = o.keyframeDelayMs?.[kind] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (o.keyframeImage) return o.keyframeImage;
      const data = Buffer.concat([env.png, Buffer.from(`#${calls.keyframe.length}`)]);
      calls.images.push(data);
      return { data, mime: 'image/png' };
    },
    startClip: async (prompt, image) => {
      const kind = kindOf(prompt);
      const n = calls.start.filter((k) => k === kind).length + 1;
      calls.start.push(kind);
      calls.startMime.push(image.mime);
      o.start?.(kind, n);
      const id = `id-${kind}-${n}`;
      ids.set(id, { kind, n });
      return id;
    },
    waitClip: async (id) => {
      calls.wait.push(id);
      const meta = ids.get(id);
      return meta && o.wait ? o.wait(meta.kind, meta.n) : env.clip;
    },
    recognize: async (_ogg, ctx) => {
      calls.recognize++;
      recognized[ctx.kind]++;
      return o.heard ? o.heard(ctx.kind, recognized[ctx.kind]) : LINES[ctx.kind].join(' ');
    },
    troupeDir: env.troupeDir,
  };
  return { deps, calls };
}

const readAnim = (runDir: string): ShortAnimation => JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8'));
const isErr = (code: string, retryable: boolean) => (e: unknown) => e instanceof StudioError && e.code === code && e.retryable === retryable;

test('обе сценки: кадры по очереди, клипы, речь сошлась, секунды Omni и кадры посчитаны', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env);
  const anim = await animateRun(env.runDir, deps);
  assert.deepEqual(calls.keyframe.map(({ kind, refs }) => ({ kind, refs })), [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual(calls.keyframe[1].last, calls.images[0], 'развязке ушёл не кадр конфликта');
  assert.deepEqual([...calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.omniSeconds, 16);
  assert.equal(anim.keyframes, 2);
  assert.deepEqual(anim.pending, {});
  for (const kind of ['conflict', 'punchline'] as const) {
    const s = anim.skits[kind]!;
    assert.equal(s.fingerprint, `fp-${kind}`);
    assert.equal(s.keyframe, `keyframes/kf-${kind}.png`);
    assert.equal(s.attempts, 1);
    assert.equal(s.cues.length, 2);
    assert.ok(Math.abs(s.durationMs - 8000) < 200, `длина ${s.durationMs}`);
    assert.ok(fs.statSync(path.join(env.runDir, s.clip)).size > 1000);
  }
  assert.deepEqual(readAnim(env.runDir), anim);
});

test('повторный запуск с теми же сценками ничего не генерирует и не распознаёт', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const again = fakes(env);
  const anim = await animateRun(env.runDir, again.deps);
  assert.deepEqual([again.calls.keyframe.length, again.calls.start.length, again.calls.recognize], [0, 0, 0]);
  assert.equal(anim.omniSeconds, 16);
});

test('правка реплик развязки — новый клип с прежнего кадра, конфликт не трогается', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
  const second = fakes(env, { heard: (kind) => (kind === 'punchline' ? lines.join(' ') : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.keyframe, []);
  assert.deepEqual(second.calls.start, ['punchline']);
  assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline-2');
  assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline.png');
  assert.equal(anim.omniSeconds, 24);
});

test('правка реплик конфликта — переснимается только конфликт, с прежнего кадра', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Обои потёрли! Всё моё!', 'Спокойно. Спрошу у юриста.'];
  writeScript(env.runDir, { conflict: plan('conflict', lines, 'fp-conflict-2'), punchline: plan('punchline') });
  const second = fakes(env, { heard: (kind) => (kind === 'conflict' ? lines.join(' ') : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.keyframe, []);
  assert.deepEqual(second.calls.start, ['conflict']);
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline');
  assert.equal(anim.omniSeconds, 24);
});

test('новое место конфликта перерисовывает обе сценки: развязке уходит новый кадр конфликта', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  writeScript(env.runDir, {
    conflict: plan('conflict', LINES.conflict, 'fp-conflict-2', 'kf-conflict-2'),
    punchline: plan('punchline', LINES.punchline, 'fp-punchline-2', 'kf-punchline-2'),
  });
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.keyframe.map(({ kind, refs }) => ({ kind, refs })), [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual(second.calls.keyframe[1].last, second.calls.images[0], 'развязке ушёл старый кадр конфликта');
  assert.deepEqual([...second.calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline-2.png');
  assert.equal(anim.omniSeconds, 32);
});

test('пропал кадр конфликта, а по нему уже снято — не перерисовывается молча', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  fs.rmSync(path.join(env.runDir, 'keyframes', 'kf-conflict.png'));
  writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', LINES.punchline, 'fp-punchline-2', 'kf-punchline-2') });
  const second = fakes(env);
  await assert.rejects(animateRun(env.runDir, second.deps), (e: unknown) => isErr('no_input', false)(e) && /кадра конфликта .* нет/.test((e as Error).message));
  assert.deepEqual([second.calls.keyframe.length, second.calls.start.length], [0, 0]);
});

test('речь не сошлась — пересъёмка без нового кадра; забракованный клип отложен, а не удалён', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, { heard: (kind, call) => (kind === 'conflict' && call === 1 ? 'совсем другое' : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.length, 2);
  assert.equal(anim.omniSeconds, 24);
  const rejected = fs.readdirSync(path.join(env.runDir, 'skits', 'fp-conflict')).filter((f) => f.startsWith('rejected-'));
  assert.equal(rejected.length, 1);
});

test('пустое распознавание — SpeechKit спрашивается ещё раз, клип не переснимается', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, { heard: (kind, call) => (kind === 'conflict' && call === 1 ? '' : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 1);
  assert.deepEqual([...calls.start].sort(), ['conflict', 'punchline']);
});

test('отказ фильтра при запуске — новая попытка с прежним кадром; секунды возвращены', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_rejected', 'omni: отказ фильтра', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.filter((k) => k.kind === 'conflict').length, 1);
  assert.equal(anim.omniSeconds, 16);
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

test('сбой во время ожидания — секунды остаются, следующая попытка снимает новый клип', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    wait: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_failed', 'omni: boom', true);
      return env.clip;
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(calls.start.filter((k) => k === 'conflict').length, 2);
  assert.equal(anim.omniSeconds, 24);
  assert.deepEqual(anim.pending, {});
});

test('не дождались — та же генерация дожидается снова, а не оплачивается заново', { timeout: 120_000 }, async () => {
  const env = setup();
  let waits = 0;
  const { deps, calls } = fakes(env, {
    wait: (kind) => {
      if (kind === 'conflict' && ++waits === 1) throw new StudioError('omni_timeout', 'omni: не дождались', true);
      return env.clip;
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(calls.start.filter((k) => k === 'conflict').length, 1);
  assert.deepEqual(calls.wait.filter((id) => id.startsWith('id-conflict')), ['id-conflict-1', 'id-conflict-1']);
  assert.equal(anim.omniSeconds, 16);
});

test('обрыв посреди ожидания — новый запуск дожидается той же генерации', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    wait: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_auth', 'omni: ключ', false);
      return env.clip;
    },
  });
  await assert.rejects(animateRun(env.runDir, first.deps), (e: unknown) => isErr('google_auth', false)(e) && /сценка 1 \(конфликт\)/.test((e as Error).message));
  assert.equal(readAnim(env.runDir).pending?.conflict?.id, 'id-conflict-1');
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, []);
  assert.deepEqual(second.calls.wait, ['id-conflict-1']);
  assert.equal(anim.omniSeconds, 16);
  assert.deepEqual(anim.pending, {});
});

test('готовую генерацию не забрать (omni_unreadable) — id сохранён, запуск после правки забирает её без оплаты', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    wait: (kind) => {
      if (kind === 'punchline') throw new StudioError('omni_unreadable', 'omni: генерацию не забрать — незнакомая форма', false);
      return env.clip;
    },
  });
  await assert.rejects(animateRun(env.runDir, first.deps), (e: unknown) => isErr('omni_unreadable', false)(e) && /сценка 2 \(развязка\)/.test((e as Error).message));
  assert.equal(readAnim(env.runDir).pending?.punchline?.id, 'id-punchline-1');
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, []);
  assert.deepEqual(second.calls.wait, ['id-punchline-1']);
  assert.equal(anim.omniSeconds, 16);
});

test('битый файл от Omni — пересъёмка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { wait: (kind, n) => (kind === 'conflict' && n === 1 ? Buffer.from('not a video') : env.clip) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
});

test('кадр: пустой ответ — ещё попытка; заблокированный промпт — ни одного запуска Omni', { timeout: 120_000 }, async () => {
  const a = setup();
  const retry = fakes(a, {
    keyframe: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('keyframe', 'keyframe: Nano Banana не вернул картинку (RECITATION)', true);
    },
  });
  const anim = await animateRun(a.runDir, retry.deps);
  assert.equal(retry.calls.keyframe.filter((k) => k.kind === 'conflict').length, 2);
  assert.equal(anim.keyframes, 2);
  const b = setup();
  const blocked = fakes(b, {
    keyframe: (kind) => {
      if (kind === 'conflict') throw new StudioError('keyframe', 'keyframe: Nano Banana заблокировал промпт (PROHIBITED_CONTENT)', false);
    },
  });
  await assert.rejects(animateRun(b.runDir, blocked.deps), (e: unknown) => isErr('keyframe', false)(e) && /сценка 1 \(конфликт\)/.test((e as Error).message));
  assert.deepEqual(blocked.calls.start, []);
});

test('квота — сразу ошибка без повтора и с именем сценки, секунды не списаны, готовая сценка сохранена', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_quota', 'omni: квота', false);
    },
  });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => isErr('google_quota', false)(e) && /^сценка 1 \(конфликт\): omni: квота/.test((e as Error).message));
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
    (e: unknown) => isErr('omni_budget', false)(e) && /предел — 8 с/.test((e as Error).message),
  );
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.ok(anim.skits.conflict);
});

test('предел — не число или испорченный animation.json — ошибка до трат', { timeout: 120_000 }, async () => {
  const env = setup();
  const a = fakes(env);
  await assert.rejects(animateRun(env.runDir, { ...a.deps, maxOmniSeconds: Number.NaN }), isErr('no_input', false));
  fs.writeFileSync(path.join(env.runDir, 'animation.json'), JSON.stringify({ skits: {} }));
  await assert.rejects(animateRun(env.runDir, a.deps), (e: unknown) => isErr('no_input', false)(e) && /счёт секунд Omni неизвестен/.test((e as Error).message));
  assert.deepEqual([a.calls.keyframe.length, a.calls.start.length], [0, 0]);
});

test('три несовпадения речи — сдаётся с причиной и сводкой попыток', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => isErr('speech_mismatch', false)(e) && /после 3 попыток \(speech_mismatch, speech_mismatch, speech_mismatch\)/.test((e as Error).message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 32);
});

test('в сценарии нет сценок или план неполон — ошибка до трат', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify({ hook: 'x', voice: 'v', lines: [], final: { assistantsCount: 18 } }));
  await assert.rejects(animateRun(root, {} as AnimateDeps), isErr('script_invalid', false));
  const env = setup({ conflict: { ...plan('conflict'), fingerprint: '' }, punchline: plan('punchline') });
  await assert.rejects(animateRun(env.runDir, fakes(env).deps), (e: unknown) => isErr('script_invalid', false)(e) && /план сценки неполон/.test((e as Error).message));
});

test('нет портрета героя — ошибка без повтора, с именем сценки и героя', { timeout: 120_000 }, async () => {
  const env = setup();
  fs.rmSync(path.join(env.troupeDir, 'v1', 'kesha.png'));
  await assert.rejects(animateRun(env.runDir, fakes(env).deps), (e: unknown) => isErr('no_input', false)(e) && /сценка 1 \(конфликт\).*kesha/.test((e as Error).message));
});

test('кадр в JPEG сохраняется .jpg и уходит в Omni как image/jpeg', { timeout: 120_000 }, async () => {
  const env = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  const { deps, calls } = fakes(env, { keyframeImage: { data: jpeg, mime: 'image/jpeg' } });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.keyframe, 'keyframes/kf-conflict.jpg');
  assert.deepEqual(calls.startMime, ['image/jpeg', 'image/jpeg']);
});

test('распознавание упало — перезапуск берёт уже оплаченный клип, а не снимает новый', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    heard: (kind) => {
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

test('новая громкость — принятые сценки переобрабатываются без Omni и без распознавания', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = await animateRun(env.runDir, fakes(env).deps);
  assert.match(first.skits.conflict!.post, /^v\d+;lufs=-19;/);
  const second = fakes(env);
  const anim = await animateRun(env.runDir, { ...second.deps, lufs: -23 });
  assert.deepEqual([second.calls.start.length, second.calls.keyframe.length, second.calls.recognize], [0, 0, 0]);
  assert.match(anim.skits.conflict!.post, /;lufs=-23;/);
  assert.match(anim.skits.punchline!.post, /;lufs=-23;/);
  assert.equal(anim.skits.conflict!.heard, first.skits.conflict!.heard);
  assert.equal(anim.omniSeconds, 16);
});

test('переобработка принятого клипа не прошла — запись и clip.mp4 прежние, повтор ничего не тратит', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = await animateRun(env.runDir, fakes(env).deps);
  const clipFile = path.join(env.runDir, first.skits.conflict!.clip);
  const before = fs.readFileSync(clipFile);
  // −70 LUFS — клип становится тишиной, и проверка его бракует.
  for (let run = 0; run < 2; run++) {
    const f = fakes(env);
    await assert.rejects(
      animateRun(env.runDir, { ...f.deps, lufs: -70 }),
      (e: unknown) => isErr('clip_invalid', false)(e) && /принятый клип при новых настройках \(v\d+;lufs=-19;.*→ v\d+;lufs=-70;/.test((e as Error).message),
    );
    assert.deepEqual([f.calls.start.length, f.calls.keyframe.length, f.calls.recognize], [0, 0, 0]);
    const anim = readAnim(env.runDir);
    assert.equal(anim.skits.conflict!.post, first.skits.conflict!.post);
    assert.equal(anim.omniSeconds, 16);
    assert.ok(fs.existsSync(path.join(env.runDir, 'skits', 'fp-conflict', 'raw.mp4')));
    assert.deepEqual(fs.readFileSync(clipFile), before);
  }
  const back = fakes(env);
  await animateRun(env.runDir, back.deps);
  assert.deepEqual([back.calls.start.length, back.calls.recognize], [0, 0]);
});

test('кадр конфликта пропал посреди пересъёмки, а развязка уже нарисована по нему — ошибка, а не тихая перерисовка', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    heard: (kind) => {
      if (kind === 'conflict') throw new StudioError('stt', 'stt: распознать речь не удалось', false);
      return LINES[kind].join(' ');
    },
  });
  await assert.rejects(animateRun(env.runDir, first.deps), (e: unknown) => e instanceof StudioError && e.code === 'stt');
  fs.rmSync(path.join(env.runDir, 'keyframes', 'kf-conflict.png'));
  const second = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, second.deps),
    (e: unknown) => isErr('no_input', false)(e) && /кадра конфликта .* нет, а по нему уже нарисована развязка/.test((e as Error).message),
  );
  assert.deepEqual([second.calls.keyframe.length, second.calls.start.length], [0, 0]);
});

test('принятый клип без raw.mp4 при новых настройках — ошибка, а не тихая пересъёмка', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  fs.rmSync(path.join(env.runDir, 'skits', 'fp-conflict', 'raw.mp4'));
  const second = fakes(env);
  await assert.rejects(
    animateRun(env.runDir, { ...second.deps, lufs: -23 }),
    (e: unknown) => isErr('no_input', false)(e) && /сценка 1 \(конфликт\): .*raw\.mp4 нет/.test((e as Error).message),
  );
  assert.deepEqual(second.calls.start, []);
  assert.equal(readAnim(env.runDir).omniSeconds, 16);
});

test('предел секунд выбран — кадры не рисуются: они тоже стоят денег', { timeout: 120_000 }, async () => {
  const env = setup();
  fs.writeFileSync(path.join(env.runDir, 'animation.json'), JSON.stringify({ omniSeconds: 48, keyframes: 0, skits: {} }));
  const { deps, calls } = fakes(env);
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => isErr('omni_budget', false)(e) && /MAX_OMNI_SECONDS/.test((e as Error).message));
  assert.equal(calls.keyframe.length, 0);
});

test('упали обе сценки — названы обе, код у ошибки без повтора', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, {
    start: () => {
      throw new StudioError('google_auth', 'omni: ключ', false);
    },
  });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => isErr('google_auth', false)(e) && /сценка 1 \(конфликт\): omni: ключ; сценка 2 \(развязка\): omni: ключ/.test((e as Error).message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 0);
});

test('наружу: резерв секунд — до запуска Omni, id генерации — до ожидания, файлы — по мере появления', { timeout: 120_000 }, async () => {
  const env = setup();
  const saved: ShortAnimation[] = [];
  const files: string[] = [];
  const { deps, calls } = fakes(env);
  const startClip = deps.startClip;
  const waitClip = deps.waitClip;
  deps.startClip = async (prompt, image) => {
    // К запуску резерв этой сценки уже снаружи.
    const kind = kindOf(prompt);
    const before = calls.start.filter((k) => k === kind).length;
    assert.ok(saved.at(-1)!.omniSeconds >= 8 * (before + 1), 'резерв не сохранён до запуска');
    return startClip(prompt, image);
  };
  deps.waitClip = async (id) => {
    assert.ok(saved.some((a) => Object.values(a.pending ?? {}).some((p) => p?.id === id)), `id ${id} не сохранён до ожидания`);
    return waitClip(id);
  };
  const anim = await animateRun(env.runDir, {
    ...deps,
    onSave: async (a) => {
      saved.push(a);
    },
    onFile: async (rel) => {
      files.push(rel);
    },
  });
  assert.deepEqual(saved.at(-1), anim);
  assert.deepEqual([...files].sort(), [
    'keyframes/kf-conflict.png', 'keyframes/kf-punchline.png',
    'skits/fp-conflict/clip.mp4', 'skits/fp-conflict/raw.mp4', 'skits/fp-punchline/clip.mp4', 'skits/fp-punchline/raw.mp4',
  ]);
  // Снимки идут по порядку: секунды Omni снаружи не убывают.
  for (let i = 1; i < saved.length; i++) assert.ok(saved[i].omniSeconds >= saved[i - 1].omniSeconds);
});

test('наружу не сохранилось (задание уже не наше) — ни кадра, ни клипа', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env);
  await assert.rejects(
    animateRun(env.runDir, { ...deps, onSave: async () => { throw new StudioError('unknown', 'задание забрал другой процесс', false); } }),
    (e: unknown) => isErr('unknown', false)(e) && /другой процесс/.test((e as Error).message),
  );
  assert.deepEqual([calls.keyframe.length, calls.start.length], [0, 0]);
});

test('файл не выгрузился — повторяемая ошибка; оплаченный клип при повторе берётся из папки', { timeout: 120_000 }, async () => {
  const env = setup();
  let failRaw = true;
  const first = fakes(env);
  await assert.rejects(
    animateRun(env.runDir, {
      ...first.deps,
      onFile: async (rel) => {
        if (rel.endsWith('raw.mp4') && failRaw) throw new Error('MinIO: 503');
      },
    }),
    (e: unknown) => e instanceof StudioError && /не выгрузился в хранилище/.test((e as Error).message),
  );
  failRaw = false;
  const second = fakes(env);
  const anim = await animateRun(env.runDir, { ...second.deps, onFile: async () => {} });
  assert.deepEqual(second.calls.start, []);
  assert.equal(anim.omniSeconds, 16);
});
