import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InputWatch, RECOVERY_MS, STUCK_SPEECH_MS } from './input-watch.js';

/**
 * Встреча 10.11.2026: в 06:52:22 модель прислала «речь началась» — и больше
 * ничего до конца встречи в 07:18. Звук шёл, люди звали Романа по имени, а
 * гейту было нечего решать: расшифровок не приходило.
 */

/** Подставная сессия плагина: события сервера и ручка переоткрытия. */
function fakeRt(withHook = true) {
  const listeners = new Map<string, ((ev: any) => void)[]>();
  const rt: any = {
    forced: [] as string[],
    on(event: string, cb: (ev: any) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), cb]);
    },
    /** Событие сервера Realtime. */
    emit(type: string) {
      for (const cb of listeners.get('openai_server_event_received') ?? []) cb({ type });
    },
    /** Событие самого плагина. */
    emitRt(event: string) {
      for (const cb of listeners.get(event) ?? []) cb({});
    },
  };
  if (withHook) rt.lkForceReconnect = (reason: string) => rt.forced.push(reason);
  return rt;
}

function watchOf(rt: any) {
  const lines: string[] = [];
  let now = 1_000_000;
  const watch = new InputWatch(rt, () => now, (l) => lines.push(l));
  return { watch, lines, at: (t: number) => (now = t) };
}

test('речь началась и кончилась — всё в порядке', () => {
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + 5_000);
  rt.emit('input_audio_buffer.speech_stopped');
  at(1_000_000 + STUCK_SPEECH_MS * 10);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('тишина без речи — не повод трогать сокет: на встрече молчат минутами', () => {
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  at(1_000_000 + 60 * 60_000);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('длинная реплика до порога — не трогаем', () => {
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS - 1);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('речь началась и не кончилась дольше порога — переоткрываем сокет и пишем об этом', () => {
  const rt = fakeRt();
  const { watch, lines, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  assert.equal(watch.check(), 'forced');
  assert.equal(rt.forced.length, 1);
  assert.match(lines.join('\n'), /модель молчит \d+с посреди речи — переоткрываю сокет/);
  // Повторно не дёргаем, пока ждём итога переоткрытия.
  at(1_000_000 + STUCK_SPEECH_MS + 5_000);
  assert.equal(watch.check(), 'waiting');
  assert.equal(rt.forced.length, 1);
});

test('после переоткрытия модель ответила — снова на связи', () => {
  const rt = fakeRt();
  const { watch, lines, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  watch.check();
  at(1_000_000 + STUCK_SPEECH_MS + 1_000);
  rt.emitRt('session_reconnected');
  assert.equal(watch.check(), 'recovered');
  assert.match(lines.join('\n'), /модель снова на связи/);
  // И дальше сторож работает как обычно.
  at(1_000_000 + STUCK_SPEECH_MS * 3);
  assert.equal(watch.check(), 'ok');
});

test('переоткрытие не помогло за отведённое время — сессия мертва', () => {
  const rt = fakeRt();
  const { watch, lines, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  watch.check();
  at(1_000_000 + STUCK_SPEECH_MS + RECOVERY_MS);
  assert.equal(watch.check(), 'dead');
  assert.match(lines.join('\n'), /переоткрытие не помогло/);
});

test('ручки переоткрытия нет (SDK собран без правки) — сразу мертва, а не вечная глухота', () => {
  const rt = fakeRt(false);
  const { watch, lines, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  assert.equal(watch.check(), 'dead');
  assert.match(lines.join('\n'), /ручки переоткрытия нет/);
});

test('порог с запасом против живого монолога: реплики встреч до 40 с', () => {
  // 10.11.2026 самые длинные отрезки речи без паузы — 36–38 с.
  assert.ok(STUCK_SPEECH_MS >= 90_000);
  // Переоткрытие с тремя повторами по таймауту 10 с укладывается в ~40 с.
  assert.ok(RECOVERY_MS >= 45_000);
});

// Ложные срабатывания: «речь началась», а конца не будет по законной причине.
// Ложное переоткрытие обрывает ответ Романа на полуслове и заново заливает
// весь разговор (ревью 10.11.2026).

test('речь началась на старом сокете, а его сменили — конца не будет, это не зависание', () => {
  // Плановое переоткрытие раз в 20 минут ждёт конец ответа, но не конец речи.
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + 1_000);
  rt.emit('session.created');
  at(1_000_000 + STUCK_SPEECH_MS * 2);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('буфер очищен посреди речи — конца не будет, это не зависание', () => {
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + 1_000);
  rt.emit('input_audio_buffer.cleared');
  at(1_000_000 + STUCK_SPEECH_MS * 2);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('после «речь началась» модель что-то шлёт — она жива, сокет не трогаем', () => {
  // Звук мог оборваться посреди фразы (ушёл последний говоривший), и конца
  // речи сервер не увидит. Но живой сокет при этом отвечает — 10.11.2026 не
  // пришло НИ ОДНОГО события.
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + 30_000);
  rt.emit('response.created');
  at(1_000_000 + STUCK_SPEECH_MS * 2);
  assert.equal(watch.check(), 'ok');
  assert.deepEqual(rt.forced, []);
});

test('после переоткрытия событие старого сокета — ещё не выздоровление', () => {
  // Ручка может не сработать (плагин ждёт конец ответа или сокета уже нет), а
  // старый сокет до закрытия успевает прислать событие. Выздоровление — только
  // новая сессия.
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  watch.check();
  at(1_000_000 + STUCK_SPEECH_MS + 1_000);
  rt.emit('response.done');
  assert.equal(watch.check(), 'waiting');
  at(1_000_000 + STUCK_SPEECH_MS + RECOVERY_MS);
  assert.equal(watch.check(), 'dead');
});

test('новая сессия сервера после переоткрытия — выздоровление', () => {
  const rt = fakeRt();
  const { watch, at } = watchOf(rt);
  rt.emit('input_audio_buffer.speech_started');
  at(1_000_000 + STUCK_SPEECH_MS);
  watch.check();
  at(1_000_000 + STUCK_SPEECH_MS + 2_000);
  rt.emit('session.created');
  assert.equal(watch.check(), 'recovered');
});
