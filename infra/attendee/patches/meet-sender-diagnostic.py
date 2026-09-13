#!/usr/bin/env python3
"""
Второй шаг диагностики немого Meet: ЧТО именно Meet отправляет во встречу.

ЗАЧЕМ. Первый шаг (`meet-audio-graph-diagnostic.py`) снял с подозрения весь наш
аудиограф. Живая встреча 13.09.2026, во время речи ассистента:

    LinkeonAudioDiag: ctxState=running, ctxTime 14.9→19.8→24.7→33.7,
                      queue 1→40→23→1, gain=1, destTracks=1, pcmChunks=119,
                      track: live, enabled=true, muted=false

То есть звук доехал до страницы, контекст живой, буферы проигрываются,
дорожка-источник жива и не заглушена. Микрофон во встрече включён — видно и
владельцу, и мосту. И тишина.

Остаётся ровно один неизвестный участок: дорожку, которую Meet ДЕЙСТВИТЕЛЬНО
шлёт в встречу, мы ни разу не видели. Подмена микрофона работает через
перехват `navigator.mediaDevices.getUserMedia` — если Meet получил микрофон
как-то иначе (из воркера, из iframe, старым `navigator.getUserMedia`), он
шлёт РЕАЛЬНОЕ устройство контейнера, то есть тишину, а наш клон играет в
никуда. Снаружи это неотличимо от исправной работы.

ЧТО МЕРЯЕМ.

1. Сколько раз перехваченный `getUserMedia` спросили со звуком (`gumAudio`).
   Ноль — приговор: микрофон взят мимо перехвата.
2. По каждому RTCPeerConnection страницы — его исходящие звуковые дорожки:
   `label` (у нашей — от `MediaStreamAudioDestinationNode`, у настоящей —
   имя устройства), `readyState`, `enabled`, `muted`.
3. Из `getStats()` по `outbound-rtp` со звуком: `packetsSent`, `bytesSent` и
   `totalAudioEnergy`. Это и есть окончательный ответ на вопрос «мы немы или
   нас не слышат»: энергия около нуля при играющей очереди означает, что Meet
   шлёт не нашу дорожку.

ИДЕМПОТЕНТНА. Оригиналы сохраняются рядом с `.linkeon-orig`.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`):

    python3 meet-sender-diagnostic.py ~/attendee
    sudo docker compose -f ~/attendee/dev.docker-compose.yaml restart attendee-worker-local
"""

import io
import os
import shutil
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else '.'
SHARED = os.path.join(ROOT, 'bots/web_bot_adapter/shared_chromedriver_payload.js')
MEET = os.path.join(ROOT, 'bots/google_meet_bot_adapter/google_meet_chromedriver_payload.js')

# --- 1. Реестр соединений: их создаёт перехватчик в мит-полезной нагрузке ---
OLD_PC = """            // Notify about the creation
            onPeerConnectionCreate(peerConnection);"""
NEW_PC = """            // Notify about the creation
            onPeerConnectionCreate(peerConnection);

            // LINKEON_SENDER_DIAG: держим список соединений, чтобы посмотреть,
            // какую звуковую дорожку Meet реально отправляет во встречу.
            (window.linkeonPCs = window.linkeonPCs || []).push(peerConnection);"""

# --- 2. Счётчик обращений к подменённому getUserMedia ---
OLD_GUM = """            if (needAudio) {
                // You need to initialize the source audio track here. It will play through the speakers if you initialize it in the constructor.
                self._createSourceAudioTrack();"""
NEW_GUM = """            if (needAudio) {
                // LINKEON_SENDER_DIAG: ноль обращений означает, что микрофон
                // взяли мимо перехвата, и во встречу идёт чужая дорожка.
                window.linkeonGumAudio = (window.linkeonGumAudio || 0) + 1;
                // You need to initialize the source audio track here. It will play through the speakers if you initialize it in the constructor.
                self._createSourceAudioTrack();"""

# --- 3. Сам отчёт: отправители и статистика исходящего звука ---
REPORT = '''
// LINKEON_SENDER_DIAG: что Meet отправляет во встречу.
//
// Раз в пять секунд обходим все RTCPeerConnection страницы и печатаем их
// исходящие звуковые дорожки вместе со статистикой. `label` различает нашу
// подменённую дорожку и настоящее устройство контейнера, а `totalAudioEnergy`
// показывает, есть ли в отправляемом потоке хоть какой-то звук.
let linkeonSenderDiagAt = 0;

async function linkeonSenderDiag() {
    const now = Date.now();
    if (now - linkeonSenderDiagAt < 5000) return;
    linkeonSenderDiagAt = now;
    try {
        const pcs = window.linkeonPCs || [];
        const out = [];
        for (const pc of pcs) {
            let senders = [];
            try { senders = pc.getSenders().filter((s) => s.track && s.track.kind === 'audio'); } catch (e) { continue; }
            if (!senders.length) continue;
            const entry = {
                state: pc.connectionState,
                tracks: senders.map((s) => ({
                    id: s.track.id, label: s.track.label,
                    readyState: s.track.readyState, enabled: s.track.enabled, muted: s.track.muted,
                })),
                rtp: [],
            };
            try {
                const stats = await pc.getStats();
                stats.forEach((r) => {
                    if (r.type === 'outbound-rtp' && r.kind === 'audio') {
                        entry.rtp.push({ packets: r.packetsSent, bytes: r.bytesSent });
                    }
                    // Энергия исходящего звука живёт в media-source, а не в
                    // outbound-rtp: в первой редакции патча она читалась не
                    // оттуда и приезжала пустой.
                    if (r.type === 'media-source' && r.kind === 'audio') {
                        entry.src = { level: r.audioLevel, energy: r.totalAudioEnergy, samples: r.totalSamplesDuration };
                    }
                });
            } catch (e) { entry.rtp = 'stats failed'; }
            out.push(entry);
        }
        window.ws?.sendJson({
            type: 'LinkeonSenderDiag',
            gumAudio: window.linkeonGumAudio || 0,
            pcs: pcs.length,
            outbound: out,
        });
    } catch (e) { /* канал ещё не поднят — не повод ронять звук */ }
}
'''

OLD_CALL = """        this.isPlayingAudioQueue = true;
        linkeonAudioDiag(this);   // LINKEON_AUDIO_DIAG"""
NEW_CALL = """        this.isPlayingAudioQueue = true;
        linkeonAudioDiag(this);   // LINKEON_AUDIO_DIAG
        linkeonSenderDiag();      // LINKEON_SENDER_DIAG"""

ANCHOR_FN = 'class BotOutputManager {'


def patch(path: str, pairs: list) -> int:
    src = io.open(path, encoding='utf-8').read()
    if 'LINKEON_SENDER_DIAG' in src:
        print('уже применено:', path)
        return 0
    backup = path + '.linkeon-orig'
    if not os.path.exists(backup):
        shutil.copy2(path, backup)
    for old, new in pairs:
        if old not in src:
            print('не найден якорь в', path, '\n' + old[:160])
            return 1
        src = src.replace(old, new, 1)
    io.open(path, 'w', encoding='utf-8', newline='\n').write(src)
    print('применено:', path)
    return 0


def main() -> int:
    rc = patch(MEET, [(OLD_PC, NEW_PC)])
    if rc:
        return rc
    return patch(SHARED, [
        (ANCHOR_FN, REPORT + '\n' + ANCHOR_FN),
        (OLD_GUM, NEW_GUM),
        (OLD_CALL, NEW_CALL),
    ])


if __name__ == '__main__':
    raise SystemExit(main())
