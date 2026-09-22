import { SEND_HELPER, AUDIO_PART } from './common.mjs';

/**
 * Сценарий страницы Телемоста.
 *
 * Внедряется ДО скриптов площадки: перехватывать `getUserMedia` и
 * `RTCPeerConnection` после того, как страница ими воспользовалась, поздно.
 *
 * Звук — общий для всех площадок (`common.mjs`). Своего здесь ровно то, чего
 * у Телемоста нет в API и приходится читать глазами, и всё это проверено
 * живыми встречами 14–15.09.2026 (грабли — в `infra/attendee/README.md`):
 *
 *   1. Состав — по счётчику площадки: имён в разметке нет вовсе, плитки
 *      участников пустые.
 *   2. Чат — читается в кадре Яндекс Мессенджера и передаётся родителю через
 *      postMessage. Писать нельзя: гостю площадка показывает «Войдите, чтобы
 *      написать сообщение».
 *
 * Наружу всё уходит одним способом — через `window.__botSend(тип, данные)`,
 * который сервис подставляет со своей стороны (`page.exposeFunction`). Так
 * страница не знает ни про вебсокеты, ни про вебхуки.
 */
export const TELEMOST_PAYLOAD = `
(() => {
  ${SEND_HELPER}

  // ── Кадр чата: только чтение, наружу через родителя ──────────────────────
  if (location.host === 'yandex.ru' && location.pathname.startsWith('/chat')) {
    const seen = new Set();
    let started = false;

    // Автор строки. Подряд идущие сообщения мессенджер группирует, и заголовок
    // с именем стоит только на первой строке группы — идём назад по всему
    // списку строк. Роль («Администратор») в innerText склеена с именем,
    // отрезаем её.
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
          // Первый проход — история до нашего прихода: её пересылать нельзя,
          // это не обращения к ассистенту.
          if (!started) continue;
          window.parent.postMessage(
            { __bot: 'chat', id, text, author: authorFor(span) },
            '*',
          );
        }
        started = true;
      } catch (e) { console.error('[бот] чат не прочитался', e); }
    }, 1500);
    return;
  }

  // ── Кадр встречи ────────────────────────────────────────────────────────
  ${AUDIO_PART}

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

  // Сообщения из кадра чата.
  window.addEventListener('message', (ev) => {
    const d = ev.data;
    if (!d || d.__bot !== 'chat' || !d.text) return;
    send('chat', { id: String(d.id), text: String(d.text), author: String(d.author || 'участник') });
  });

  send('ready', { url: location.host + location.pathname });
})();
`;

/**
 * Шаги входа. Разметка разведана 14–15.09.2026, уточнена 22.09.2026.
 *
 * Яндекс переделал Телемост: ссылка `/j/…` уводит на `/@/j/…`, интерфейс
 * объединён с мессенджером, а гостю поверх экрана входа показывают
 * ознакомительное окно «Большое обновление в Телемосте». Экран входа при этом
 * никуда не делся — он просто под окном, и пока окно висит, бот видит страницу
 * без единого поля и уходит ни с чем.
 */
export const TELEMOST_JOIN = {
  // Окно приветствия закрываем ПЕРВЫМ делом. Зацепки по testid, а не по
  // подписи: подпись у такого окна меняется от выката к выкату.
  dismiss: '[data-testid="telemost-3-onboarding-confirm"], [data-testid="telemost-3-onboarding-close"]',
  nameInput: 'input[type="text"], input[placeholder*="мя" i]',
  joinButton: 'button:has-text("Подключиться"), [role="button"]:has-text("Подключиться")',
  cameraOff: '[role="button"][aria-label*="камер" i]',
  inMeeting: 'button:has-text("Участники"), [role="button"]:has-text("Участники")',
  chatButton: '[data-testid="chat-alt-button"], button:has-text("Чат")',
  leaveButton: '[role="button"][aria-label*="Выйти" i], button[aria-label*="Выйти" i]',
};
