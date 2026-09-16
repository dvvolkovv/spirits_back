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

  test('частота задаётся конструктором', () => {
    // 20 мс при 24 кГц — 480 сэмплов. Нужно для встреч Meet, где звук идёт
    // через Attendee на родной частоте Realtime.
    const m = new Mixer(false, 480);
    assert.equal(m.tick().length, 480);
  });

  test('по умолчанию остаётся 48 кГц', () => {
    // Свои комнаты и Taler ID не должны заметить этой правки.
    assert.equal(new Mixer().tick().length, 960);
  });

  test('потолок буфера считается в тиках новой частоты', () => {
    const m = new Mixer(false, 480);
    for (let i = 0; i < 100; i++) m.push('u1', new Int16Array(480));
    assert.ok(m.bufferedTicks('u1') <= Mixer.MAX_BUFFERED_TICKS);
  });

  test('на новой частоте кадры собираются встык, без потери сэмплов', () => {
    // Куски от Attendee не кратны тику, и склейка через границу — то место,
    // где легко потерять хвост или сдвинуть поток по времени.
    const m = new Mixer(false, 480);
    const chunk = new Int16Array(700).fill(1000);
    m.push('u1', chunk);
    const first = m.tick();
    assert.equal(first.length, 480);
    assert.ok(first.every((v) => v === 1000), 'первый тик целиком из данных');
    const second = m.tick();
    assert.equal(second.length, 480);
    // 700 - 480 = 220 сэмплов данных, дальше тишина.
    assert.ok(second.slice(0, 220).every((v) => v === 1000), 'хвост не потерян');
    assert.ok(second.slice(220).every((v) => v === 0), 'добивка тишиной');
  });
});

/**
 * Выравнивание громкости. Встреча 07.09.2026: аудио троих участников дошло до
 * микшера, а в транскрипт попал в основном владелец — у остальных остались
 * обрывки. Складывая дорожки как есть, мы сохраняли разницу микрофонов.
 */
describe('Mixer — выравнивание громкости', () => {
  /** Микшер с включённым выравниванием — так его создаёт вход встречи. */
  const leveller = () => new Mixer(true);
  /** Кадр-«речь» заданного уровня: знакопеременный, чтобы RMS был равен |value|. */
  function speech(level: number, ticks = 1): Int16Array {
    return Int16Array.from({ length: SAMPLES_PER_TICK * ticks }, (_, i) =>
      i % 2 === 0 ? level : -level,
    );
  }

  test('тихого поднимаем к целевому уровню', () => {
    const m = leveller();
    // Гоняем достаточно кадров, чтобы скользящая оценка дошла до уровня.
    for (let i = 0; i < 200; i++) m.push('quiet', speech(500));
    assert.ok(m.gainFor('quiet') > 3, `усиление ${m.gainFor('quiet')} — тихого не подняли`);
  });

  test('громкого не трогаем — только вверх, никогда вниз', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) m.push('loud', speech(12_000));
    assert.equal(m.gainFor('loud'), 1);
  });

  test('усиление ограничено потолком — шум микрофона не станет громче речи', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) m.push('verysoft', speech(Mixer.ABS_SILENCE_RMS + 5));
    assert.equal(m.gainFor('verysoft'), Mixer.MAX_GAIN);
  });

  /**
   * Тихий участник должен подтягиваться К ЦЕЛИ, а не просто «немного вверх».
   *
   * Порог речи стоял абсолютным (300) при речи тихого на уровне 287: в оценку
   * попадали только пики, оценка выходила завышенной, усиление — заниженным.
   * Опыт на синтетической встрече 07.09.2026: вход 287 поднимался до 1726 при
   * цели 3000, и такого участника распознавание не слышало вовсе.
   */
  test('тихий доводится до целевого уровня, а не до половины', () => {
    const m = leveller();
    const level = 287; // ровно тот уровень, на котором участника теряли
    for (let i = 0; i < 400; i++) m.push('quiet', speech(level));
    const итог = level * m.gainFor('quiet');
    assert.ok(
      итог > Mixer.TARGET_RMS * 0.75,
      `после усиления ${Math.round(итог)} при цели ${Mixer.TARGET_RMS} — недотянули`,
    );
  });


  test('усиление набирается с первых кадров, а не к середине фразы', () => {
    const m = leveller();
    // Полсекунды речи — 50 кадров по 10 мс. К этому моменту усиление обязано
    // быть уже почти рабочим: иначе начало первой фразы уходит неусиленным.
    for (let i = 0; i < 50; i++) m.push('quiet', speech(287));
    assert.ok(287 * m.gainFor('quiet') > Mixer.TARGET_RMS * 0.7, 'усиление набирается слишком медленно');
  });

  test('тишина оценку не портит — усиления нет, пока не было речи', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) m.push('silent', speech(10));
    assert.equal(m.gainFor('silent'), 1);
  });

  test('паузы не задирают усиление говорившему', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) m.push('alice', speech(4000));
    const во_время_речи = m.gainFor('alice');
    for (let i = 0; i < 500; i++) m.push('alice', speech(5)); // долгая пауза
    assert.equal(m.gainFor('alice'), во_время_речи);
  });

  test('тихий и громкий после сведения сопоставимы', () => {
    const m = leveller();
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
    const m = leveller();
    for (let i = 0; i < 10; i++) m.push('talker', speech(5000));
    for (let i = 0; i < 10; i++) m.push('listener', speech(5)); // микрофон есть, речи нет
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x]));
    assert.equal(s.talker.frames, 10);
    assert.equal(s.talker.speechFrames, 10);
    assert.equal(s.listener.frames, 10);
    assert.equal(s.listener.speechFrames, 0);
  });
});

/**
 * Усиление применяется только к тому, кто СЕЙЧАС говорит.
 *
 * Замер 15.09.2026 на настоящей встрече (запись Taler ID, окно 03:00–13:00,
 * эталон 1527 слов): один говорящий через микшер — 83% слов, он же плюс двое
 * молчащих с обычным микрофонным фоном — 59%. Само сложение стоит шести
 * пунктов, остальные девятнадцать — подъём фона молчащих: шум микрофона около
 * 120 проходит порог «это речь» (40), из него строится оценка громкости, и
 * выравнивание тянет ШУМ к целевым 3000, то есть в ×12. Под каждой фразой
 * говорящего лежат два таких усиленных шипения.
 */
describe('Mixer — молчащего не усиливаем', () => {
  const leveller = () => new Mixer(true);
  function tone(level: number): Int16Array {
    return Int16Array.from({ length: SAMPLES_PER_TICK }, (_, i) => (i % 2 === 0 ? level : -level));
  }

  /**
   * Речь — это уровень С ПАУЗАМИ, и в тестах тоже.
   *
   * Ровная синусоида постоянной громкости речью не является и отличить её от
   * шума по громкости кадра нельзя в принципе: микшер видит только уровень.
   * Поэтому говорящий здесь произносит «слоги» — сорок тиков звука, десять
   * тиков тишины, как живая фраза. Молчащий выдаёт ровный фон без пауз.
   */
  function syllable(level: number, tick: number): Int16Array {
    return tone(tick % 50 < 40 ? level : Math.round(level * 0.1));
  }
  function rms(s: Int16Array): number {
    let sum = 0;
    for (const v of s) sum += v * v;
    return Math.sqrt(sum / s.length);
  }

  /** Говорящий и молчащий с обычным фоном микрофона — случай живой встречи. */
  function room(speaker: number, noise: number, ticks: number): Int16Array {
    const m = leveller();
    let out = new Int16Array(SAMPLES_PER_TICK);
    for (let i = 0; i < ticks; i++) {
      m.push('alice', syllable(speaker, i));
      m.push('bob', tone(noise));
      out = m.tick();
    }
    return out;
  }

  test('пока говорит один, фон второго в сведение не поднимается', () => {
    // Alice говорит тихо (её поднимут), Bob молчит, но его микрофон шумит.
    // Раньше шум Bob проходил порог речи и тоже поднимался к 3000.
    const out = room(400, 120, 200);
    // В сведении должна быть поднятая Alice плюс НЕусиленный фон Bob.
    // Если поднялись оба, уровень будет заметно выше цели.
    assert.ok(
      rms(out) < Mixer.TARGET_RMS * 1.3,
      `уровень сведения ${Math.round(rms(out))} — похоже, подняли и молчащего`,
    );
  });

  test('молчащий помечен как молчащий, говорящий — как говорящий', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) {
      m.push('alice', syllable(400, i));
      m.push('bob', tone(120));
      m.tick();
    }
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x.speaking]));
    assert.equal(s.alice, true, 'говорящего сочли молчащим');
    assert.equal(s.bob, false, 'фон молчащего сочли речью');
  });

  test('заговорил — усиливается сразу, а не со второго слога', () => {
    const m = leveller();
    for (let i = 0; i < 200; i++) { m.push('alice', syllable(400, i)); m.push('bob', tone(120)); m.tick(); }
    // Alice замолчала, Bob заговорил на своём уровне.
    for (let i = 0; i < 3; i++) { m.push('alice', tone(40)); m.push('bob', tone(400)); m.tick(); }
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x.speaking]));
    assert.equal(s.bob, true, 'начало фразы не распозналось как речь');
  });

  test('говорят оба — поднимаем обоих', () => {
    // Хоровая речь не повод глушить второго: правило про молчащих, а не про
    // «только самый громкий».
    const m = leveller();
    for (let i = 0; i < 200; i++) { m.push('alice', syllable(400, i)); m.push('bob', syllable(500, i)); m.tick(); }
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x.speaking]));
    assert.equal(s.alice, true);
    assert.equal(s.bob, true);
  });

  test('тихого участника с живой встречи по-прежнему поднимаем', () => {
    // Числа не выдуманы: 15.09.2026 самый тихий участник шёл на 276 при фоне
    // своего микрофона около 120. Ради него выравнивание и заводили, и правка
    // «не поднимать молчащих» не должна выбросить его вместе с шумом.
    const m = leveller();
    for (let i = 0; i < 300; i++) {
      m.push('тихий', syllable(276, i));
      m.push('фон', tone(120));
      m.tick();
    }
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x]));
    assert.equal(s['тихий'].speaking, true, 'тихого сочли молчащим');
    assert.ok(s['тихий'].gain > 3, `усиление тихого ${s['тихий'].gain} — его не подняли`);
    assert.equal(s['фон'].speaking, false, 'фон соседа сочли речью');
  });

  test('встреча начинается с тишины — и это не мешает услышать речь', () => {
    // Живая встреча 16.09.2026: в комнате сначала идут ровные нули (никто ещё
    // не говорит), и на них строился фон. Признаком «фон не измерен» был сам
    // ноль, поэтому фон переписывался текущей громкостью каждый кадр, порог
    // речи становился невыполнимым, и в логе у всех разом стояло
    // «фон 0, молчит ×1». Тихого участника переставало быть слышно.
    const m = leveller();
    const silence = new Int16Array(SAMPLES_PER_TICK);
    for (let i = 0; i < 100; i++) { m.push('тихий', silence); m.push('фон', silence); m.tick(); }
    // Дальше речь, но с провалами в РОВНЫЙ ноль: так выглядит пустая очередь
    // участника — сеть дрогнула, кадр не доехал, микшер выдал тишину.
    for (let i = 0; i < 300; i++) {
      m.push('тихий', i % 10 === 9 ? silence : syllable(276, i));
      m.push('фон', i % 10 === 9 ? silence : tone(120));
      m.tick();
    }
    const s = Object.fromEntries(m.stats().map((x) => [x.participant, x]));
    assert.equal(s['тихий'].speaking, true, 'после тишины речь не распозналась');
    assert.ok(s['тихий'].gain > 3, `усиление ${s['тихий'].gain} — тихого не подняли`);
    assert.ok(s['тихий'].floor > 0, 'фон так и остался нулевым');
  });

  test('нулевой кадр не стирает измеренный фон', () => {
    // Это и ломалось в бою. Признаком «фон ещё не измерен» служил сам ноль,
    // поэтому ровный нулевой кадр — а он приходит от заглушенного микрофона и
    // при пустой очереди — сбрасывал фон обратно в ноль. Дальше первый же
    // кадр речи становился собственным порогом, и участник навсегда оставался
    // «молчащим». В логе живой встречи 16.09.2026 слово ГОВОРИТ встретилось
    // дважды за встречу, а ненулевой фон — один раз.
    const m = leveller();
    const silence = new Int16Array(SAMPLES_PER_TICK);
    for (let i = 0; i < 50; i++) { m.push('боб', tone(120)); m.tick(); }
    const измеренный = m.stats()[0].floor;
    assert.ok(измеренный > 0, 'фон не измерился и на ровном звуке');

    m.push('боб', silence);
    m.tick();
    assert.ok(
      m.stats()[0].floor > 0,
      `нулевой кадр обнулил фон: было ${измеренный}, стало ${m.stats()[0].floor}`,
    );
  });

  test('без выравнивания сведение не трогаем вовсе', () => {
    const m = new Mixer(false);
    let out = new Int16Array(SAMPLES_PER_TICK);
    for (let i = 0; i < 10; i++) { m.push('bob', tone(120)); out = m.tick(); }
    assert.ok(Math.abs(rms(out) - 120) < 5, 'без выравнивания уровень изменился');
  });
});
