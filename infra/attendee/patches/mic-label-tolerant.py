#!/usr/bin/env python3
"""
Локальная правка Attendee: терпимый поиск кнопки микрофона в Google Meet.

ЗАЧЕМ. Без неё ассистента во встрече НЕ СЛЫШНО вовсе — фича не работает.
Проверено тремя живыми встречами 09.09.2026: звук от нас доходит до Attendee
(`RealtimeAudioOutputManager: Audio thread started` в логе воркера) и
проигрывается в виртуальный микрофон страницы, но участники слышат тишину.

ПРИЧИНА. `botOutputManager.playPCMAudio()` перед проигрыванием зовёт
`ensureMicOn()`, а тот у Meet-адаптера ищет кнопку строгим совпадением:

    document.querySelector('button[aria-label="Turn on microphone"]')

На экране перед входом такая подпись и есть — поэтому питонья часть Attendee
кнопку находит и глушит микрофон перед входом. Но В САМОЙ ВСТРЕЧЕ Meet
добавляет к подписи горячую клавишу («Turn on microphone (ctrl + d)»), и
строгое совпадение не находит ничего: в консоли страницы остаётся
«Microphone button not found», микрофон бота выключен, звук уходит в
никуда.

ЧТО ДЕЛАЕТ ПРАВКА. Ищет кнопку терпимо и по трём признакам: начало
`aria-label`, начало `data-tooltip` и — самый честный — атрибут
`data-is-muted`, который Meet держит на кнопке микрофона. Плюс один раз в
пять секунд отправляет в питонью часть диагностику со всеми найденными
подписями: канал `window.ws.sendJson` любой неизвестный тип всё равно пишет
в лог («Received JSON message: …»), так что подписи Meet видно в
`docker compose logs attendee-worker-local` без отладчика.

ИДЕМПОТЕНТНА: повторный запуск ничего не меняет. Оригинал сохраняется рядом
с расширением `.linkeon-orig` при первом применении.

ЗАПУСК на стенде (исходники смонтированы в контейнеры как `.:/attendee`,
поэтому правка на хосте — это правка в контейнере):

    python3 mic-label-tolerant.py ~/attendee
    cd ~/attendee && docker compose -f dev.docker-compose.yaml restart \
        attendee-worker-local

ЭТО ВРЕМЕННО. Правка держится в нашем репозитории, а не в форке Attendee,
чтобы не заводить второй источник правды: как только апстрим исправит поиск
кнопки, скрипт нужно удалить вместе с этим файлом. До тех пор он обязателен
после каждого обновления Attendee — иначе ассистент молча онемеет.
"""

import shutil
import sys
from pathlib import Path

MARKER = "LINKEON_TOLERANT_MIC"

OLD = """function turnOnMic() {
    // Click microphone button to turn it on
    const microphoneButton = document.querySelector('button[aria-label="Turn on microphone"]');
    if (microphoneButton) {
        console.log("Clicking the microphone button to turn it on");
        microphoneButton.click();
    } else {
        console.log("Microphone button not found");
    }
}

function turnOffMic() {
    // Click microphone button to turn it off
    const microphoneButton = document.querySelector('button[aria-label="Turn off microphone"]');
    if (microphoneButton) {
        console.log("Clicking the microphone button to turn it off");
        microphoneButton.click();
    } else {
        console.log("Microphone off button not found");
    }
}"""

NEW = """// %(marker)s: терпимый поиск кнопки микрофона.
//
// Оригинал искал строгим совпадением aria-label («Turn on microphone»). Такая
// подпись есть на экране перед входом, но В САМОЙ ВСТРЕЧЕ Meet добавляет
// горячую клавишу — «Turn on microphone (ctrl + d)», — и селектор не находил
// ничего: микрофон бота оставался выключенным, и ассистента было НЕ СЛЫШНО.
// Проверено тремя живыми встречами 09.09.2026.
//
// Ищем по началу aria-label, по началу data-tooltip и по data-is-muted —
// последний Meet держит прямо на кнопке микрофона, и он не зависит от языка
// интерфейса и от того, дописал ли Meet к подписи что-нибудь ещё.
function linkeonFindMicButton(wantOn) {
    const want = wantOn ? 'turn on microphone' : 'turn off microphone';
    const nodes = Array.from(document.querySelectorAll('[aria-label], [data-tooltip], [data-is-muted]'));
    const seen = [];
    let match = null;
    for (const el of nodes) {
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        const tip = (el.getAttribute('data-tooltip') || '').toLowerCase();
        const muted = el.getAttribute('data-is-muted');
        if (aria.includes('microphone') || tip.includes('microphone') || muted !== null) {
            seen.push({ aria: el.getAttribute('aria-label'), tip: el.getAttribute('data-tooltip'), muted: muted });
        }
        if (!match && (aria.startsWith(want) || tip.startsWith(want))) match = el;
    }
    // Состояние честнее подписи: data-is-muted="true" — микрофон выключен.
    if (!match) match = nodes.find((el) => el.getAttribute('data-is-muted') === (wantOn ? 'true' : 'false')) || null;
    return { el: match, seen: seen };
}

// Диагностика раз в пять секунд: playPCMAudio зовёт ensureMicOn на КАЖДЫЙ
// кусок звука (десять раз в секунду), и без ограничения лог утонет.
let linkeonMicReportAt = 0;
function linkeonReportMic(wantOn, found, seen) {
    const now = Date.now();
    if (now - linkeonMicReportAt < 5000) return;
    linkeonMicReportAt = now;
    try {
        window.ws?.sendJson({ type: 'LinkeonMicToggle', wantOn: wantOn, found: !!found, candidates: seen.slice(0, 8) });
    } catch (e) { /* канал ещё не поднят — не повод ронять звук */ }
}

function turnOnMic() {
    const { el, seen } = linkeonFindMicButton(true);
    linkeonReportMic(true, el, seen);
    if (el) {
        el.click();
    } else {
        console.log("Microphone button not found");
    }
}

function turnOffMic() {
    const { el, seen } = linkeonFindMicButton(false);
    linkeonReportMic(false, el, seen);
    if (el) {
        el.click();
    } else {
        console.log("Microphone off button not found");
    }
}""" % {"marker": MARKER}


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "attendee")
    target = root / "bots" / "google_meet_bot_adapter" / "google_meet_chromedriver_payload.js"
    if not target.exists():
        print(f"не найден {target}")
        return 1

    src = target.read_text(encoding="utf-8")
    if MARKER in src:
        print("правка уже применена")
        return 0
    if OLD not in src:
        # Апстрим переписал эти функции — молча патчить нельзя.
        print("оригинальные turnOnMic/turnOffMic не найдены: Attendee обновился, правку надо пересмотреть")
        return 2

    backup = target.with_suffix(target.suffix + ".linkeon-orig")
    if not backup.exists():
        shutil.copy2(target, backup)
    target.write_text(src.replace(OLD, NEW), encoding="utf-8")
    print(f"правка применена, оригинал в {backup.name}")
    print("перезапустить: docker compose -f dev.docker-compose.yaml restart attendee-worker-local")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
