import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captionCues, splitCaption } from './captions';

test('короткая реплика — один кусок', () => {
  assert.deepEqual(splitCaption('Я Алексей, юрист.'), ['Я Алексей, юрист.']);
});

test('длинная реплика режется по словам и не теряет текст', () => {
  const text = 'Первая ловушка — залог без срока возврата: хозяин может тянуть с деньгами месяцами.';
  const chunks = splitCaption(text, 42);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 42, `кусок длиннее 42: «${c}»`);
  assert.equal(chunks.join(' '), text);
});

test('слово длиннее предела — отдельным куском целиком', () => {
  assert.deepEqual(splitCaption('а сверхдлинноесловобезпробелов б', 10), ['а', 'сверхдлинноесловобезпробелов', 'б']);
});

test('кадры делятся пропорционально длине и покрывают реплику без дыр', () => {
  assert.deepEqual(captionCues(['ааааа', 'ааааааааааааааа'], 100, 80), [
    { text: 'ааааа', from: 100, duration: 20 },
    { text: 'ааааааааааааааа', from: 120, duration: 60 },
  ]);
});

test('кадров меньше, чем кусков, — вся реплика одним куском', () => {
  assert.deepEqual(captionCues(['а', 'б', 'в'], 0, 2), [{ text: 'а б в', from: 0, duration: 2 }]);
});
