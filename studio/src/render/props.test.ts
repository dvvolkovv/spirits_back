import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProps, buildSkitProps } from './props';
import type { CaptureResult, Script, ShortAnimation, SkitPlan } from '../types';
import { StudioError } from '../errors';

const capture: CaptureResult = {
  scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Проверьте договор', followups: [] },
  cabinetUrl: 'https://test.linkeon.io',
  capturedAt: '2026-10-24T00:00:00.000Z',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotWidth: 1080,
  answerShotHeight: 5400,
  answerText: 'ответ',
  turns: 1,
  boxes: [
    { n: 1, top: 900, height: 300, text: 'a' },
    { n: 2, top: 2400, height: 300, text: 'b' },
  ],
  paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }],
};

const script: Script = {
  hook: 'Юрист нашёл две ловушки',
  voice: 'madirus',
  lines: [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл две ловушки' },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.', voice: 'alena' },
  ],
  final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' },
};

const ms: Record<string, number> = { h: 1500, q: 4000, a1: 12000, a2: 12000, f: 4000 };

test('пропсы: пути озвучки относительно папки съёмки, финал — из сценария', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  const p = buildProps(capture, script, voiced, '/run');
  assert.equal(p.timeline.segments[0].audio, 'voice/h.mp3');
  assert.equal(p.answerShotHeight, 5400);
  assert.deepEqual(p.final, { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет специалиста' });
  assert.ok(p.timeline.totalFrames >= 900, `ролик ${p.timeline.totalFrames} кадров — короче 30 с`);
});

test('реплика без озвучки — ошибка', () => {
  const voiced = script.lines.slice(1).map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(() => buildProps(capture, script, voiced, '/run'), /нет озвучки реплики h/);
});

test('снимок ответа не той ширины — frame_size без повтора', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.throws(
    () => buildProps({ ...capture, answerShotWidth: 720 }, script, voiced, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'frame_size' && !e.retryable,
  );
});

test('подпись реального кейса доходит до композиции', () => {
  const voiced = script.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: ms[l.id] }));
  assert.equal(buildProps(capture, { ...script, badge: 'Реальная история' }, voiced, '/run').badge, 'Реальная история');
});

const skitPlan = (fingerprint: string, lines: string[]): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines: lines.map((text) => ({ hero: 'kesha', text })) },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  keyframeFingerprint: `kf-${fingerprint}`,
  fingerprint,
});

const skitScript: Script = {
  hook: 'Хозяйка оставит залог?',
  voice: 'madirus',
  lines: [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.' },
  ],
  final: { assistantsCount: 18 },
  skits: { conflict: skitPlan('fc', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: skitPlan('fp', ['Это износ.']) },
};

const skitMs: Record<string, number> = { q: 4000, a1: 8000, a2: 8000, f: 4000 };
const skitVoiced = skitScript.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: skitMs[l.id] }));

const animation: ShortAnimation = {
  omniSeconds: 16,
  skits: {
    conflict: { fingerprint: 'fc', keyframe: 'keyframes/kf-fc.png', clip: 'skits/fc/clip.mp4', durationMs: 8000, heard: '', attempts: 1, post: 'lufs=-19',
      cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }] },
    punchline: { fingerprint: 'fp', keyframe: 'keyframes/kf-fp.png', clip: 'skits/fp/clip.mp4', durationMs: 8000, heard: '', attempts: 1, post: 'lufs=-19',
      cues: [{ line: 0, startMs: 500, endMs: 3000 }] },
  },
};

test('пропсы со сценками: клипы и субтитры реплик на своих кадрах', () => {
  const p = buildSkitProps(capture, skitScript, skitVoiced, animation, '/run');
  assert.equal(p.clips.conflict.video, 'skits/fc/clip.mp4');
  assert.equal(p.clips.punchline.video, 'skits/fp/clip.mp4');
  assert.deepEqual(p.clips.conflict.cues, [
    { key: 'conflict-0-0', text: 'Обои потёрли! Залог мой!', from: 15, duration: 90 },
    { key: 'conflict-1-0', text: 'Спокойно.', from: 120, duration: 90 },
  ]);
  assert.equal(p.timeline.scenes.punchline.from, 864);
  assert.deepEqual(p.clips.punchline.cues[0], { key: 'punchline-0-0', text: 'Это износ.', from: 879, duration: 75 });
  assert.equal(p.hook, 'Хозяйка оставит залог?');
  assert.equal(p.timeline.segments[0].audio, 'voice/q.mp3');
});

test('клип снят под другую сценку — no_input без повтора', () => {
  const stale: ShortAnimation = { ...animation, skits: { ...animation.skits, punchline: { ...animation.skits.punchline!, fingerprint: 'old' } } };
  assert.throws(
    () => buildSkitProps(capture, skitScript, skitVoiced, stale, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'no_input' && !e.retryable && /punchline/.test(e.message),
  );
});

test('субтитры реплик сценки не наезжают друг на друга и не выходят за сценку', () => {
  const conflict = { ...animation.skits.conflict!, cues: [{ line: 0, startMs: 1017, endMs: 2035 }, { line: 1, startMs: 2035, endMs: 9000 }] };
  const p = buildSkitProps(capture, skitScript, skitVoiced, { ...animation, skits: { ...animation.skits, conflict } }, '/run');
  const cues = p.clips.conflict.cues;
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].from >= cues[i - 1].from + cues[i - 1].duration, `субтитр ${i} начинается внутри предыдущего`);
  const last = cues[cues.length - 1];
  assert.ok(last.from + last.duration <= p.timeline.scenes.conflict.duration, 'субтитр вылез за сценку конфликта');
  // Пересечение во времени (правка руками) подрезается, а не даёт два субтитра в одном кадре.
  const overlap = { ...animation.skits.conflict!, cues: [{ line: 0, startMs: 2000, endMs: 4000 }, { line: 1, startMs: 3000, endMs: 6000 }] };
  const o = buildSkitProps(capture, skitScript, skitVoiced, { ...animation, skits: { ...animation.skits, conflict: overlap } }, '/run').clips.conflict.cues;
  assert.deepEqual(o.map((c) => [c.key, c.from, c.duration]), [['conflict-0-0', 60, 60], ['conflict-1-0', 120, 60]]);
});

test('время реплик сценки не сходится со сценарием — no_input, а не ролик без субтитров', () => {
  for (const cues of [[], [{ line: 0, startMs: 500, endMs: 3500 }], [{ line: 0, startMs: 500, endMs: 3500 }, { line: 5, startMs: 4000, endMs: 7000 }], [{ line: 0, startMs: Number.NaN, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }]]) {
    const conflict = { ...animation.skits.conflict!, cues };
    assert.throws(
      () => buildSkitProps(capture, skitScript, skitVoiced, { ...animation, skits: { ...animation.skits, conflict } }, '/run'),
      (e: unknown) => e instanceof StudioError && e.code === 'no_input' && !e.retryable && /время реплик сценки conflict/.test(e.message),
      JSON.stringify(cues),
    );
  }
});

test('клипы не по 8 с: сцены и субтитры идут за настоящей длиной клипа', () => {
  const skits = { conflict: { ...animation.skits.conflict!, durationMs: 7000 }, punchline: { ...animation.skits.punchline!, durationMs: 9400 } };
  const p = buildSkitProps(capture, skitScript, skitVoiced, { ...animation, skits }, '/run');
  assert.deepEqual(p.timeline.scenes.conflict, { from: 0, duration: 210 });
  assert.equal(p.timeline.scenes.question.from, 210);
  assert.equal(p.timeline.scenes.punchline.duration, 282);
  assert.equal(p.timeline.scenes.final.from, p.timeline.scenes.punchline.from + 282);
  assert.deepEqual(p.clips.conflict.cues[1], { key: 'conflict-1-0', text: 'Спокойно.', from: 120, duration: 90 });
});

test('длинная реплика сценки — два куска субтитров со своими ключами', () => {
  const long = 'Обои потёрли, плитку поцарапали, ковёр испортили — залог мой!';
  const script: Script = { ...skitScript, skits: { ...skitScript.skits!, conflict: skitPlan('fc', [long, 'Спокойно.']) } };
  const cues = buildSkitProps(capture, script, skitVoiced, animation, '/run').clips.conflict.cues;
  assert.deepEqual(cues.map((c) => c.key), ['conflict-0-0', 'conflict-0-1', 'conflict-1-0']);
  assert.equal(cues.slice(0, 2).map((c) => c.text).join(' '), long);
  assert.equal(cues[1].from + cues[1].duration, 105);
});

test('в сценарии нет сценок — script_invalid', () => {
  assert.throws(
    () => buildSkitProps(capture, { ...skitScript, skits: undefined }, skitVoiced, animation, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid' && !e.retryable,
  );
});
