import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { meetingInputOptions, realtimeTurnDetection } from './session-options.js';

test('во встрече RoomIO не заводит собственный вход', () => {
  const o = meetingInputOptions();
  assert.equal(o.audioEnabled, false);
  assert.equal(o.closeOnDisconnect, false);
});

/**
 * Дальше — проверки не нашего кода, а поведения SDK, на котором держится
 * `audioEnabled: false`.
 *
 * Обычный тест здесь бесполезен: сломается не наш код, а чужой — при
 * обновлении `@livekit/agents` подмена входа может переехать в другое место
 * или, наоборот, предупреждение начнёт делать то, что обещает. И то и другое
 * снаружи выглядит одинаково: ассистент во встрече слышит одного участника, а
 * все счётчики здоровы. Один раз мы это уже не заметили и искали три дня.
 *
 * Поэтому читаем установленный SDK и падаем, как только исчезает основание.
 */
const sdk = (file: string): string => {
  // Через resolve, а не по пути от исходника: pnpm держит пакеты в .pnpm и
  // раскладывает симлинками, и прямой `../node_modules/...` промахивается.
  const entry = createRequire(import.meta.url).resolve('@livekit/agents');
  return readFileSync(join(dirname(entry), 'voice', file), 'utf8');
};

test('SDK: RoomIO заводит свой вход только при audioEnabled', () => {
  const src = sdk('room_io/room_io.js');
  assert.match(src, /if \(this\.inputOptions\.audioEnabled\) \{\s*this\.audioInput = new ParticipantAudioInputStream/);
});

test('SDK: RoomIO затирает уже выставленный input.audio', () => {
  const src = sdk('room_io/room_io.js');
  // Присвоение guard-ится наличием СВОЕГО входа, а не пустотой поля сессии:
  // ровно поэтому один только `session.input.audio = ...` нас не спасает.
  assert.match(src, /if \(this\.audioInput\) \{\s*this\.agentSession\.input\.audio = this\.audioInput;/);
});

test('SDK: предупреждение «already set, ignoring» ничего не отключает', () => {
  const src = sdk('agent_session.js');
  const warn = src.indexOf('input.audio is already set, ignoring');
  assert.notEqual(warn, -1, 'предупреждение исчезло — поведение SDK изменилось, проверить подмену входа');
  const roomIo = src.indexOf('new RoomIO(', warn);
  assert.notEqual(roomIo, -1);
  // Между предупреждением и созданием RoomIO вход не выключается — иначе флаг
  // был бы не нужен, и это стоило бы перепроверить.
  assert.doesNotMatch(
    src.slice(warn, roomIo),
    /audioEnabled: false/,
    'SDK начал сам гасить вход — обоснование audioEnabled: false устарело',
  );
});

/**
 * Разметка реплик: серверное перебивание на встрече выключено.
 *
 * Это разворот решения 16.09.2026, и тест держит именно его, а не пороги.
 * Прежнее `interrupt_response: true` означало, что OpenAI снимает ответ
 * ассистента, едва его VAD услышал чужую речь, — и наша защита
 * `turnHandling.interruption` (800 мс, два слова) тут не помогала, она внутри
 * SDK. На встрече 20.10.2026 (Meet, четверо, 64 минуты) он из-за этого не смог
 * договорить ни одной фразы: обрывали на второй-третьей секунде, а один ответ
 * умер через 160 мс. Со стороны — «позвали, а он не ответил».
 *
 * Если тест покраснел, потому что флаг вернули: сначала замерьте долю его
 * речи. На той встрече было 0,3% времени, и опасение «говорит он часто», ради
 * которого стояло `true`, ей прямо противоречит.
 */
test('на встрече сервер не перебивает ассистента и не отвечает за него', () => {
  const t = realtimeTurnDetection(true);
  assert.equal(t.interrupt_response, false);
  assert.equal(t.create_response, false, 'ответ начинает гейт по имени, а не модель');
});

test('в звонке серверная разметка остаётся умолчанием API', () => {
  // Звонок — разговор один на один: там перебивать ассистента нормально, и
  // ответ модель начинает сама. Полей быть не должно вовсе, иначе мы молча
  // навяжем звонку поведение встречи.
  const t = realtimeTurnDetection(false);
  assert.equal('interrupt_response' in t, false);
  assert.equal('create_response' in t, false);
});

test('пороги подняты против дефолтов API', () => {
  // 0.5 и 500 мс по умолчанию: короткий посторонний звук считался началом
  // реплики, а пауза в середине фразы — её концом.
  const t = realtimeTurnDetection(true);
  assert.equal(t.type, 'server_vad');
  assert.ok(t.threshold > 0.5, `порог не поднят: ${t.threshold}`);
  assert.ok(t.silence_duration_ms > 500, `тишина не поднята: ${t.silence_duration_ms}`);
});
