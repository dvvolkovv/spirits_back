import { SEND_HELPER, AUDIO_PART } from './common.mjs';

/**
 * Сценарий страницы Яндекс Телемоста.
 *
 * Внедряется ДО скриптов площадки: перехватывать `getUserMedia` и
 * `RTCPeerConnection` после того, как страница ими воспользовалась, поздно.
 *
 * Звук — общий для всех площадок (`common.mjs`). Своё здесь только то, чего у
 * Телемоста нет в API и приходится читать глазами:
 *
 *   1. Состав — по счётчику площадки: имён в разметке нет вовсе, плитки
 *      участников пустые.
 *   2. Чат — по классам мессенджера. Писать нельзя: гостю площадка показывает
 *      «Войдите, чтобы написать сообщение».
 *
 * ГДЕ живёт чат — менялось. В прежнем Телемосте лента была в отдельном кадре
 * yandex.ru/chat, и читатель работал там, передавая сообщения родителю. В
 * обновлении 22.09.2026 Яндекс объединил Телемост с мессенджером, и лента
 * переехала в саму страницу встречи: кадра больше нет, а классы yamb-*
 * остались прежними. Поэтому читатель один, а запускается он в обоих местах —
 * разница только в том, куда отдавать найденное.
 *
 * Наружу всё уходит через `window.__botSend(тип, данные)`, который сервис
 * подставляет со своей стороны (`page.exposeFunction`). Так страница не знает
 * ни про вебсокеты, ни про вебхуки.
 */
export const TELEMOST_PAYLOAD = `
(() => {
  ${SEND_HELPER}

  /**
   * Читатель ленты сообщений.
   *
   * Автора берём с заголовка группы: подряд идущие сообщения мессенджер
   * группирует, и имя стоит только на первой строке — идём назад по всему
   * списку строк. Роль («Администратор») в тексте склеена с именем, отрезаем.
   *
   * Первый проход пропускаем целиком: это история до нашего прихода, а не
   * обращения к ассистенту.
   */
  const startChatReader = (emit) => {
    const seen = new Set();
    let started = false;

    const authorFor = (node) => {
      const row = node.closest('.yamb-message-row');
      if (!row) return 'участник';
      const rows = [...document.querySelectorAll('.yamb-message-row')];
      for (let i = rows.indexOf(row); i >= 0; i--) {
        const nameEl = rows[i].querySelector('.yamb-message-user__name');
        if (!nameEl) continue;
        const full = (nameEl.innerText || '').replace(/\\s+/g, ' ').trim();
        const roleEl = rows[i].querySelector('.yamb-message-user__additional-text');
        const role = roleEl ? (roleEl.innerText || '').trim() : '';
        const name = role && full.endsWith(role) ? full.slice(0, full.length - role.length).trim() : full;
        if (name) return name;
      }
      return 'участник';
    };

    setInterval(() => {
      try {
        for (const span of document.querySelectorAll('.yamb-message-text span.text[id$="_c"]')) {
          const id = span.id.replace(/_c$/, '');
          if (seen.has(id)) continue;
          const text = (span.innerText || '').replace(/\\s+/g, ' ').trim();
          if (!text) continue;
          seen.add(id);
          if (!started) continue;
          emit({ id, text, author: authorFor(span) });
        }
        started = true;
      } catch (e) { console.error('[бот] чат не прочитался', e); }
    }, 1500);
  };

  // ── Кадр чата прежнего Телемоста: только чтение, наружу через родителя ────
  //
  // Оставлено ради совместимости: обновление катится не всем сразу, и старая
  // раскладка со своим кадром может ещё встретиться.
  if (location.host === 'yandex.ru' && location.pathname.startsWith('/chat')) {
    startChatReader((msg) => window.parent.postMessage({ __bot: 'chat', ...msg }, '*'));
    return;
  }

  // ── Страница встречи ─────────────────────────────────────────────────────
  ${AUDIO_PART}

  // Лента нового Телемоста живёт здесь же, поэтому читаем и отсюда. В одной
  // странице работает только один из двух читателей: либо кадр мессенджера,
  // либо встроенная лента.
  startChatReader((msg) => send('chat', msg));

  // Состав: имён в разметке нет, есть счётчик на кнопке участников.
  //
  // Шлём КАЖДЫЙ раз, а не только при изменении: что из этого новость, решает
  // сервис — он один знает, что бэкенд подтвердил.
  setInterval(() => {
    try {
      const btn = document.querySelector('[data-testid="participants-button"]');
      if (!btn) return;
      const m = (btn.innerText || '').match(/\\d+/);
      if (!m) return;
      // Минус мы сами: площадка считает и бота.
      send('participants', { humans: Math.max(0, Number(m[0]) - 1) });
    } catch (e) { console.error('[бот] состав не прочитался', e); }
  }, 2000);

  // Сообщения из кадра чата — для прежней раскладки.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__bot !== 'chat' || !d.text) return;
    send('chat', { id: String(d.id), text: String(d.text), author: String(d.author || 'участник') });
  });

  /** Кусок живой ленты — для разбора зацепок по факту, а не по догадке. */
  window.__botChatSample = () => {
    const el = document.querySelector(
      '[class*="yamb-message-list"], [class*="message-list"], [data-testid*="message-list"],' +
      ' [class*="yamb-message"], [data-testid*="chat-panel"], [data-testid*="chat"]',
    );
    return el ? el.outerHTML.slice(0, 4000) : '';
  };

  send('ready', { url: location.host + location.pathname });
})();
`;

/**
 * Шаги входа. Разметка разведана 14–15.09.2026, уточнена 22.09.2026.
 *
 * Яндекс переделал Телемост: ссылка /j/… уводит на /@/j/…, интерфейс объединён
 * с мессенджером, а гостю поверх экрана входа показывают ознакомительное окно
 * «Большое обновление в Телемосте». Экран входа при этом никуда не делся — он
 * просто под окном и в дочернем кадре.
 */
export const TELEMOST_JOIN = {
  // Экран встречи живёт в дочернем кадре внутри оболочки Яндекс 360 — там и
  // поле имени, и кнопка входа. В главном документе их нет вовсе.
  frame: /\/private-join\//,
  // Окно приветствия закрываем ПЕРВЫМ делом. Зацепки по testid, а не по
  // подписи: подпись у такого окна меняется от выката к выкату.
  dismiss: '[data-testid="telemost-3-onboarding-confirm"], [data-testid="telemost-3-onboarding-close"]',
  nameInput: 'input[type="text"], input[placeholder*="мя" i]',
  joinButton: 'button:has-text("Подключиться"), [role="button"]:has-text("Подключиться")',
  cameraOff: '[role="button"][aria-label*="камер" i]',
  inMeeting: 'button:has-text("Участники"), [role="button"]:has-text("Участники"), [data-testid="participants-button"]',
  chatButton: '[data-testid="chat-alt-button"], button:has-text("Чат")',
  leaveButton: '[data-testid="end-call-alt-button"], [role="button"][aria-label*="Выйти" i], button[aria-label*="Выйти" i]',
};
