import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addressedByName, NameGate } from './name-gate.js';

describe('addressedByName', () => {
  test('ловит имя в именительном падеже', () => {
    assert.equal(addressedByName('Роман, что скажешь?', 'Роман'), true);
  });

  test('ловит косвенные падежи', () => {
    for (const s of ['спросим Романа', 'передай Роману', 'с Романом', 'о Романе']) {
      assert.equal(addressedByName(s, 'Роман'), true, s);
    }
  });

  test('не срабатывает на слове, которое лишь начинается с имени', () => {
    assert.equal(addressedByName('это романтика какая-то', 'Роман'), false);
    assert.equal(addressedByName('он романист', 'Роман'), false);
  });

  test('работает с женскими именами на гласную', () => {
    for (const s of ['Анна, посчитай', 'спросите Анну', 'у Анны', 'к Анне', 'с Анной']) {
      assert.equal(addressedByName(s, 'Анна'), true, s);
    }
  });

  test('не путает Анну с аннотацией', () => {
    assert.equal(addressedByName('дай аннотацию', 'Анна'), false);
  });

  test('не зависит от регистра и от ё', () => {
    assert.equal(addressedByName('РОМАН!', 'Роман'), true);
    assert.equal(addressedByName('алёна тут?', 'Алена'), true);
  });

  test('пустой текст — не обращение', () => {
    assert.equal(addressedByName('', 'Роман'), false);
    assert.equal(addressedByName('   ', 'Роман'), false);
  });
});

describe('NameGate', () => {
  test('молчит, пока не назвали по имени', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('погода хорошая', 1000), 'silent');
  });

  test('отвечает, когда назвали', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, твоё мнение?', 1000), 'respond');
  });

  test('внутри окна отвечает и без имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, твоё мнение?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 5000), 'respond');
  });

  test('после истечения окна снова молчит', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 40_000), 'silent');
  });

  test('каждый ответ продлевает окно', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    gate.decide('а дальше?', 20_000);
    gate.noteReplied(21_000);
    assert.equal(gate.decide('и что теперь?', 45_000), 'respond');
  });

  test('окно не открывается само, без ответа ассистента', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    // noteReplied не вызывался — модель промолчала, продолжать нечего
    assert.equal(gate.decide('а почему?', 5000), 'silent');
  });

  test('команда слушать уводит в режим слушателя', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, пока слушай', 1000), 'ack_listen');
  });

  test('в режиме слушателя молчит даже когда зовут по имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('Роман, что скажешь?', 2000), 'silent');
  });

  test('в режиме слушателя не действует и окно продолжения', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    gate.decide('Роман, пока слушай', 3000);
    assert.equal(gate.decide('а почему?', 4000), 'silent');
  });

  test('обратная команда возвращает в диалог', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('Роман, вопрос к тебе', 2000), 'ack_resume');
    assert.equal(gate.decide('Роман, так что?', 3000), 'respond');
  });

  test('обратная команда без имени не поднимает из режима слушателя', () => {
    // Иначе «вопрос к тебе», сказанное одним живым участником другому,
    // вернуло бы ассистента в разговор, из которого его убрали.
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    assert.equal(gate.decide('вопрос к тебе, Сергей', 2000), 'silent');
  });

  test('обычное обращение вне режима слушателя не считается командой', () => {
    assert.equal(new NameGate('Роман', 30_000).decide('Роман, вопрос к тебе', 1000), 'respond');
  });

  test('после возвращения окно продолжения снова работает', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, пока слушай', 1000);
    gate.decide('Роман, вопрос к тебе', 2000);
    gate.noteReplied(3000);
    assert.equal(gate.decide('а почему?', 5000), 'respond');
  });
});
