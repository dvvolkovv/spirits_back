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

describe('NameGate — окно не открыто вечно', () => {
  test('цепочка ответов не держит окно бесконечно', () => {
    // Живая встреча 28.08.2026: под конец он отзывался на «Филипп», «Сестра»,
    // «я», «никому» — на любой обрывок. Окно продлевалось от КАЖДОГО ответа,
    // и цикл сам себя поддерживал: ответил → окно открылось → следующая
    // реплика попала в него → ответил снова.
    const gate = new NameGate('Роман', 30_000, 120_000);
    gate.decide('Роман, что скажешь?', 1000);
    // Ответ каждые двадцать секунд — окно всё время «свежее».
    for (let t = 2000; t < 200_000; t += 20_000) gate.noteReplied(t);
    assert.equal(gate.decide('никому', 200_000), 'silent');
  });

  test('внутри потолка доспросить по-прежнему можно', () => {
    const gate = new NameGate('Роман', 30_000, 120_000);
    gate.decide('Роман, что скажешь?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 20_000), 'respond');
    gate.noteReplied(21_000);
    assert.equal(gate.decide('и что дальше?', 40_000), 'respond');
  });

  test('новое обращение по имени поднимает потолок заново', () => {
    const gate = new NameGate('Роман', 30_000, 120_000);
    gate.decide('Роман?', 1000);
    for (let t = 2000; t < 200_000; t += 20_000) gate.noteReplied(t);
    assert.equal(gate.decide('обрывок', 200_000), 'silent');
    // Позвали снова — и окно опять работает.
    assert.equal(gate.decide('Роман, ещё вопрос', 201_000), 'respond');
    gate.noteReplied(202_000);
    assert.equal(gate.decide('а почему?', 210_000), 'respond');
  });

  test('представление ассистента окна не открывает', () => {
    // Он говорит первым, никем не позванный: noteReplied есть, обращения не
    // было. Раньше после этого он полминуты отвечал всем подряд.
    const gate = new NameGate('Роман', 30_000, 120_000);
    gate.noteReplied(1000);
    assert.equal(gate.decide('а вы кто?', 2000), 'silent');
  });
});

describe('NameGate — просьба замолчать', () => {
  test('«не тебе» останавливает, даже когда рядом стоит имя', () => {
    // Живая встреча 28.08.2026: фраза «Роман, я же тебе сказал, это не тебе
    // вопрос» содержала имя, гейт считал её обращением и отвечал. Попытка
    // остановить ассистента заставляла его говорить.
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('Роман, я же сказал, это не тебе вопрос', 1000), 'silent');
  });

  test('«помолчи» и «замолчи» тоже останавливают', () => {
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('Роман, помолчи', 1000), 'silent');
    assert.equal(gate.decide('Роман, замолчи пожалуйста', 2000), 'silent');
  });

  test('просьба замолчать закрывает окно продолжения', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, что скажешь?', 1000);
    gate.noteReplied(2000);
    gate.decide('это не тебе', 3000);
    // Окно закрыто — следующая реплика без имени уже не проходит.
    assert.equal(gate.decide('а дальше что?', 4000), 'silent');
  });

  test('обычная реплика со словом «тише» о звуке тоже глушит — принятый компромисс', () => {
    // Ложное молчание дешевле ложной реплики при клиенте.
    const gate = new NameGate('Роман', 30_000);
    assert.equal(gate.decide('говори тише, тебя плохо слышно', 1000), 'silent');
  });
});

describe('NameGate — окно продолжения привязано к говорящему', () => {
  test('доспросить без имени может тот, кто позвал', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, что скажешь?', 1000, 'Дмитрий');
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 5000, 'Дмитрий'), 'respond');
  });

  test('другой участник в окно не попадает', () => {
    // Иначе вопрос, заданный одним человеком другому, поднимает ассистента:
    // «Как создать телеграм-бота?» — и он влезает в чужой разговор.
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, что скажешь?', 1000, 'Дмитрий');
    gate.noteReplied(2000);
    assert.equal(gate.decide('как создать телеграм-бота?', 5000, 'Сергей'), 'silent');
  });

  test('но по имени отвечает кому угодно', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман, что скажешь?', 1000, 'Дмитрий');
    gate.noteReplied(2000);
    assert.equal(gate.decide('Роман, а ты как думаешь?', 5000, 'Сергей'), 'respond');
  });

  test('без сведений о говорящем окно работает как раньше', () => {
    // Разметка говорящего приблизительная и может отсутствовать — тогда
    // прежнее поведение по времени лучше, чем полное молчание.
    const gate = new NameGate('Роман', 30_000);
    gate.decide('Роман?', 1000);
    gate.noteReplied(2000);
    assert.equal(gate.decide('а почему?', 5000), 'respond');
  });
});

describe('NameGate — наедине', () => {
  test('на один-на-один отвечает без имени', () => {
    // Живая встреча 03.09.2026: владелец вёл деловой разговор, а ассистент
    // молчал на «давай обсудим кампанию», «зададим вопрос юристу» и
    // «финансист, чтобы было выгодно» — имени в них не было.
    const gate = new NameGate('Роман', 30_000);
    gate.setSolo(true);
    assert.equal(gate.decide('давай обсудим кампанию', 1000), 'respond');
  });

  test('появился второй — снова молчит без имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.setSolo(true);
    assert.equal(gate.decide('давай обсудим', 1000), 'respond');
    gate.setSolo(false);
    assert.equal(gate.decide('давай обсудим', 2000), 'silent');
    assert.equal(gate.decide('Роман, давай обсудим', 3000), 'respond');
  });

  test('просьба замолчать действует и наедине', () => {
    // Иначе выключить его один на один стало бы невозможно.
    const gate = new NameGate('Роман', 30_000);
    gate.setSolo(true);
    assert.equal(gate.decide('помолчи', 1000), 'silent');
  });

  test('режим слушателя наедине включается без имени', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.setSolo(true);
    assert.equal(gate.decide('пока слушай', 1000), 'ack_listen');
    assert.equal(gate.decide('погода хорошая', 2000), 'silent');
    assert.equal(gate.decide('вопрос к тебе', 3000), 'ack_resume');
    assert.equal(gate.decide('так что скажешь?', 4000), 'respond');
  });

  test('в режиме слушателя наедине молчит несмотря на solo', () => {
    const gate = new NameGate('Роман', 30_000);
    gate.setSolo(true);
    gate.decide('пока слушай', 1000);
    assert.equal(gate.decide('что угодно', 2000), 'silent');
  });
});
