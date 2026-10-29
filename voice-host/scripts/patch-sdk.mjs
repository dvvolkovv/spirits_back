// Правки LiveKit Agents SDK от утечки памяти во встрече.
//
// Накладываются при каждой сборке (npm run build), а не в postinstall:
// деплой пропускает npm ci, когда package-lock.json не менялся, и postinstall
// на сервере просто не запустился бы.
//
// Каждая правка ищет ТОЧНУЮ строку. Обновили SDK и строка поменялась —
// сборка падает: молча собрать текущий воркер хуже, чем не собрать.
//
// Прод: процесс встречи рос на 8–19 МБ/мин и к 47-й минуте проходил
// гигабайт (07.09, 14.09, 15.09, 27.10.2026). Стенд 29.10.2026, голая сессия
// Realtime без нашего кода: 9,7 МБ/мин — и с речью, и с тишиной. С обеими
// правками — ровно, 130–137 МБ все 8 минут. Обе причины есть и в 1.9.4.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SDK_PATCHES = [
  {
    // Цикл отправки в сокет Realtime на каждое событие делал
    // Promise.race([очередь, abortFuture.await]). abortFuture живёт до конца
    // соединения (20 мин), и каждая гонка вешала на него реакцию, которая
    // держала событие — 100 мс звука в base64. Куча: ~6 МБ/мин.
    id: 'realtime-send-loop',
    file: '@livekit/agents-plugin-openai/dist/realtime/realtime_model.js',
    from: 'const event = await Promise.race([this.messageChannel.get(), abortFuture.await]);',
    to: 'const event = await new Promise((resolve, reject) => { const onAbort = () => resolve(void 0); signal.addEventListener("abort", onAbort, { once: true }); this.messageChannel.get().then((v) => { signal.removeEventListener("abort", onAbort); resolve(v); }, (e) => { signal.removeEventListener("abort", onAbort); reject(e); }); });',
  },
  {
    // Звук делится tee на Realtime и на распознавание. Без STT и VAD — а
    // у нас ход разговора определяет сервер Realtime — вторую ветку не читает
    // никто, и tee копит в ней каждый кадр: 2,9 МБ/мин, ровно поток
    // 24 кГц × 16 бит. Ветку делаем, только если её есть кому читать.
    id: 'unread-recognition-tee',
    file: '@livekit/agents/dist/voice/agent_activity.js',
    from: 'if (this.realtimeSession && this.audioRecognition) {\n      const [realtimeAudioStream',
    to: 'if (this.realtimeSession && this.audioRecognition && (this.audioRecognition.stt || this.audioRecognition.vad)) {\n      const [realtimeAudioStream',
  },
];

/** Текст с правкой. Уже наложена — тот же текст; ни того ни другого — ошибка. */
export function applyPatch(text, patch) {
  // Файлы SDK на Windows могут прийти с CRLF — правки описаны с LF.
  const src = text.replace(/\r\n/g, '\n');
  if (src.includes(patch.to)) return src;
  const n = src.split(patch.from).length - 1;
  if (n !== 1) {
    throw new Error(`правка SDK ${patch.id}: в ${patch.file} исходная строка найдена ${n} раз(а) вместо одного — SDK обновили? Сверь правку с новым кодом.`);
  }
  return src.replace(patch.from, patch.to);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const nm = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules');
  for (const p of SDK_PATCHES) {
    const path = join(nm, p.file);
    const before = readFileSync(path, 'utf8');
    const after = applyPatch(before, p);
    if (after !== before) writeFileSync(path, after);
    console.log(`правка SDK ${p.id}: ${before.includes(p.to) ? 'уже на месте' : 'наложена'}`);
  }
}
