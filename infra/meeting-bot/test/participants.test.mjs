import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingBot } from '../src/bot.mjs';

/**
 * Сверка состава.
 *
 * Единственное место сервиса, где состояние живёт между событиями, — и именно
 * оно сломалось на живой встрече 15.09.2026: потерянный вебхук «пришёл» увёл
 * состав у бэкенда в ноль до конца встречи. Поток разниц по ненадёжному каналу
 * обязан уметь сходиться заново, и проверить это можно только тестом: в
 * браузере такую потерю по заказу не воспроизвести.
 *
 * Бота заводим настоящего — конструктор ничего не запускает, — а наружу
 * подменяем ровно одну функцию: отправку события.
 */
function botWith(log = { info() {}, warn() {} }) {
  const bot = new MeetingBot({ id: 'тест', meetingUrl: 'x', displayName: 'Бот', platform: 'telemost', log });
  const sent = [];
  let deliver = true;
  bot.participantEvent = async (index, kind) => {
    if (!deliver) return false;
    sent.push(`${kind}:${index}`);
    return true;
  };
  return { bot, sent, fail: () => { deliver = false; }, heal: () => { deliver = true; } };
}

test('рост состава отдаётся событиями входа по одному', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(3);
  assert.deepEqual(sent, ['join:1', 'join:2', 'join:3']);
  assert.equal(bot.humans, 3);
});

test('повторное сообщение с тем же составом ничего не шлёт', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(2);
  await bot.syncParticipants(2);
  assert.deepEqual(sent, ['join:1', 'join:2']);
});

test('уход людей отдаётся событиями выхода', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(3);
  sent.length = 0;
  await bot.syncParticipants(1);
  assert.deepEqual(sent, ['leave:3', 'leave:2']);
  assert.equal(bot.humans, 1);
});

test('не дошедшее событие не двигает счётчик, и следующий тик всё догоняет', async () => {
  const { bot, sent, fail, heal } = botWith();
  fail();
  await bot.syncParticipants(2);
  assert.deepEqual(sent, [], 'при обрыве наружу не ушло ничего');
  assert.equal(bot.humans, 0, 'счётчик остался на подтверждённом значении');

  heal();
  await bot.syncParticipants(2);
  assert.deepEqual(sent, ['join:1', 'join:2'], 'потерянное доехало на следующем тике');
  assert.equal(bot.humans, 2);
});

test('обрыв посреди серии оставляет счётчик на последнем подтверждённом', async () => {
  const { bot, sent, fail, heal } = botWith();
  await bot.syncParticipants(1);
  fail();
  await bot.syncParticipants(4);
  assert.equal(bot.humans, 1);

  heal();
  await bot.syncParticipants(4);
  assert.deepEqual(sent, ['join:1', 'join:2', 'join:3', 'join:4']);
});
