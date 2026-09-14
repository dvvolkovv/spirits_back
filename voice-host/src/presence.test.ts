import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Presence } from './presence.js';

describe('Presence', () => {
  test('пустая при создании', () => {
    const p = new Presence();
    assert.equal(p.count, 0);
    assert.deepEqual(p.names, []);
  });

  test('вход и выход считаются', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.apply({ event: 'join', uuid: 'u2', name: 'Дмитрий' });
    assert.equal(p.count, 2);
    p.apply({ event: 'leave', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
    assert.deepEqual(p.names, ['Дмитрий']);
  });

  test('повторный вход того же uuid не удваивает', () => {
    // Вебхуки могут повториться при retry, а Attendee ретраит настойчиво.
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
  });

  test('выход неизвестного никого не ломает', () => {
    const p = new Presence();
    p.apply({ event: 'leave', uuid: 'нет такого', name: '' });
    assert.equal(p.count, 0);
  });

  test('сам бот в счёт не идёт', () => {
    // Бот Attendee — полноправный участник встречи Meet и приходит в
    // join_leave наравне с людьми. Без исключения себя гейт по имени считал
    // бы, что в комнате всегда есть собеседник, и никогда не переходил в solo.
    const p = new Presence('Роман · ассистент Дмитрия');
    p.apply({ event: 'join', uuid: 'bot', name: 'Роман · ассистент Дмитрия' });
    assert.equal(p.count, 0);
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.count, 1);
  });

  test('наедине — когда остался один человек', () => {
    const p = new Presence();
    assert.equal(p.solo, false, 'в пустой комнате solo включать нельзя');
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.solo, true);
    p.apply({ event: 'join', uuid: 'u2', name: 'Дмитрий' });
    assert.equal(p.solo, false);
  });

  test('говорящий запоминается и сбрасывается', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.speech('u1', 'Сергей', true);
    assert.equal(p.speaker, 'Сергей');
    p.speech('u1', 'Сергей', false);
    assert.equal(p.speaker, undefined);
  });

  test('говорящий известен, даже если speech опередил join', () => {
    // Это разные вебхуки, порядок между ними не гарантирован. Без запаса
    // имени первая реплика встречи осталась бы без разметки говорящего.
    const p = new Presence();
    p.speech('u1', 'Сергей', true);
    assert.equal(p.speaker, 'Сергей');
  });

  test('чужое «замолчал» не сбивает текущего говорящего', () => {
    const p = new Presence();
    p.speech('u1', 'Сергей', true);
    p.speech('u2', 'Дмитрий', false);
    assert.equal(p.speaker, 'Сергей');
  });

  test('вышедший перестаёт быть говорящим', () => {
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей' });
    p.speech('u1', 'Сергей', true);
    p.apply({ event: 'leave', uuid: 'u1', name: 'Сергей' });
    assert.equal(p.speaker, undefined);
  });

  test('узнаёт себя, несмотря на разъехавшиеся пробелы', () => {
    // Имя собирается из профиля пользователя и идёт через Meet: двойной
    // пробел или неразрывный вместо обычного — обычное дело.
    const p = new Presence('Андрей · ассистент Дмитрий');
    p.apply({ event: 'join', uuid: 'bot', name: 'Андрей  ·  ассистент Дмитрий' });
    p.apply({ event: 'join', uuid: 'bot2', name: 'Андрей · ассистент Дмитрий' });
    assert.equal(p.count, 0, 'бот посчитался участником — гейт никогда не перейдёт в solo');
  });

  test('узнаёт себя при другой нормализации юникода', () => {
    // NFC против NFD: «й» бывает одним символом и двумя (и + краткая).
    // Побайтовое сравнение здесь молча промахивается.
    const name = 'Андрей · ассистент Дмитрий';
    const p = new Presence(name);
    p.apply({ event: 'join', uuid: 'bot', name: name.normalize('NFD') });
    assert.equal(p.count, 0);
  });

  test('узнаёт себя независимо от регистра и обрамляющих пробелов', () => {
    const p = new Presence('Андрей · ассистент Дмитрий');
    p.apply({ event: 'join', uuid: 'bot', name: '  АНДРЕЙ · Ассистент Дмитрий  ' });
    assert.equal(p.count, 0);
  });

  test('человека с похожим именем за себя не принимает', () => {
    // Нормализация не должна превратиться в «похоже — значит мы».
    const p = new Presence('Андрей · ассистент Дмитрий');
    p.apply({ event: 'join', uuid: 'u1', name: 'Андрей' });
    p.apply({ event: 'join', uuid: 'u2', name: 'Андрей · ассистент Сергей' });
    assert.equal(p.count, 2);
  });

  test('имя говорящего берётся из состава, а не из события', () => {
    // В ростере имя каноничное, в событии может приехать с мусором.
    const p = new Presence();
    p.apply({ event: 'join', uuid: 'u1', name: 'Сергей Волков' });
    p.speech('u1', 'сергей  волков', true);
    assert.equal(p.speaker, 'Сергей Волков');
  });

  test('сам бот не становится говорящим', () => {
    const p = new Presence('Роман · ассистент Дмитрия');
    p.speech('bot', 'Роман · ассистент Дмитрия', true);
    assert.equal(p.speaker, undefined);
  });
});

describe('речь как доказательство присутствия', () => {
  test('заговоривший возвращается в состав', () => {
    // Meet отдал сидящего человека со status: 8, Attendee прислал leave, и
    // состав опустел под живым разговором (09.09.2026). Речь — единственный
    // надёжный признак присутствия, который у нас есть.
    const p = new Presence('Роман · ассистент Дмитрия');
    p.apply({ event: 'join', uuid: 'u1', name: 'Владимир' });
    p.apply({ event: 'leave', uuid: 'u1', name: 'Владимир' });
    assert.equal(p.count, 0);
    p.speech('u1', 'Владимир', true);
    assert.equal(p.count, 1);
    assert.equal(p.speaker, 'Владимир');
  });

  test('свой голос в состав не добавляется', () => {
    // Бот Attendee сидит в встрече полноправным участником и говорит нашим же
    // голосом: попади он в состав — гейт по имени никогда не перешёл бы в
    // режим «наедине», а встреча никогда бы не опустела.
    const p = new Presence('Роман · ассистент Дмитрия');
    p.speech('bot', 'Роман · ассистент Дмитрия', true);
    assert.equal(p.count, 0);
  });

  test('«замолчал» состав не меняет', () => {
    const p = new Presence('Роман · ассистент Дмитрия');
    p.speech('u1', 'Владимир', true);
    p.speech('u1', 'Владимир', false);
    assert.equal(p.count, 1, 'человек не исчезает, когда просто перестал говорить');
    assert.equal(p.speaker, undefined);
  });
});
