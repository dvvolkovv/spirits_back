import { SEND_HELPER, AUDIO_PART } from './common.mjs';

/**
 * Zoom: вход через Meeting SDK, а не по вёрстке.
 *
 * Zoom — единственная из наших площадок, у которой есть официальный клиент для
 * браузера: мы поднимаем СВОЮ страницу, загружаем в неё Meeting SDK и зовём
 * `ZoomMtg.join`. Взамен получаем то, чего в Телемосте нет и не будет: имена
 * участников, чат в обе стороны и события входа-выхода — всё по API, без
 * чтения разметки. Ломаться от редизайна Zoom тут нечему.
 *
 * Цена — ключи приложения Zoom Marketplace (`ZOOM_SDK_CLIENT_ID` и
 * `ZOOM_SDK_CLIENT_SECRET`): вход подписывается JWT, без него SDK не пустит.
 * Те же ключи уже заведены в Attendee, откуда мы этот путь и переняли.
 *
 * Версия SDK ЗАПИНЕНА (5.1.4). Zoom выкладывает свежие сборки на тот же CDN, и
 * `latest` однажды поменяет поведение посреди живой встречи — ровно тот риск,
 * из-за которого мы пинили и образ моста.
 */

const SDK_VERSION = '5.1.4';
const SDK_BASE = `https://source.zoom.us/${SDK_VERSION}`;

/**
 * Сценарий, который внедряется ДО скриптов страницы.
 *
 * Только звук: всё остальное Zoom отдаёт через API, и подслушивать страницу
 * незачем. Перехват обязан встать раньше SDK — иначе микрофон и входящие
 * дорожки уже разобраны без нас.
 */
export const ZOOM_PAYLOAD = `
(() => {
  ${SEND_HELPER}
  ${AUDIO_PART}
  send('ready', { url: location.host + location.pathname });
})();
`;

/**
 * Страница, которую отдаёт наш статический сервер.
 *
 * Заголовки COOP/COEP ставит сервер: без них SDK не получает
 * `SharedArrayBuffer` и не собирает галерею. Нам галерея не нужна, но SDK
 * проверяет их на старте, поэтому проще дать.
 */
export const ZOOM_PAGE_HTML = `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="utf-8">
    <title>Zoom</title>
  </head>
  <body>
    <div id="meetingSDKElement"></div>
    <script src="${SDK_BASE}/lib/vendor/react.min.js"></script>
    <script src="${SDK_BASE}/lib/vendor/react-dom.min.js"></script>
    <script src="${SDK_BASE}/lib/vendor/redux.min.js"></script>
    <script src="${SDK_BASE}/lib/vendor/redux-thunk.min.js"></script>
    <script src="${SDK_BASE}/lib/vendor/lodash.min.js"></script>
    <script src="${SDK_BASE}/zoom-meeting-${SDK_VERSION}.min.js"></script>
    <script src="page.js"></script>
  </body>
</html>
`;

/**
 * Сценарий страницы: вход и всё, что Zoom отдаёт по API.
 *
 * Параметры приезжают в адресе — так их видно в логе браузера и не нужно
 * договариваться о ещё одном канале.
 */
export const ZOOM_PAGE_JS = `
(() => {
  const send = (type, data) => {
    try { window.__botSend(type, data); } catch (e) { /* канал ещё не готов */ }
  };
  const p = new URLSearchParams(location.search);

  ZoomMtg.preLoadWasm();
  ZoomMtg.prepareWebSDK();

  // Показать корень SDK.
  //
  // prepareWebSDK создаёт #zmmtg-root скрытым, и без этой строки клиент
  // рисуется «в никуда»: встреча идёт, а панели с кнопками нет. Микрофон
  // включается именно кнопкой — программного способа у клиентского вида нет, —
  // и первый живой заход 16.09.2026 кончился немым ботом ровно поэтому.
  const showRoot = () => {
    const root = document.getElementById('zmmtg-root');
    if (root) root.style.display = 'block';
  };
  showRoot();

  /** Кто есть кто: id → имя. Имена Zoom отдаёт сам, выдумывать не нужно. */
  const people = new Map();
  let myId = null;

  const nameOf = (data) => String(data.userName || data.displayName || data.name || 'участник');

  const whoAmI = () => {
    try {
      ZoomMtg.getCurrentUser({
        success: (r) => { myId = r?.result?.currentUser?.userId ?? null; },
        error: () => {},
      });
    } catch (e) { /* ещё не во встрече */ }
  };

  const publish = () => {
    // Свой id спрашиваем, пока не ответят: сразу после входа SDK его ещё не
    // знает, а без него бот считает участником самого себя.
    if (myId === null) whoAmI();
    const list = [];
    for (const [id, name] of people) {
      if (String(id) === String(myId)) continue;   // себя в состав не пишем
      list.push({ uuid: String(id), name });
    }
    send('participants', { people: list });
  };

  // Состав шлём и по событию, и раз в две секунды.
  //
  // Событие может не уйти наружу (мост CDP занят, вебхук не доехал), а полный
  // список сходится сам: сервис сверит его с тем, что подтвердил бэкенд.
  setInterval(publish, 2000);

  ZoomMtg.init({
    leaveUrl: 'https://zoom.us',
    patchJsMedia: true,
    leaveOnPageUnload: true,
    disableZoomLogo: true,
    disablePreview: true,
    success: () => {
      showRoot();
      ZoomMtg.join({
        signature: p.get('signature'),
        sdkKey: p.get('sdkKey'),
        meetingNumber: p.get('meetingNumber'),
        passWord: p.get('password') || '',
        userName: p.get('userName') || 'Ассистент',
        userEmail: '',
        success: () => { whoAmI(); send('sdk', { step: 'join принят' }); },
        error: (e) => send('join_failed', { reason: (e && (e.reason || e.errorCode)) || 'join error' }),
      });
    },
    error: (e) => send('join_failed', { reason: (e && (e.reason || e.message)) || 'init error' }),
  });

  // Мы ВНУТРИ встречи, а не в комнате ожидания.
  //
  // Признак неочевидный: 13-й уровень onJoinSpeed — «пользователь начал
  // подключать звук». Статус «connected» приходит и в комнате ожидания, и по
  // нему бот считал бы себя вошедшим, сидя в прихожей. Признак взят у
  // Attendee, где он отработал на живых встречах.
  ZoomMtg.inMeetingServiceListener('onJoinSpeed', (data) => {
    if (data && data.level === 13) {
      unmute();
      send('joined', {});
    }
  });

  // Статусы встречи: 1 — подключаемся, 2 — подключены, 3 — отключены,
  // 4 — переподключаемся. Пишем все: по ним видно, где именно нас потеряли.
  ZoomMtg.inMeetingServiceListener('onMeetingStatus', (data) => {
    send('sdk', { step: 'статус ' + (data && data.meetingStatus) });
    if (data && data.meetingStatus === 3) send('left', { reason: 'meeting_ended' });
  });

  // Уровни входа: 6 — комната ожидания, 13 — начали подключать звук.
  ZoomMtg.inMeetingServiceListener('onJoinSpeed', (data) => {
    if (data && (data.level === 6 || data.level === 13)) send('sdk', { step: 'вход, уровень ' + data.level });
  });

  ZoomMtg.inMeetingServiceListener('onUserJoin', (data) => {
    if (!data || !data.userId) return;
    people.set(data.userId, nameOf(data));
    publish();
  });

  ZoomMtg.inMeetingServiceListener('onUserLeave', (data) => {
    if (!data || !data.userId) return;
    people.delete(data.userId);
    publish();
  });

  ZoomMtg.inMeetingServiceListener('onReceiveChatMsg', (msg) => {
    try {
      const text = String(msg?.content?.text || '');
      if (!text) return;
      const id = msg?.senderId;
      // Своё же сообщение читать обратно незачем — ассистент решит, что с ним
      // заговорили, и ответит сам себе.
      if (String(id) === String(myId)) return;
      send('chat', { id: String(msg?.content?.messageId || ''), text, author: people.get(id) || 'участник' });
    } catch (e) { console.error('[бот] чат не разобрался', e); }
  });

  /**
   * Включить микрофон.
   *
   * Программного способа у клиентского вида нет — нажимаем ту же кнопку, что
   * и человек. Подпись для незрячих у неё стабильная, в отличие от классов.
   * Пробуем несколько раз: панель появляется не сразу после входа.
   */
  function unmute() {
    let left = 40;
    const timer = setInterval(() => {
      showRoot();
      const b =
        document.querySelector('button[aria-label="unmute my microphone"]') ||
        document.querySelector('div[aria-label="unmute my microphone"]');
      if (b) { b.click(); clearInterval(timer); send('mic', { on: true, how: 'кнопкой' }); return; }
      // Уже включён? Тогда на панели стоит обратная кнопка, и делать нечего.
      if (document.querySelector('[aria-label="mute my microphone"]')) {
        clearInterval(timer); send('mic', { on: true, how: 'уже был включён' }); return;
      }
      if (--left <= 0) {
        clearInterval(timer);
        // Последняя попытка — через API: в части сборок он есть, и хуже не
        // сделает. Ответ всё равно скажем честно.
        try {
          ZoomMtg.mute({ userId: myId, mute: false, success: () => send('mic', { on: true, how: 'по API' }), error: () => send('mic', { on: false }) });
        } catch (e) { send('mic', { on: false }); }
      }
    }, 500);
  }

  /** Написать в общий чат. Возвращает, приняла ли площадка сообщение. */
  window.__botSendChat = (text) => new Promise((resolve) => {
    try {
      ZoomMtg.sendChat({ message: String(text), success: () => resolve(true), error: () => resolve(false) });
    } catch (e) { resolve(false); }
  });

  /** Выйти из встречи по-человечески, а не закрытием браузера. */
  window.__botLeave = () => { try { ZoomMtg.leaveMeeting({}); } catch (e) { /* закроем браузер */ } };
})();
`;
