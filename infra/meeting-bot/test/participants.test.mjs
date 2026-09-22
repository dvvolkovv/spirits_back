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
function botWith(platform = 'telemost') {
  const bot = new MeetingBot({
    id: 'тест',
    meetingUrl: 'x',
    displayName: 'Бот',
    platform,
    log: { info() {}, warn() {} },
  });
  const sent = [];
  let deliver = true;
  bot.participantEvent = async (uuid, name, kind) => {
    if (!deliver) return false;
    sent.push(`${kind}:${name}`);
    return true;
  };
  return { bot, sent, fail: () => { deliver = false; }, heal: () => { deliver = true; } };
}

const people = (...names) => names.map((name, i) => ({ uuid: `u${i + 1}`, name }));

test('пришедшие отдаются событиями входа с именами', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(people('Аня', 'Борис'));
  assert.deepEqual(sent, ['join:Аня', 'join:Борис']);
  assert.equal(bot.people.size, 2);
});

test('повторный тот же состав ничего не шлёт', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(people('Аня'));
  await bot.syncParticipants(people('Аня'));
  assert.deepEqual(sent, ['join:Аня']);
});

test('исчезнувший из списка отдаётся событием выхода', async () => {
  const { bot, sent } = botWith();
  await bot.syncParticipants(people('Аня', 'Борис'));
  sent.length = 0;
  await bot.syncParticipants([{ uuid: 'u1', name: 'Аня' }]);
  assert.deepEqual(sent, ['leave:Борис']);
  assert.equal(bot.people.size, 1);
});

test('не дошедшее событие не двигает состав, и следующий тик всё догоняет', async () => {
  const { bot, sent, fail, heal } = botWith();
  fail();
  await bot.syncParticipants(people('Аня', 'Борис'));
  assert.deepEqual(sent, [], 'при обрыве наружу не ушло ничего');
  assert.equal(bot.people.size, 0, 'состав остался на подтверждённом значении');

  heal();
  await bot.syncParticipants(people('Аня', 'Борис'));
  assert.deepEqual(sent, ['join:Аня', 'join:Борис'], 'потерянное доехало на следующем тике');
});

test('обрыв посреди серии оставляет состав на последнем подтверждённом', async () => {
  const { bot, sent, fail, heal } = botWith();
  await bot.syncParticipants(people('Аня'));
  fail();
  await bot.syncParticipants(people('Аня', 'Борис', 'Вера'));
  assert.equal(bot.people.size, 1);

  heal();
  await bot.syncParticipants(people('Аня', 'Борис', 'Вера'));
  assert.deepEqual(sent, ['join:Аня', 'join:Борис', 'join:Вера']);
});

test('счётчик Телемоста превращается в безличных участников', async () => {
  // У Телемоста имён в разметке нет вовсе — есть только число на кнопке.
  // Выдумывать имена нельзя: на выдуманных не работает ни гейт по имени, ни
  // правила выхода. Поэтому безличные подписи, но состав честный.
  const { bot, sent } = botWith();
  await bot.onPageEvent('participants', { humans: 2 });
  assert.deepEqual(sent, ['join:Участник 1', 'join:Участник 2']);
});

test('имена Zoom доходят как есть', async () => {
  const { bot, sent } = botWith('zoom');
  await bot.onPageEvent('participants', { people: [{ uuid: '16778240', name: 'Дмитрий' }] });
  assert.deepEqual(sent, ['join:Дмитрий']);
});

test('одно сообщение чата отдаётся один раз, даже если пришло из двух кадров', async () => {
  // Сценарий работает во всех кадрах страницы, а новый Телемост держит ленту
  // сразу в двух — в боковой панели и в самой встрече. Идентификаторы у кадров
  // свои, поэтому сверяем по автору и тексту.
  const { bot } = botWith();
  const sent = [];
  bot.webhookUrl = '';   // вебхуки наружу не шлём, важен сам факт обработки
  bot.log = { info: (m) => sent.push(String(m)), warn() {} };

  await bot.onPageEvent('chat', { id: 'a1', text: 'Привет Роман!', author: 'Владимир К.' });
  await bot.onPageEvent('chat', { id: 'b2', text: 'Привет Роман!', author: 'Владимир К.' });
  assert.equal(sent.filter((l) => l.includes('чат:')).length, 1);

  // Через четверть минуты то же сообщение — уже новая реплика человека.
  bot.chatSeen.set('Владимир К.::Привет Роман!', Date.now() - 20_000);
  await bot.onPageEvent('chat', { id: 'c3', text: 'Привет Роман!', author: 'Владимир К.' });
  assert.equal(sent.filter((l) => l.includes('чат:')).length, 2);
});
