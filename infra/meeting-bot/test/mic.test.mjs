import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MeetingBot } from '../src/bot.mjs';

/**
 * Команда микрофона от воркера.
 *
 * Бота заводим настоящего — конструктор ничего не запускает, — а наружу
 * подменяем ровно одно: кадр страницы. Так проверяется и разбор сообщения, и
 * поведение при ненайденной кнопке, которого в браузере по заказу не добиться.
 */
function botWith(results) {
  const warns = [];
  const infos = [];
  const bot = new MeetingBot({
    id: 'тест',
    meetingUrl: 'x',
    displayName: 'Бот',
    platform: 'telemost',
    log: { info: (m) => infos.push(m), warn: (m) => warns.push(m) },
  });
  const args = [];
  bot.micFrame = async () => ({
    async evaluate(_fn, arg) {
      args.push(arg);
      return results.shift();
    },
  });
  return { bot, args, warns, infos };
}

const msg = (trigger, data) => Buffer.from(JSON.stringify({ trigger, data }));

describe('микрофон по команде воркера', () => {
  test('bot_mute с on:true выключает микрофон', async () => {
    const { bot, args, infos } = botWith([{ ok: true, how: 'кнопкой' }]);
    await bot.onWorkerMessage(msg('bot_mute', { on: true }));
    assert.deepEqual(args, [true]);
    assert.match(infos.join(' '), /микрофон выключен/);
  });

  test('bot_mute с on:false включает обратно', async () => {
    const { bot, args, infos } = botWith([{ ok: true, how: 'кнопкой' }]);
    await bot.onWorkerMessage(msg('bot_mute', { on: false }));
    assert.deepEqual(args, [false]);
    assert.match(infos.join(' '), /микрофон включён/);
  });

  test('кнопка не нашлась — разметка панели уезжает в лог', async () => {
    // Зацепка написана по догадке, живьём её никто не видел. Проба нужна,
    // чтобы вторая редакция писалась по факту, а не по второй догадке.
    const { bot, warns } = botWith([
      { ok: false, reason: 'кнопка микрофона не найдена' },
      '<div class="controls">кнопки</div>',
    ]);
    await bot.onWorkerMessage(msg('bot_mute', { on: true }));
    const log = warns.join(' ');
    assert.match(log, /кнопка микрофона не найдена/);
    assert.match(log, /class="controls"/);
  });

  test('голос ассистента по-прежнему играется', async () => {
    const { bot, args } = botWith([undefined]);
    await bot.onWorkerMessage(msg('realtime_audio.bot_output', { chunk: 'AAAA' }));
    assert.deepEqual(args, ['AAAA'], 'в страницу уходит сам кусок PCM');
  });

  test('мусор и чужие триггеры не роняют бота', async () => {
    const { bot, args } = botWith([]);
    await bot.onWorkerMessage(Buffer.from('не json'));
    await bot.onWorkerMessage(msg('bot.something_else', {}));
    assert.deepEqual(args, []);
  });
});
