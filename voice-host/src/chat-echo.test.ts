import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { OwnChatEcho } from './chat-echo.js';

const NAME = 'Роман · ассистент пользователя';

describe('OwnChatEcho', () => {
  test('сообщение от себя опознаётся по автору', () => {
    const echo = new OwnChatEcho(NAME);
    assert.equal(echo.isOwn(NAME, 'что угодно'), true);
  });

  test('чужое сообщение с тем же текстом не считается своим', () => {
    // Иначе ассистент проглотил бы реплику участника, повторившего его слова.
    const echo = new OwnChatEcho(NAME);
    assert.equal(echo.isOwn('Владимир', 'что угодно'), false);
  });

  test('эхо опознаётся по тексту, когда имя разошлось', () => {
    // Teams обрезает длинные имена ботов — сверка имён там не сработает.
    const echo = new OwnChatEcho(NAME);
    echo.note('«Ночь в Лиссабоне» — Эрих Мария Ремарк');
    assert.equal(echo.isOwn('Роман · ассистент польз', '«Ночь в Лиссабоне» — Эрих Мария Ремарк'), true);
  });

  test('разница в пробелах эхо не прячет', () => {
    const echo = new OwnChatEcho('');
    echo.note('держите  ссылку\nhttps://example.com');
    assert.equal(echo.isOwn('кто-то', 'держите ссылку https://example.com'), true);
  });

  test('совпавшее эхо забывается — повтор человеком уже его реплика', () => {
    // Он вправе процитировать ассистента, и на цитату надо отвечать.
    const echo = new OwnChatEcho('');
    echo.note('держите ссылку');
    assert.equal(echo.isOwn('кто-то', 'держите ссылку'), true);
    assert.equal(echo.isOwn('кто-то', 'держите ссылку'), false);
  });

  test('через две минуты текст перестаёт считаться своим', () => {
    // Эхо приходит за секунды; вечная память проглатывала бы чужие сообщения.
    const echo = new OwnChatEcho('');
    echo.note('держите ссылку', 1_000);
    assert.equal(echo.isOwn('кто-то', 'держите ссылку', 1_000 + 130_000), false);
  });

  test('без имени сверка идёт только по тексту', () => {
    const echo = new OwnChatEcho();
    assert.equal(echo.isOwn('Роман · ассистент пользователя', 'привет'), false);
  });

  test('пустой текст не запоминается и не ловится', () => {
    const echo = new OwnChatEcho('');
    echo.note('   ');
    assert.equal(echo.isOwn('кто-то', '   '), false);
  });

  test('помним ограниченно — двадцать первое вытесняет первое', () => {
    const echo = new OwnChatEcho('');
    for (let i = 0; i < 21; i++) echo.note(`сообщение ${i}`);
    assert.equal(echo.isOwn('кто-то', 'сообщение 0'), false);
    assert.equal(echo.isOwn('кто-то', 'сообщение 20'), true);
  });
});
