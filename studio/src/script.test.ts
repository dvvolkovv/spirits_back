import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateScript } from './script';
import type { Script } from './types';

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
