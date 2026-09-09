#!/usr/bin/env python3
"""
Локальная правка Attendee: терпимый поиск кнопки микрофона в Google Meet.

ЗАЧЕМ. Без неё ассистента во встрече НЕ СЛЫШНО вовсе — фича не работает.
Проверено тремя живыми встречами 09.09.2026: звук от нас доходит до Attendee
(`RealtimeAudioOutputManager: Audio thread started` в логе воркера) и
проигрывается в виртуальный микрофон страницы, но участники слышат тишину.

ПРИЧИНА — В ТЕГЕ, а не в подписи. `botOutputManager.playPCMAudio()` перед
проигрыванием зовёт `ensureMicOn()`, а тот у Meet-адаптера искал так:

    document.querySelector('button[aria-label="Turn on microphone"]')

Кнопка микрофона В САМОЙ ВСТРЕЧЕ — это не `<button>`, а `div` с
`role="button"`; на нём же живёт `data-is-muted`. Питонья часть Attendee
перечисляет ОБА тега (`'div[aria-label="Turn off microphone"],
button[aria-label="Turn off microphone"]'` в google_meet_ui_methods.py) и
потому микрофон перед входом глушит успешно, а JS искал только `button` — и
не находил ничего: «Microphone button not found» в консоли страницы,
микрофон бота выключен, звук уходит в никуда.

Замер после правки (живая встреча 10.09.2026), диагностика из самой страницы:

    'LinkeonMicToggle', wantOn: True, found: True,
        candidates: [{aria: 'Turn on microphone', tip: None, muted: 'true'}]
    'LinkeonMicToggle', wantOn: True, found: False,
        candidates: [{aria: 'Turn off microphone', tip: None, muted: 'false'}]

Первая строка — кнопку нашли при `muted: true` и нажали; вторая, пятью
секундами позже, — микрофон уже `muted: false`. Владелец подтвердил вслух:
«Роман, я тебя прекрасно слышу».

Обратите внимание: подпись совпала ТОЧНО, без горячей клавиши. Значит
сработал именно отказ от привязки к тегу. Терпимость к подписи (начало
строки, `data-tooltip`, `data-is-muted`) оставлена как запас на случай, если
Meet допишет к подписи горячую клавишу или сменит язык интерфейса, — но
причиной молчания была не она.

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

NEW = """// %(marker)s: поиск кнопки микрофона без привязки к тегу.
//
// Оригинал искал `button[aria-label="Turn on microphone"]`, а кнопка
// микрофона во встрече — не `<button>`, а `div` с role="button" (на нём же
// data-is-muted). Селектор не находил ничего, микрофон бота оставался
// выключенным, и ассистента было НЕ СЛЫШНО. Проверено тремя живыми
// встречами 09.09.2026, исправление подтверждено четвёртой 10.09.2026.
//
// Ищем среди любых элементов, а подпись сверяем терпимо — по началу
// aria-label, по началу data-tooltip и по data-is-muted, который не зависит
// ни от языка интерфейса, ни от того, дописал ли Meet к подписи горячую
// клавишу. Сама подпись в замере совпала точно: решающим был отказ от тега.
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
