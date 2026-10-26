import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ttsKey } from '../tts';
import { renderRun } from './run-render';

/**
 * Сборка ролика со сценками из фикстуры без сети: клипы сценок, картинки и
 * «голос» (синус) делает ffmpeg, озвучка берётся из кеша. Папка не удаляется —
 * по ней смотрят кадры.
 */
test('рендер фикстуры со сценками: 1080×1920, 25–45 с, звук по всей длине', { timeout: 15 * 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skit-fixture-'));
  console.log(`fixture: ${dir}`);
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'color=c=0xedfaed:s=1080x1920', '-frames:v', '1', path.join(dir, 'question.png'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=1080x5400', '-frames:v', '1', path.join(dir, 'answer.png'));
  // Паузы на краях клипов — как у Omni: у конфликта 2,3 с тишины в конце, у развязки — в
  // начале. Стыки «конфликт → вопрос» и «ответ → развязка» дают 2,3 и ≈2,6 с тишины: их
  // пропускает только SKIT_LIMITS (у обычного ролика предел 2 с).
  const voice = { conflict: 'sine=frequency=220:duration=5.7,apad', punchline: 'sine=frequency=220:duration=5.7,adelay=2300,apad' };
  for (const [kind, color] of [['conflict', 'orange'], ['punchline', 'purple']] as const) {
    const d = path.join(dir, 'skits', `fx-${kind}`);
    fs.mkdirSync(d, { recursive: true });
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280:d=8`, '-f', 'lavfi', '-i', voice[kind], '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(d, 'clip.mp4'));
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280`, '-frames:v', '1', path.join(d, 'keyframe.png'));
  }

  const lines = [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Жилец спросил про залог.', ms: 5000 },
    { id: 'a1', scene: 'answer', text: 'Квартиру возвращают с учётом нормального износа.', ms: 6000, box: 1 },
    { id: 'a2', scene: 'answer', text: 'Ущерб хозяйка должна доказать.', ms: 6000, box: 2 },
    { id: 'f', scene: 'final', text: 'Linkeon. Ссылка — в описании.', ms: 4000 },
  ] as const;
  fs.mkdirSync(path.join(dir, 'voice'));
  const manifest: Record<string, { key: string; durationMs: number }> = {};
  for (const l of lines) {
    ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${l.ms / 1000}`, '-ac', '1', '-ar', '44100', path.join(dir, 'voice', `${l.id}.mp3`));
    manifest[l.id] = { key: ttsKey({ text: l.text, voice: 'madirus', speed: 1 }), durationMs: l.ms };
  }
  fs.writeFileSync(path.join(dir, 'voice', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, 'capture.json'),
    JSON.stringify({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Хозяйка не отдаёт залог', followups: [] },
      cabinetUrl: 'fixture',
      capturedAt: new Date(0).toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: 1080,
      answerShotHeight: 5400,
      answerText: 'x'.repeat(500),
      turns: 1,
      boxes: [{ n: 1, top: 900, height: 300, text: 'a' }, { n: 2, top: 2400, height: 300, text: 'b' }],
      paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }],
    }),
  );
  const plan = (kind: string, texts: string[]) => ({
    skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines: texts.map((text) => ({ hero: 'kesha', text })) },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: 'k',
    videoPrompt: 'v',
    keyframeFingerprint: `fx-kf-${kind}`,
    fingerprint: `fx-${kind}`,
  });
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Хозяйка оставит весь залог?',
      voice: 'madirus',
      speed: 1,
      lines: lines.map((l) => ({ id: l.id, scene: l.scene, text: l.text, ...('box' in l ? { box: l.box } : {}) })),
      final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
      skits: { conflict: plan('conflict', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: plan('punchline', ['Это износ.', 'Га-га… ладно.']) },
    }),
  );
  const clip = (kind: string) => ({
    fingerprint: `fx-${kind}`,
    keyframe: `skits/fx-${kind}/keyframe.png`,
    clip: `skits/fx-${kind}/clip.mp4`,
    durationMs: 8000,
    heard: '',
    attempts: 1,
    post: 'lufs=-19',
    cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }],
  });
  fs.writeFileSync(path.join(dir, 'animation.json'), JSON.stringify({ omniSeconds: 16, skits: { conflict: clip('conflict'), punchline: clip('punchline') } }));

  const r = await renderRun(dir, { skipTts: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.durationSec >= 25 && r.durationSec <= 45, `длина ${r.durationSec}`);
  assert.ok(fs.statSync(r.cover).size > 10_000, 'обложка подозрительно мала');
  // Обложка — сценка 1 с надписью-зацепкой, без субтитров: на месте плашки субтитра — сам клип (оранжевый).
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', r.cover, '-vf', 'format=rgb24,crop=1:1:120:1270', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(px[0] > 200 && px[2] < 80, `на обложке субтитр реплики: пиксель ${[...px].join(',')}`);
});
