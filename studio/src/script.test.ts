import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from './script';
import type { Script, SkitPlan } from './types';

const capture = {
  boxes: [
    { n: 1, top: 0, height: 10, text: 'a' },
    { n: 2, top: 20, height: 10, text: 'b' },
  ],
};

const good = (): Script => ({
  hook: 'Юрист нашёл три ловушки',
  voice: 'madirus',
  lines: [
    { id: 'h', scene: 'hook', text: 'Юрист нашёл три ловушки' },
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая ловушка.', box: 1 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.', voice: 'alena' },
  ],
  final: { assistantsCount: 18 },
});

test('корректный сценарий проходит без замечаний', () => {
  assert.deepEqual(validateScript(good(), capture), []);
});

test('реплика ответа без абзаца и с несуществующим абзацем', () => {
  const s = good();
  s.lines[2] = { id: 'a1', scene: 'answer', text: 'x' };
  assert.match(validateScript(s, capture).join(';'), /a1 не привязана к абзацу/);
  s.lines[2] = { id: 'a1', scene: 'answer', text: 'x', box: 7 };
  assert.match(validateScript(s, capture).join(';'), /абзац 7/);
});

test('абзац у реплики не из ответа — ошибка', () => {
  const s = good();
  s.lines[1] = { ...s.lines[1], box: 1 };
  assert.match(validateScript(s, capture).join(';'), /q сцены question не должна ссылаться/);
});

test('зацепка длиннее восьми слов и расхождение с репликой hook', () => {
  const s = good();
  s.hook = 'раз два три четыре пять шесть семь восемь девять';
  const p = validateScript(s, capture).join(';');
  assert.match(p, /длиннее 8 слов/);
  assert.match(p, /совпадать с зацепкой/);
});

test('слова зацепки считаются как в API (short-rules.ts): тире — не слово', () => {
  // «Хозяин может оставить залог себе — и будет прав» — 8 слов по правилу
  // API (/[\p{L}\p{N}]/u на токен, тире без буквы не считается), студия без
  // этой правки насчитала бы 9 токенов и отвергла бы ту же зацепку.
  const hook = 'Хозяин может оставить залог себе — и будет прав';
  const s = good();
  s.hook = hook;
  s.lines[0] = { ...s.lines[0], text: hook };
  assert.deepEqual(validateScript(s, capture), []);
});

test('повтор id и пустая реплика', () => {
  const s = good();
  s.lines.push({ id: 'f', scene: 'final', text: ' ' });
  const p = validateScript(s, capture).join(';');
  assert.match(p, /повтор id реплики f/);
  assert.match(p, /реплика f пустая/);
});

test('зацепка опирается на снятый абзац', () => {
  assert.deepEqual(validateScript({ ...good(), hookBox: 2 }, capture), []);
  assert.match(validateScript({ ...good(), hookBox: 7 }, capture).join(';'), /зацепка опирается на абзац 7/);
});

test('в финале нужно число ассистентов', () => {
  assert.match(validateScript({ ...good(), final: { assistantsCount: 0 } }, capture).join(';'), /числа ассистентов/);
});

const skitPlan = (lines: Array<{ hero: string; text: string; box?: number }>): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  keyframeFingerprint: 'kf',
  fingerprint: 'f',
});

const skitScript = (): Script => {
  const s = good();
  return {
    ...s,
    lines: s.lines.filter((l) => l.scene !== 'hook'),
    skits: { conflict: skitPlan([{ hero: 'galina', text: 'Залог мой!' }]), punchline: skitPlan([{ hero: 'kesha', text: 'Это износ.', box: 1 }]) },
  };
};

test('ролик со сценками: корректный проходит', () => {
  assert.deepEqual(validateScript(skitScript(), capture), []);
});

test('ролик со сценками: реплика hook лишняя', () => {
  const s = skitScript();
  s.lines.unshift({ id: 'h', scene: 'hook', text: s.hook });
  assert.ok(validateScript(s, capture).some((p) => /реплики hook быть не должно/.test(p)));
});

test('ролик со сценками: реплика hook с другим текстом — одна проблема, а не две', () => {
  const s = skitScript();
  s.lines.unshift({ id: 'h', scene: 'hook', text: 'Совсем другая зацепка' });
  const problems = validateScript(s, capture);
  assert.equal(problems.filter((p) => /hook/.test(p)).length, 1);
});

test('ролик со сценками: нет самих сценок — названы обе', () => {
  const s = skitScript();
  s.skits = {} as Script['skits'];
  const problems = validateScript(s, capture);
  assert.ok(problems.includes('нет сценки conflict'));
  assert.ok(problems.includes('нет сценки punchline'));
});

test('ролик со сценками: сценка без реплик и реплика с несуществующим абзацем', () => {
  const s = skitScript();
  s.skits = { conflict: skitPlan([]), punchline: skitPlan([{ hero: 'kesha', text: 'Износ.', box: 7 }]) };
  const problems = validateScript(s, capture);
  assert.ok(problems.includes('в сценке conflict нет реплик'));
  assert.ok(problems.some((p) => /сценки punchline ссылается на абзац 7/.test(p)));
});

test('ролик со сценками: без отпечатков студия не поймёт, что переснимать', () => {
  const s = skitScript();
  s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: '' } };
  assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
  s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: 'f', keyframeFingerprint: '' } };
  assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
});
