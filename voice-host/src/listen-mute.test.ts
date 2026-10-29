import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LISTEN_MUTE_FALLBACK_MS, ListenMute } from './listen-mute.js';

/** Ручные часы: таймеры срабатывают, только когда тест их провернёт. */
function harness() {
  const sent: boolean[] = [];
  const timers: { at: number; fn: () => void; dead: boolean }[] = [];
  let now = 0;
  const mute = new ListenMute((on) => sent.push(on), (fn, ms) => {
    const t = { at: now + ms, fn, dead: false };
    timers.push(t);
    return () => { t.dead = true; };
  });
  const advance = (ms: number) => {
    now += ms;
    for (const t of timers) if (!t.dead && t.at <= now) { t.dead = true; t.fn(); }
  };
  return { mute, sent, advance };
}

test('микрофон гаснет после подтверждения, а не вместо него', () => {
  // 27.10.2026: кнопку нажали через секунду после «помолчи», одновременно с
  // запуском ответа «хорошо, слушаю», — формулу возврата не услышал никто.
  const { mute, sent } = harness();
  mute.enter();
  assert.deepEqual(sent, [], 'до подтверждения микрофон ещё нужен');
  mute.state('speaking');
  assert.deepEqual(sent, []);
  mute.state('listening');
  assert.deepEqual(sent, [true]);
});

test('недоговорённая прошлая реплика не считается подтверждением', () => {
  // «Помолчи» прозвучало, пока ассистент ещё говорил: конец ЭТОЙ речи — не
  // повод гасить микрофон, подтверждение ещё впереди.
  const { mute, sent } = harness();
  mute.state('speaking');
  mute.enter();
  mute.state('listening');
  assert.deepEqual(sent, []);
  mute.state('thinking');
  mute.state('speaking');
  mute.state('listening');
  assert.deepEqual(sent, [true]);
});

test('подтверждение так и не прозвучало — гасим по запасному сроку', () => {
  // 27.10.2026 по ответу «хорошо, слушаю» не пришло ни звука: ждать речи
  // бесконечно значит не погасить микрофон вовсе.
  const { mute, sent, advance } = harness();
  mute.enter();
  advance(LISTEN_MUTE_FALLBACK_MS - 1);
  assert.deepEqual(sent, []);
  advance(1);
  assert.deepEqual(sent, [true]);
});

test('гасим один раз: запасной срок после речи не жмёт кнопку снова', () => {
  const { mute, sent, advance } = harness();
  mute.enter();
  mute.state('speaking');
  mute.state('idle');
  advance(LISTEN_MUTE_FALLBACK_MS * 2);
  assert.deepEqual(sent, [true]);
});

test('возврат в разговор включает микрофон сразу — до ответа, а не после', () => {
  // Иначе начало ответа на «вопрос к тебе» уйдёт в выключенный микрофон.
  const { mute, sent } = harness();
  mute.enter();
  mute.state('speaking');
  mute.state('listening');
  mute.leave();
  assert.deepEqual(sent, [true, false]);
});

test('вернули раньше, чем погасли, — гасить уже нечего', () => {
  const { mute, sent, advance } = harness();
  mute.enter();
  mute.leave();
  mute.state('speaking');
  mute.state('listening');
  advance(LISTEN_MUTE_FALLBACK_MS);
  assert.deepEqual(sent, [false]);
});

test('повторное «помолчи» в режиме слушателя не перезапускает ожидание', () => {
  const { mute, sent } = harness();
  mute.enter();
  mute.state('speaking');
  mute.state('listening');
  mute.enter();
  assert.deepEqual(sent, [true]);
});
