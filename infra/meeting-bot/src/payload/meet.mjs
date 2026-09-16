import { SEND_HELPER, AUDIO_PART } from './common.mjs';

/**
 * Сценарий страницы Google Meet.
 *
 * Внедряется ДО скриптов площадки: перехватывать `getUserMedia` и
 * `RTCPeerConnection` после того, как страница ими воспользовалась, поздно.
 *
 * Звук — общий для всех площадок (`common.mjs`). Своё здесь только то, чего у
 * Meet нет в API: состав и чат.
 *
 * Мы читаем их ВЁРСТКОЙ, хотя Attendee берёт из данных-канала `collections`,
 * разбирая протобуф по номерам полей («Speculating that 1 = audio, 2 = video»,
 * «kicked out = 7?» — подлинные комментарии их декодера). Семьсот строк догадок
 * о недокументированном формате ломаются МОЛЧА: Google переставит поле, и будет
 * не ошибка, а тишина. Вёрстка ломается заметно. Решение владельца 16.09.2026.
 *
 * Подписи в зацепках английские не по небрежности: браузер для Meet поднимается
 * с локалью en-US (см. `bot.mjs`), иначе бот, работающий у нас, падал бы у
 * клиента с другим языком интерфейса.
 */
export const meetPayload = (displayName) => `
(() => {
  ${SEND_HELPER}
  ${AUDIO_PART}

  // Имя бота нужно странице, чтобы не считать участником и собеседником
  // самого себя. Передаём его подстановкой: другого канала к сценарию,
  // внедряемому до скриптов площадки, у нас нет.
  const myName = ${JSON.stringify(displayName || '')};
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();

  // ── Состав ───────────────────────────────────────────────────────────────
  //
  // Боковая панель у Meet ОДНА на чат и на людей: открыт чат — списка людей в
  // разметке нет вовсе. Чат важнее (без него ассистент не видит ссылок), значит
  // список достаётся нам только когда панель людей случайно открыта, а обычно
  // остаётся счётчик на кнопке. Счётчика хватает: гейт по имени решает по
  // числу, наедине ли ассистент, а имена — приятное дополнение.
  const readPeople = () => {
    const list = document.querySelector('div[aria-label="Participants"][role="list"]');
    if (list) {
      const names = [];
      for (const item of list.querySelectorAll('div[role="listitem"]')) {
        const name = clean((item.innerText || '').split('\\n')[0]);
        if (!name || name === myName) continue;
        names.push(name);
      }
      if (names.length) return { people: names.map((name, i) => ({ uuid: 'meet-' + name, name })) };
    }
    const btn = document.querySelector('button[aria-label="People"], button[aria-label*="People" i]');
    const m = btn ? clean(btn.innerText).match(/\\d+/) : null;
    // Минус мы сами: площадка считает и бота.
    if (m) return { humans: Math.max(0, Number(m[0]) - 1) };
    return null;
  };

  setInterval(() => {
    try {
      const state = readPeople();
      if (state) send('participants', state);
    } catch (e) { console.error('[бот] состав не прочитался', e); }
  }, 2000);

  // ── Чат ──────────────────────────────────────────────────────────────────
  //
  // Разметку ленты подсмотреть было не у кого: Attendee читает чат протобуфом.
  // Поэтому берём несколько зацепок подряд, от точной к грубой, а если не
  // подошла ни одна — ОДИН раз отдаём наружу кусок разметки панели. Пусть
  // первая живая встреча сама расскажет, как там всё устроено; гадать вторую
  // редакцию вслепую дороже.
  const seen = new Set();
  let started = false;
  let probed = false;

  const chatInput = () =>
    document.querySelector('textarea[aria-label="Send a message"], textarea[aria-label*="message" i]');

  /**
   * Лента сообщений.
   *
   * Ищем её ОТ ПОЛЯ ВВОДА, а не по aria-live саму по себе: у Meet таких
   * областей на странице несколько, и первая же холостая проверка 16.09.2026
   * поймала не чат, а объявление «Returning to home screen in 60 seconds». На
   * живой встрече так же поймались бы уведомления «такой-то присоединился».
   *
   * Поле ввода — надёжный признак: есть оно — панель чата открыта, нет — читать
   * нечего, и пробовать незачем.
   */
  const chatPanel = () => {
    const input = chatInput();
    if (!input) return null;
    const scope = input.closest('[role="complementary"], [role="region"], div[aria-label]') || document.body;
    return scope.querySelector('[role="log"]') || scope.querySelector('[aria-live="polite"]') || scope;
  };

  const readChat = () => {
    const panel = chatPanel();
    if (!panel) return 0;
    const nodes = panel.querySelectorAll('[data-message-id], [data-message-text], div[jscontroller][jsname] > div[jsaction]');
    let found = 0;
    for (const node of nodes) {
      found++;
      const id = node.getAttribute('data-message-id') || clean(node.innerText).slice(0, 80);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // Первый проход — история до нашего прихода: её пересылать нельзя, это
      // не обращения к ассистенту.
      if (!started) continue;
      const text = clean(node.getAttribute('data-message-text') || node.innerText);
      if (!text) continue;
      // Имя автора Meet ставит заголовком группы сообщений, а не у каждой
      // строки: идём вверх по соседям, пока не найдём подпись.
      let author = '';
      for (let el = node.previousElementSibling; el && !author; el = el.previousElementSibling) {
        const cand = clean((el.innerText || '').split('\\n')[0]);
        if (cand && cand.length < 60) author = cand;
      }
      if (!author) author = clean(node.getAttribute('data-sender-name')) || 'участник';
      if (author === myName) continue;   // своё же сообщение читать обратно незачем
      send('chat', { id, text, author });
    }
    return found;
  };

  setInterval(() => {
    try {
      const found = readChat();
      started = true;
      if (!found && !probed) {
        const panel = chatPanel();
        if (panel) {
          probed = true;
          send('chat_probe', { html: panel.innerHTML.slice(0, 2000) });
        }
      }
    } catch (e) { console.error('[бот] чат не прочитался', e); }
  }, 1500);

  /** Написать в общий чат. Ровно так это делает и Attendee — у Meet другого способа нет. */
  window.__botSendChat = (text) => {
    const input = document.querySelector('textarea[aria-label="Send a message"], textarea[aria-label*="message" i]');
    if (!input) return false;
    input.focus();
    input.value = String(text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
    return true;
  };

  send('ready', { url: location.host + location.pathname });
})();
`;

/**
 * Шаги входа. Зацепки проверены адаптером Attendee — кроме ленты чата, которой
 * у них нет вовсе (см. выше).
 */
export const MEET_JOIN = {
  nameInput: 'input[type="text"][aria-label="Your name"], input[type="text"][aria-label*="name" i]',
  joinButton: 'button:has-text("Ask to join"), button:has-text("Join now"), button:has-text("Join anyway")',
  cameraOff: 'button[aria-label*="camera" i][aria-label*="Turn off" i], div[aria-label*="Turn off camera" i]',
  inMeeting: 'button[aria-label="People"], button[aria-label*="People" i]',
  chatButton: 'button[aria-label="Chat with everyone"], button[aria-label*="Chat" i]',
  leaveButton: 'button[aria-label="Leave call"], button[aria-label*="Leave" i]',
};
