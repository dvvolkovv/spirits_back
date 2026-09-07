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
    // Уровень ниже NOISE_FLOOR_RMS: тест о геометрии кадра, а не о громкости,
    // и выравнивание не должно в него вмешиваться.
    m.push('alice', Int16Array.from({ length: 10 }, () => 100));
    const out = m.tick();
    assert.equal(out.length, SAMPLES_PER_TICK);
    assert.equal(out[0], 100);
    assert.equal(out[9], 100);
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
    // Метка ниже NOISE_FLOOR_RMS: тест про вытеснение из очереди, и
    // выравнивание громкости не должно менять искомое значение.
    m.push('alice', frame(200));
    // Вычерпываем буфер и проверяем, что свежий кадр в нём остался.
    let seen = false;
    for (let i = 0; i < Mixer.MAX_BUFFERED_TICKS + 2; i++) {
      if (m.tick()[0] === 200) seen = true;
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

/**
 * Выравнивание громкости. Встреча 07.09.2026: аудио троих участников дошло до
 * микшера, а в транскрипт попал в основном владелец — у остальных остались
 * обрывки. Складывая дорожки как есть, мы сохраняли разницу микрофонов.
 */
describe('Mixer — выравнивание громкости', () => {
  /** Кадр-«речь» заданного уровня: знакопеременный, чтобы RMS был равен |value|. */
  function speech(level: number, ticks = 1): Int16Array {
    return Int16Array.from({ length: SAMPLES_PER_TICK * ticks }, (_, i) =>
      i % 2 === 0 ? level : -level,
    );
  }

  test('тихого поднимаем к целевому уровню', () => {
    const m = new Mixer();
    // Гоняем достаточно кадров, чтобы скользящая оценка дошла до уровня.
    for (let i = 0; i < 200; i++) m.push('quiet', speech(500));
    assert.ok(m.gainFor('quiet') > 3, `усиление ${m.gainFor('quiet')} — тихого не подняли`);
  });

  test('громкого не трогаем — только вверх, никогда вниз', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('loud', speech(12_000));
    assert.equal(m.gainFor('loud'), 1);
  });

  test('усиление ограничено потолком — шум микрофона не станет громче речи', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('verysoft', speech(Mixer.NOISE_FLOOR_RMS + 1));
    assert.equal(m.gainFor('verysoft'), Mixer.MAX_GAIN);
  });

  test('тишина оценку не портит — усиления нет, пока не было речи', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('silent', speech(10));
    assert.equal(m.gainFor('silent'), 1);
  });

  test('паузы не задирают усиление говорившему', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) m.push('alice', speech(4000));
    const во_время_речи = m.gainFor('alice');
    for (let i = 0; i < 500; i++) m.push('alice', speech(5)); // долгая пауза
    assert.equal(m.gainFor('alice'), во_время_речи);
  });

  test('тихий и громкий после сведения сопоставимы', () => {
    const m = new Mixer();
    for (let i = 0; i < 200; i++) {
      m.push('loud', speech(9000));
      m.push('quiet', speech(900));
    }
    // Считаем вклад каждого в сведение по отдельности: их усиления и есть
    // ответ на вопрос, утонет ли тихий.
    const вклад_громкого = 9000 * m.gainFor('loud');
    const вклад_тихого = 900 * m.gainFor('quiet');
    const было = 9000 / 900; // разрыв микрофонов до выравнивания
    const стало = вклад_громкого / вклад_тихого;
    assert.ok(
      стало <= было / 3,
      `разрыв ${стало.toFixed(1)}× против ${было}× — выравнивание почти не помогло`,
    );
  });

  test('статистика отличает «молчал» от «звука не было»', () => {
    const m = new Mixer();
    for (let i = 0; i < 10; i++) m.push('talker', speech(5000));
    for (let i = 0; i < 10; i++) m.push('listener', speech(5)); // микрофон есть, речи нет
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x]));
    assert.equal(s.talker.frames, 10);
    assert.equal(s.talker.speechFrames, 10);
    assert.equal(s.listener.frames, 10);
    assert.equal(s.listener.speechFrames, 0);
  });
});
