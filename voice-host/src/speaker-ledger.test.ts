import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SpeakerLedger } from './speaker-ledger.js';

describe('SpeakerLedger', () => {
  test('никто не говорил — метки нет', () => {
    assert.equal(new SpeakerLedger(0).takeDominant(5000), undefined);
  });

  test('говорил один — реплика его', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Сергей'], 0);
    l.setActive([], 3000);
    assert.equal(l.takeDominant(3500), 'Сергей');
  });

  /**
   * Тот самый случай, ради которого класс и заведён: на момент коммита
   * реплики активных уже нет. Снимок «кто активен сейчас» дал бы undefined —
   * так 130 реплик из 298 остались без метки 07.09.2026.
   */
  test('замолчал до коммита — метка всё равно его', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Vladimir'], 100);
    l.setActive([], 4000); // человек закончил фразу
    assert.equal(l.takeDominant(4600), 'Vladimir'); // коммит пришёл позже
  });

  /** Второй случай оттуда же: снимок отдал бы СЛЕДУЮЩЕГО говорящего. */
  test('следующий уже начал — реплика остаётся за тем, кто её произнёс', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Dmitry'], 0);
    l.setActive(['Сергей'], 5000); // Дмитрий договорил, вступил Сергей
    assert.equal(l.takeDominant(5300), 'Dmitry');
  });

  test('хоровая речь — за тем, кто говорил дольше', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Сергей', 'Vladimir'], 0);
    l.setActive(['Сергей'], 1000); // Владимир замолчал, Сергей продолжил
    l.setActive([], 4000);
    assert.equal(l.takeDominant(4000), 'Сергей');
  });

  test('счётчик обнуляется — разговорчивый не забирает метку у всей встречи', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Dmitry'], 0);
    l.setActive([], 60_000);
    assert.equal(l.takeDominant(60_000), 'Dmitry');

    l.setActive(['Сергей'], 61_000);
    l.setActive([], 62_000);
    assert.equal(l.takeDominant(62_000), 'Сергей');
  });

  test('между репликами никто не говорил — метки нет, а не прошлая', () => {
    const l = new SpeakerLedger(0);
    l.setActive(['Dmitry'], 0);
    l.setActive([], 2000);
    assert.equal(l.takeDominant(2000), 'Dmitry');
    assert.equal(l.takeDominant(9000), undefined);
  });
});
