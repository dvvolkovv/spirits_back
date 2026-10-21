import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TELEMOST_PAYLOAD } from '../src/payload/telemost.mjs';
import { ZOOM_PAYLOAD, ZOOM_PAGE_JS } from '../src/payload/zoom.mjs';
import { meetPayload } from '../src/payload/meet.mjs';

/**
 * Сценарии страниц обязаны быть РАЗБИРАЕМЫМ кодом.
 *
 * Они собираются шаблонными строками, и любая мелочь в исходнике ломает их
 * молча: обратная кавычка в комментарии закрывает строку, а `\n` вместо `\n`
 * превращается в настоящий перевод строки посреди литерала. Браузер в таком
 * случае не выполняет сценарий ВООБЩЕ — бот заходит на встречу, но не слышит,
 * не говорит и не видит состава, а в логе только чужие ошибки страницы.
 *
 * Так уже случалось дважды: 22.09.2026 (кавычка) и 28.09.2026 (перевод
 * строки), второй раз — прямо на живой встрече. Проверка стоит трёх строк.
 */
describe('сценарии страниц', () => {
  const payloads = {
    телемост: TELEMOST_PAYLOAD,
    zoom: ZOOM_PAYLOAD,
    'страница zoom': ZOOM_PAGE_JS,
    meet: meetPayload('Роман Linkeon'),
  };

  for (const [name, code] of Object.entries(payloads)) {
    test(`${name}: разбирается как код`, () => {
      assert.doesNotThrow(() => new Function(code), `сценарий ${name} не разбирается`);
    });

    test(`${name}: не оборван на полуслове`, () => {
      // Литерал, закрытый раньше времени, часто оставляет непарные кавычки —
      // код при этом может остаться разбираемым, но вести себя не так.
      assert.equal(code.split('`').length - 1, 0, `в ${name} осталась обратная кавычка`);
    });
  }
});

/**
 * Счётчик участников Телемоста.
 *
 * 13.10.2026 он молчал всю встречу, и ассистент вышел через LOBBY_MS. Узнать
 * причину было неоткуда: оба отказа в чтении — молчаливый return. Проба
 * отдаёт разметку в лог ровно так же, как это уже сделано для ленты чата.
 */
describe('счётчик участников Телемоста', () => {
  test('проба разметки объявлена', () => {
    assert.match(TELEMOST_PAYLOAD, /participants_probe/);
  });

  test('проба уходит один раз, а не каждые две секунды', () => {
    assert.match(TELEMOST_PAYLOAD, /participantsProbed/);
  });
});

/**
 * Микрофон площадки.
 *
 * Зацепка написана по образцу cameraOff — живьём разметку панели никто не
 * видел. Тест держит не саму зацепку, а наличие обеих ручек: без пробы
 * ненайденная кнопка молчит, и вторую редакцию пришлось бы писать по новой
 * догадке.
 */
describe('микрофон в сценарии Телемоста', () => {
  test('обе ручки объявлены', () => {
    assert.match(TELEMOST_PAYLOAD, /window\.__botSetMicMuted\s*=/);
    assert.match(TELEMOST_PAYLOAD, /window\.__botMicSample\s*=/);
  });

  test('ищется кнопка микрофона, а не камеры', () => {
    assert.match(TELEMOST_PAYLOAD, /aria-label\*=.микрофон/i);
  });
});

/**
 * Микрофон площадки в Meet.
 *
 * Пока Meet ходил через Attendee, этой ручки не могло быть в принципе — у них
 * её нет. С переездом Meet на своего бота запрет отпал, но ручка так и
 * осталась только у Телемоста: команда bot_mute доходила до бота и тихо гасла
 * в логе. Живая встреча 20.10.2026 была как раз в Meet, и участник вслух
 * сказал, что ждал погасшего микрофона.
 */
describe('микрофон в сценарии Meet', () => {
  const MEET = meetPayload('Роман Linkeon');

  test('обе ручки объявлены', () => {
    assert.match(MEET, /window\.__botSetMicMuted\s*=/);
    assert.match(MEET, /window\.__botMicSample\s*=/);
  });

  test('зацепка знает оба языка интерфейса', () => {
    // Язык панели зависит от настройки аккаунта, а не от нашего выбора. То же
    // самое уже учтено у cameraOff в MEET_JOIN.
    assert.match(MEET, /aria-label\*=.microphone/i);
    assert.match(MEET, /aria-label\*=.микрофон/i);
  });

  test('состояние берётся из data-is-muted, а не только из подписи', () => {
    // У Meet оно написано прямо на кнопке и от языка не зависит.
    assert.match(MEET, /data-is-muted/);
  });
});

/**
 * Состояние микрофона в Meet — исполнением, а не чтением.
 *
 * Вёрстку площадки тестами не проверить, а вот логику «кнопка подписана
 * действием, а не состоянием» — вполне, и ошибиться в ней легко: перепутав
 * знак, бот выключал бы микрофон ровно тогда, когда его просят включить.
 *
 * Берём из сценария ровно тот кусок, который уедет в браузер, и исполняем его
 * с подставным документом.
 */
describe('Meet: кнопка микрофона в деле', () => {
  const MEET = meetPayload('Роман Linkeon');

  function micHook(attrs) {
    const from = MEET.indexOf('const MIC_BTN');
    const to = MEET.indexOf('window.__botMicSample');
    assert.ok(from > 0 && to > from, 'кусок сценария не вырезался');
    const btn = attrs && {
      clicked: false,
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
      click() { btn.clicked = true; },
    };
    const win = {};
    new Function('window', 'document', MEET.slice(from, to))(win, {
      querySelector: () => btn || null,
    });
    return { set: win.__botSetMicMuted, btn };
  }

  test('микрофон включён, просят выключить — жмём', () => {
    const { set, btn } = micHook({ 'data-is-muted': 'false', 'aria-label': 'Turn off microphone' });
    assert.deepEqual(set(true), { ok: true, how: 'кнопкой' });
    assert.equal(btn.clicked, true);
  });

  test('уже выключен — не жмём второй раз', () => {
    // Иначе команда «помолчи», пришедшая дважды, снова включила бы микрофон.
    const { set, btn } = micHook({ 'data-is-muted': 'true', 'aria-label': 'Turn on microphone' });
    assert.deepEqual(set(true), { ok: true, how: 'уже в нужном состоянии' });
    assert.equal(btn.clicked, false);
  });

  test('возврат в разговор включает обратно', () => {
    const { set, btn } = micHook({ 'data-is-muted': 'true', 'aria-label': 'Turn on microphone' });
    assert.deepEqual(set(false), { ok: true, how: 'кнопкой' });
    assert.equal(btn.clicked, true);
  });

  for (const [label, muted] of [
    ['Turn off microphone', false],
    ['Turn on microphone', true],
    ['Выключить микрофон', false],
    ['Включить микрофон', true],
  ]) {
    test(`без data-is-muted состояние читается из «${label}»`, () => {
      // Запасной путь на случай, если атрибут переименуют. Подпись описывает
      // ДЕЙСТВИЕ: «Turn off» висит на включённом микрофоне.
      const { set, btn } = micHook({ 'aria-label': label });
      set(true);
      assert.equal(btn.clicked, !muted, `«${label}» — микрофон ${muted ? 'выключен' : 'включён'}`);
    });
  }

  test('кнопки нет — честный отказ, а не молчаливый успех', () => {
    // Отсюда растёт проба разметки в боте: вторая редакция зацепки пишется по
    // логу, а не по второй догадке.
    const { set } = micHook(null);
    assert.deepEqual(set(true), { ok: false, reason: 'кнопка микрофона не найдена' });
  });
});
