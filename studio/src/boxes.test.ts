import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toAnswerLayout, toImageBoxes } from './boxes';

test('переводит в пиксели картинки и нумерует сверху вниз', () => {
  const boxes = toImageBoxes(
    [
      { top: 300.4, height: 40, text: 'второй' },
      { top: 120, height: 60.2, text: 'первый' },
    ],
    3,
  );
  assert.deepEqual(boxes, [
    { n: 1, top: 360, height: 181, text: 'первый' },
    { n: 2, top: 901, height: 120, text: 'второй' },
  ]);
});

test('пустые и крошечные блоки отбрасываются', () => {
  const boxes = toImageBoxes(
    [
      { top: 10, height: 4, text: 'мелочь' },
      { top: 20, height: 30, text: '   ' },
      { top: 60, height: 30, text: 'текст' },
    ],
    3,
  );
  assert.deepEqual(boxes.map((b) => [b.n, b.text]), [[1, 'текст']]);
});

test('текст схлопывается и обрезается до 120 символов', () => {
  const [b] = toImageBoxes([{ top: 0, height: 20, text: `a\n\n  b ${'x'.repeat(200)}` }], 1);
  assert.equal(b.text.length, 120);
  assert.ok(b.text.startsWith('a b x'));
});

test('блок за низом картинки не попадает в список', () => {
  const boxes = toImageBoxes(
    [
      { top: 100, height: 50, text: 'есть' },
      { top: 990, height: 50, text: 'за краем' },
    ],
    1,
    1000,
  );
  assert.deepEqual(boxes.map((b) => b.text), ['есть']);
});

test('полный текст абзацев — с теми же номерами, без обрезки до 120', () => {
  const long = `начало ${'x'.repeat(300)}`;
  const { boxes, paragraphs } = toAnswerLayout(
    [
      { top: 300, height: 40, text: 'второй' },
      { top: 100, height: 40, text: long },
    ],
    1,
  );
  assert.deepEqual(boxes.map((b) => b.n), [1, 2]);
  assert.deepEqual(paragraphs.map((p) => p.n), [1, 2]);
  assert.equal(paragraphs[0].text, long);
  assert.equal(boxes[0].text.length, 120);
  assert.equal(paragraphs[1].text, 'второй');
});
