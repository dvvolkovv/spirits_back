import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PendingAnswers } from './pending.js';

test('свободному Роману реплика отдаётся сразу', () => {
  const p = new PendingAnswers();
  p.push('ответ Алексея');
  assert.equal(p.take(), 'ответ Алексея');
});

test('пока Роман занят, реплика ждёт', () => {
  const p = new PendingAnswers();
  p.setBusy(true);
  p.push('ответ Алексея');
  assert.equal(p.take(), null);
  assert.equal(p.size, 1);
});

test('три ответа уходят ОДНОЙ вставкой, а не тремя', () => {
  // Ради этого класс и переписан: три подряд generateReply отбивались
  // OpenAI как conversation_already_has_active_response, и из трёх ответов
  // звучал один. Живой звонок 26.08.2026.
  const p = new PendingAnswers();
  p.setBusy(true);
  p.push('раз');
  p.push('два');
  p.push('три');
  p.setBusy(false);

  const merged = p.take();
  assert.equal(merged, 'раз\n\nдва\n\nтри');
  // Второй вызов ничего не отдаёт: очередь пуста, и мы уже заняты.
  assert.equal(p.take(), null);
});

test('take() сам помечает занятость — состояние сессии приходит позже', () => {
  // Между generateReply и сменой состояния на 'thinking' проходят
  // миллисекунды, и следующий ответ вполне успевает прийти в этот зазор.
  const p = new PendingAnswers();
  p.push('первый');
  assert.equal(p.take(), 'первый');
  assert.equal(p.isBusy, true);

  p.push('второй');
  assert.equal(p.take(), null, 'второй не должен уйти, пока первый в работе');
});

test('пустая очередь ничего не отдаёт и не занимает Романа', () => {
  const p = new PendingAnswers();
  assert.equal(p.take(), null);
  assert.equal(p.isBusy, false);
});

test('накопленное за время занятости не теряется', () => {
  const p = new PendingAnswers();
  p.push('первый');
  p.take(); // ушёл, Роман занят

  p.push('второй');
  p.push('третий');
  assert.equal(p.take(), null);

  p.setBusy(false); // договорил
  assert.equal(p.take(), 'второй\n\nтретий');
});
