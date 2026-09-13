#!/usr/bin/env python3
"""
Диагностика исходящего звука в Google Meet: что происходит в аудиографе.

СИМПТОМ (13.09.2026). Живая встреча `ypj-ixta-fjs`. Микрофон бота включается —
владелец видит это в интерфейсе, и мост подтверждает: `LinkeonMicToggle` с
`aria: "Turn on microphone", muted: "true"` → клик → следующим сообщением уже
`muted: "false"`. Поток звука от нас до моста цел: `RealtimeAudioOutputManager:
Audio thread started/exited` встаёт ровно на наши сегменты речи, сегменты в
воркере открываются и закрываются штатно. **И во встрече тишина.**

Настройки бота посимвольно совпадают с теми, на которых 11.09.2026 ассистента
было слышно (сверено диффом записей `bots_bot`, различается только callId в
URL вебсокета). Значит дело не в нашем коде и не в конфигурации, а в состоянии
страницы.

ЧТО ПРОВЕРЯЕМ. Путь звука внутри страницы такой:

    playPCMAudio → AudioBuffer → BufferSource → gainNode → MediaStreamDestination
                                                              ↓
                                            sourceAudioTrack (клон отдан Meet
                                            подменённым getUserMedia)

Обрыв возможен в трёх местах, и снаружи все три выглядят одинаково — как
успех:

1. `AudioContext` не в состоянии `running`. Chrome создаёт контекст
   приостановленным, и хотя бот запущен с `--autoplay-policy=
   no-user-gesture-required`, проверить это надо, а не предполагать: пока
   контекст спит, `currentTime` стоит, буферы планируются в никуда, ошибок нет.
2. Дорожка `sourceAudioTrack` мертва или заглушена (`readyState: "ended"`,
   `muted: true`, `enabled: false`) — например, Meet остановил клон, а клон и
   источник связаны.
3. Граф собран, но Meet держит не наш клон — тогда у источника всё исправно, а
   во встрече тишина. Это видно по числу дорожек у destination и по тому, что
   `currentTime` растёт, а звука нет.

ЧТО ДЕЛАЕТ ПРАВКА.

1. Раз в пять секунд, пока играет очередь, шлёт в лог моста `LinkeonAudioDiag`:
   состояние и время контекста, длину очереди, усиление, состояние дорожки-
   источника, число дорожек у destination и счётчик принятых кусков PCM.
2. Будит контекст: если состояние не `running`, зовёт `resume()` и пишет
   результат. Это одновременно и проверка гипотезы №1, и её исправление —
   лишним не будет в любом случае, а живая встреча стоит дорого.

ИДЕМПОТЕНТНА: повторный запуск ничего не делает. Оригинал сохраняется рядом с
`.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 meet-audio-graph-diagnostic.py ~/attendee
    sudo docker compose -f ~/attendee/dev.docker-compose.yaml restart attendee-worker-local

ОТКАТ:

    cp bots/web_bot_adapter/shared_chromedriver_payload.js.linkeon-orig \
       bots/web_bot_adapter/shared_chromedriver_payload.js
"""

import io
import os
import shutil
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
PATH = os.path.join(ROOT, 'bots/web_bot_adapter/shared_chromedriver_payload.js')

DIAG = '''
// LINKEON_AUDIO_DIAG: состояние аудиографа бота раз в пять секунд.
//
// Смотрим ровно те три вещи, которые снаружи неразличимы (см. шапку патча):
// спит ли контекст, жива ли дорожка-источник, растёт ли время контекста.
let linkeonAudioDiagAt = 0;
let linkeonPcmChunks = 0;

function linkeonAudioDiag(mgr) {
    const now = Date.now();
    if (now - linkeonAudioDiagAt < 5000) return;
    linkeonAudioDiagAt = now;
    try {
        const ctx = mgr.audioContext;
        const track = mgr.sourceAudioTrack;
        window.ws?.sendJson({
            type: 'LinkeonAudioDiag',
            ctxState: ctx ? ctx.state : null,
            ctxTime: ctx ? Number(ctx.currentTime.toFixed(2)) : null,
            sampleRate: ctx ? ctx.sampleRate : null,
            queue: mgr.audioQueue.length,
            gain: mgr.gainNode ? mgr.gainNode.gain.value : null,
            destTracks: mgr.audioDestination ? mgr.audioDestination.stream.getAudioTracks().length : null,
            track: track ? { id: track.id, readyState: track.readyState, enabled: track.enabled, muted: track.muted } : null,
            pcmChunks: linkeonPcmChunks,
        });
    } catch (e) { /* канал ещё не поднят — не повод ронять звук */ }
}

// Разбудить контекст. Пока он приостановлен, буферы планируются в никуда и
// ошибок при этом нет — самый тихий способ остаться немым.
function linkeonWakeAudio(mgr) {
    try {
        const ctx = mgr.audioContext;
        if (!ctx || ctx.state === 'running') return;
        ctx.resume().then(
            () => window.ws?.sendJson({ type: 'LinkeonAudioResume', ok: true, state: ctx.state }),
            (e) => window.ws?.sendJson({ type: 'LinkeonAudioResume', ok: false, error: String(e) }),
        );
    } catch (e) { /* см. выше */ }
}
'''

ANCHOR_FN = 'class BotOutputManager {'

OLD_CREATE = """        // This is our *source* audio track; we will CLONE it for callers.
        const audioTracks = this.audioDestination.stream.getAudioTracks();
        this.sourceAudioTrack = audioTracks[0] || null;"""
NEW_CREATE = """        // This is our *source* audio track; we will CLONE it for callers.
        const audioTracks = this.audioDestination.stream.getAudioTracks();
        this.sourceAudioTrack = audioTracks[0] || null;
        linkeonWakeAudio(this);   // LINKEON_AUDIO_DIAG"""

OLD_PLAY = """    async playPCMAudio(pcmData, sampleRate = 44100, numChannels = 1) {
        this._createSourceAudioTrack();"""
NEW_PLAY = """    async playPCMAudio(pcmData, sampleRate = 44100, numChannels = 1) {
        linkeonPcmChunks++;   // LINKEON_AUDIO_DIAG
        this._createSourceAudioTrack();
        linkeonWakeAudio(this);"""

# Якорь — одна строка, без соседней пустой: в оригинале у неё есть хвостовые
# пробелы, и многострочный якорь об них спотыкается.
OLD_QUEUE = """        this.isPlayingAudioQueue = true;"""
NEW_QUEUE = """        this.isPlayingAudioQueue = true;
        linkeonAudioDiag(this);   // LINKEON_AUDIO_DIAG"""


def main() -> int:
    src = io.open(PATH, encoding='utf-8').read()
    if 'LINKEON_AUDIO_DIAG' in src:
        print('уже применено')
        return 0

    backup = PATH + '.linkeon-orig'
    if not os.path.exists(backup):
        shutil.copy2(PATH, backup)

    for old in (ANCHOR_FN, OLD_CREATE, OLD_PLAY, OLD_QUEUE):
        if old not in src:
            print('не найден якорь:\n' + old[:120])
            return 1

    src = src.replace(ANCHOR_FN, DIAG + '\n' + ANCHOR_FN, 1)
    src = src.replace(OLD_CREATE, NEW_CREATE, 1)
    src = src.replace(OLD_PLAY, NEW_PLAY, 1)
    src = src.replace(OLD_QUEUE, NEW_QUEUE, 1)

    io.open(PATH, 'w', encoding='utf-8', newline='\n').write(src)
    print('применено:', PATH)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
