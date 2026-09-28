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
