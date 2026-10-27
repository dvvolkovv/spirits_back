import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import { renderRun } from './run-render';

const dirs: string[] = [];
test.after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const plan = (kind: string) => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines: [{ hero: 'kesha', text: 'Реплика.' }] },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  keyframeFingerprint: `kf-${kind}`,
  fingerprint: `fp-${kind}`,
});

const clip = (kind: string) => ({
  fingerprint: `fp-${kind}`,
  keyframe: `keyframes/kf-${kind}.png`,
  clip: `skits/fp-${kind}/clip.mp4`,
  durationMs: 8000,
  heard: '',
  cues: [{ line: 0, startMs: 500, endMs: 3000 }],
  attempts: 1,
  post: 'v2',
});

/** Папка ролика со сценками, где клипов на диске нет. */
function runDir(animation?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-render-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'capture.json'), JSON.stringify({ boxes: [{ n: 1, top: 0, height: 100, text: 'a' }], answerShotWidth: 1080 }));
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Залог за обои?',
      voice: 'madirus',
      lines: [{ id: 'q', scene: 'question', text: 'Вопрос.' }, { id: 'a1', scene: 'answer', text: 'Ответ.', box: 1 }, { id: 'f', scene: 'final', text: 'Финал.' }],
      final: { assistantsCount: 18 },
      skits: { conflict: plan('conflict'), punchline: plan('punchline') },
    }),
  );
  if (animation !== undefined) fs.writeFileSync(path.join(dir, 'animation.json'), animation);
  return dir;
}

test('сборка со сценками без готовых клипов останавливается до озвучки и бандла', async () => {
  const cases: Array<[string | undefined, RegExp]> = [
    [undefined, /нет animation\.json/],
    ['{ не json', /animation\.json не читается/],
    [JSON.stringify({ omniSeconds: 16 }), /в animation\.json нет сценок/],
    [JSON.stringify({ omniSeconds: 16, skits: { conflict: clip('conflict'), punchline: clip('punchline') } }), /нет файла клипа сценки conflict \(skits\/fp-conflict\/clip\.mp4\)/],
    // Пустой путь — это сама папка ролика: существует, но не файл.
    [JSON.stringify({ omniSeconds: 16, skits: { conflict: { ...clip('conflict'), clip: '' }, punchline: clip('punchline') } }), /нет файла клипа сценки conflict/],
  ];
  for (const [animation, re] of cases) {
    await assert.rejects(
      renderRun(runDir(animation), { skipTts: true }),
      (e: unknown) => e instanceof StudioError && e.code === 'no_input' && !e.retryable && re.test(e.message),
      String(animation),
    );
  }
});
