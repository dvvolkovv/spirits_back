import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Mixer, SAMPLES_PER_TICK } from './mixer.js';

/** Кадр постоянной амплитуды длиной в N тиков. */
function frame(value: number, ticks = 1): Int16Array {
  return Int16Array.from({ length: SAMPLES_PER_TICK * ticks }, () => value);
}

describe('Mixer', () => {
  test('без участников отдаёт тишину нужной длины', () => {
    const out = new Mixer().tick();
    assert.equal(out.length, SAMPLES_PER_TICK);
    assert.ok(out.every((v) => v === 0));
  });

  test('один участник проходит без изменений', () => {
    const m = new Mixer();
    m.push('alice', frame(100));
    const out = m.tick();
    assert.equal(out[0], 100);
    assert.equal(out[SAMPLES_PER_TICK - 1], 100);
  });

  test('двое складываются', () => {
    const m = new Mixer();
    m.push('alice', frame(100));
    m.push('bob', frame(50));
    assert.equal(m.tick()[0], 150);
  });

  test('сумма ограничивается сверху, а не переполняется', () => {
    const m = new Mixer();
    m.push('alice', frame(30000));
    m.push('bob', frame(30000));
    assert.equal(m.tick()[0], 32767);
  });

  test('и ограничивается снизу', () => {
    const m = new Mixer();
    m.push('alice', frame(-30000));
    m.push('bob', frame(-30000));
    assert.equal(m.tick()[0], -32768);
  });

  test('участник без данных не тормозит остальных', () => {
    const m = new Mixer();
    m.push('alice', frame(100));
    m.push('bob', new Int16Array(0));
    assert.equal(m.tick()[0], 100);
  });

  test('лишние сэмплы остаются на следующий тик', () => {
    const m = new Mixer();
    m.push('alice', frame(77, 2));
    assert.equal(m.tick()[0], 77);
    assert.equal(m.tick()[0], 77);
    // третий тик — данных больше нет
    assert.equal(m.tick()[0], 0);
  });

  test('кадр короче тика дополняется тишиной', () => {
    const m = new Mixer();
    m.push('alice', Int16Array.from({ length: 10 }, () => 500));
    const out = m.tick();
    assert.equal(out.length, SAMPLES_PER_TICK);
    assert.equal(out[0], 500);
    assert.equal(out[9], 500);
    assert.equal(out[10], 0);
  });

  test('несколько коротких кадров склеиваются в один тик', () => {
    const m = new Mixer();
    for (let i = 0; i < 4; i++) {
      m.push('alice', Int16Array.from({ length: SAMPLES_PER_TICK / 4 }, () => 200));
    }
    const out = m.tick();
    assert.equal(out[0], 200);
    assert.equal(out[SAMPLES_PER_TICK - 1], 200);
  });

  test('ушедший участник перестаёт влиять на микс', () => {
    const m = new Mixer();
    m.push('alice', frame(100, 3));
    m.remove('alice');
    assert.equal(m.tick()[0], 0);
  });

  test('буфер не растёт бесконечно, если участник шлёт быстрее, чем мы читаем', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('alice', frame(100));
    assert.ok(
      m.bufferedTicks('alice') <= Mixer.MAX_BUFFERED_TICKS,
      `в буфере ${m.bufferedTicks('alice')} тиков при потолке ${Mixer.MAX_BUFFERED_TICKS}`,
    );
  });

  test('переполнение буфера выбрасывает СТАРОЕ, а не свежее', () => {
    // Во встрече важна свежая речь: если копить, задержка только растёт.
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('alice', frame(1));
    m.push('alice', frame(777));
    // Вычерпываем буфер и проверяем, что свежий кадр в нём остался.
    let seen = false;
    for (let i = 0; i < Mixer.MAX_BUFFERED_TICKS + 2; i++) {
      if (m.tick()[0] === 777) seen = true;
    }
    assert.ok(seen, 'свежий кадр вытеснили вместо старого');
  });

  test('участники считаются раздельно', () => {
    const m = new Mixer();
    m.push('alice', frame(100, 2));
    m.push('bob', frame(50));
    assert.equal(m.tick()[0], 150);
    // у bob данные кончились, у alice остался второй тик
    assert.equal(m.tick()[0], 100);
  });
});
