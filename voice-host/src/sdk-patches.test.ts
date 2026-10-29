import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error — сценарий сборки на чистом JS, типов у него нет
import { SDK_PATCHES, applyPatch } from '../scripts/patch-sdk.mjs';

/**
 * Утечка памяти во встрече — две правки SDK.
 *
 * Прод: процесс встречи рос на 8–19 МБ/мин и к 47-й минуте проходил гигабайт
 * (07.09, 14.09, 15.09, 27.10.2026). Стенд 29.10.2026 без нашего кода, голая
 * сессия Realtime, 12 минут: 9,7 МБ/мин и с речью, и с тишиной. С обеими
 * правками — ровно, 130–137 МБ все 8 минут.
 */

const NM = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');

interface Patch { id: string; file: string; from: string; to: string }
const patches = SDK_PATCHES as Patch[];

test('правки две: цикл отправки плагина и лишний tee звука', () => {
  assert.deepEqual(patches.map((p) => p.id).sort(), ['realtime-send-loop', 'unread-recognition-tee']);
});

for (const p of patches) {
  test(`${p.id}: установленный SDK собран с правкой`, () => {
    // Сборка накладывает правки до tsc. Красный здесь — значит, процесс
    // встречи снова течёт: либо сборку запустили в обход, либо SDK обновили
    // и строка поменялась (тогда упадёт и сама сборка).
    const text = readFileSync(join(NM, p.file), 'utf8');
    assert.ok(text.includes(p.to), `в ${p.file} нет правки ${p.id}`);
    assert.ok(!text.includes(p.from), `в ${p.file} осталась исходная строка ${p.id}`);
  });

  test(`${p.id}: правка повторно не накладывается`, () => {
    const once = applyPatch(`до\n${p.from}\nпосле`, p);
    assert.equal(applyPatch(once, p), once);
  });

  test(`${p.id}: незнакомый SDK — отказ, а не молчаливый пропуск`, () => {
    assert.throws(() => applyPatch('совсем другой код', p), new RegExp(p.id));
  });
}

test('цикл отправки не гоняет race с вечным промисом отмены', () => {
  // Promise.race с промисом, живущим до конца соединения, вешает на него
  // реакцию на КАЖДОЕ событие, и реакция держит событие — 100 мс звука в
  // base64. До переоткрытия сокета (20 мин) куча росла на ~6 МБ/мин.
  const p = patches.find((x) => x.id === 'realtime-send-loop')!;
  assert.match(p.from, /Promise\.race\(\[this\.messageChannel\.get\(\), abortFuture\.await\]\)/);
  assert.doesNotMatch(p.to, /Promise\.race/);
  assert.match(p.to, /removeEventListener\("abort"/);
});

test('ветку звука для распознавания делаем, только если её есть кому читать', () => {
  // Без STT и VAD (ход разговора определяет сервер Realtime) вторую ветку tee
  // не читает никто, и tee копит в ней каждый кадр: 2,9 МБ/мин — ровно поток
  // 24 кГц × 16 бит.
  const p = patches.find((x) => x.id === 'unread-recognition-tee')!;
  assert.match(p.to, /this\.audioRecognition\.stt \|\| this\.audioRecognition\.vad/);
});
