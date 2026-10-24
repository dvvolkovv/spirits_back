import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerProblems, isCounterQuestion } from './answer';

test('короткий ответ с вопросом в конце — встречный вопрос', () => {
  assert.equal(isCounterQuestion('Уточните, в каком городе квартира?', 400), true);
  assert.equal(isCounterQuestion('Короткий ответ без вопроса.', 400), false);
  assert.equal(isCounterQuestion(`${'Подробный разбор. '.repeat(30)}Остались вопросы?`, 400), false);
});

test('«Временный сбой» и короткий ответ не снимаются', () => {
  const p = answerProblems('Временный сбой, попробуйте позже', 400);
  assert.match(p.join(';'), /Временный сбой/);
  assert.match(p.join(';'), /меньше порога 400/);
});

test('подробный ответ годится', () => {
  assert.deepEqual(answerProblems('Пункт. '.repeat(80), 400), []);
});
