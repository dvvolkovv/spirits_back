/**
 * Спайк: может ли ассистент войти во встречу Яндекс Телемоста.
 *
 * Мост Attendee Телемост не умеет — в его исходниках нет ни одного упоминания
 * Яндекса. Прежде чем писать для него адаптер (а это новый компонент в форке,
 * который придётся вести самим), надо ответить на три вопроса. Спайк отвечает
 * ровно на них и больше ни на что:
 *
 *   1. ВХОД. Пускает ли по ссылке анонимно, даёт ли задать имя, есть ли
 *      комната ожидания — и как она выглядит со стороны бота.
 *   2. ВХОДЯЩИЙ ЗВУК. Отдаётся ли он странице так, чтобы его можно было снять.
 *      Смотрим на `ontrack` у RTCPeerConnection — тем же приёмом, которым
 *      Attendee снимает звук у Meet.
 *   3. ИСХОДЯЩИЙ ЗВУК — главный риск. Принимает ли Телемост подменённый
 *      микрофон: мы подсовываем `getUserMedia` синтезированную дорожку с
 *      тоном 440 Гц. Если тон слышен участникам — путь открыт; если нет,
 *      адаптер писать незачем, и остаётся телефонный дозвон.
 *
 * Почему тон, а не тишина: на Meet и Zoom мы дважды теряли заход на том, что
 * «всё отчиталось успехом», а звука не было. Слышимый человеком тон — это
 * единственная проверка, которую нельзя обмануть логами.
 *
 * ЗАПУСК на стенде:
 *   cd ~/spirits_back && node infra/attendee/telemost-spike.mjs '<ссылка>' [имя]
 *
 * Браузер берётся из Playwright, который на стенде уже стоит. Окно настоящее
 * (headless: false под Xvfb): у площадок бывает разное поведение в безголовом
 * режиме, и спайк не должен спорить ещё и с этим.
 */
import { chromium } from 'playwright';

const URL_ARG = process.argv[2];
const NAME = process.argv[3] || 'Роман · ассистент';
if (!URL_ARG) {
  console.error('нужна ссылка на встречу Телемоста');
  process.exit(1);
}

/** Сколько ждём событий после входа: хватает, чтобы хозяин успел впустить. */
const WATCH_MS = Number(process.env.TELEMOST_WATCH_MS || 180_000);

/**
 * Полезная нагрузка. Ставится ДО скриптов страницы: перехватывать
 * `getUserMedia` и `RTCPeerConnection` после их использования поздно.
 */
const PAYLOAD = `
(() => {
  const log = (...a) => console.log('[спайк]', ...a);

  // ── Исходящий звук: подменяем микрофон синтезированным тоном ──
  //
  // Точно так же это делает Attendee у Meet и Teams: приложение получает не
  // устройство, а дорожку из нашего аудиографа. Тон включаем не сразу, а
  // через десять секунд после входа: бот успевает оказаться во встрече, и
  // слышимый тон нельзя спутать со звуком страницы приветствия.
  let ctx = null, dest = null, osc = null, gain = null;
  function makeTrack() {
    if (dest) return dest.stream.getAudioTracks()[0].clone();
    ctx = new AudioContext();
    dest = ctx.createMediaStreamDestination();
    gain = ctx.createGain();
    gain.gain.value = 0;                 // молчим, пока не войдём
    osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(gain); gain.connect(dest);
    osc.start();
    setTimeout(() => {
      gain.gain.value = 0.25;
      log('ТОН ВКЛЮЧЁН — участники должны его услышать');
      setTimeout(() => { gain.gain.value = 0; log('тон выключен'); }, 20000);
    }, 10000);
    window.__spikeCtx = ctx;
    return dest.stream.getAudioTracks()[0].clone();
  }

  const origGum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async function (c) {
    log('страница просит устройства:', JSON.stringify({ audio: !!(c && c.audio), video: !!(c && c.video) }));
    const s = new MediaStream();
    if (c && c.audio) s.addTrack(makeTrack());
    if (c && c.video) {
      // Видео не подменяем: если оно понадобится, отдадим настоящую пустую
      // дорожку с холста — но сперва надо понять, спрашивают ли его вообще.
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const vt = canvas.captureStream(5).getVideoTracks()[0];
        s.addTrack(vt);
      } catch (e) { log('видео-дорожку сделать не вышло:', e.message); }
    }
    window.__spikeGum = (window.__spikeGum || 0) + 1;
    return s;
  };

  // ── Входящий звук: ловим дорожки участников ──
  const OrigPC = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...args) {
    const pc = Reflect.construct(OrigPC, args);
    (window.__spikePCs = window.__spikePCs || []).push(pc);
    pc.addEventListener('track', (ev) => {
      log('входящая дорожка:', ev.track.kind, ev.track.id.slice(0, 8), 'состояние', ev.track.readyState);
      window.__spikeIn = (window.__spikeIn || 0) + (ev.track.kind === 'audio' ? 1 : 0);
    });
    pc.addEventListener('connectionstatechange', () => log('соединение:', pc.connectionState));
    return pc;
  };
  window.RTCPeerConnection.prototype = OrigPC.prototype;

  log('нагрузка установлена');
})();
`;

/** Снимок того, что видно со стороны страницы. */
const PROBE = `(() => {
  const pcs = window.__spikePCs || [];
  const senders = [];
  for (const pc of pcs) {
    for (const s of (pc.getSenders ? pc.getSenders() : [])) {
      if (s.track && s.track.kind === 'audio') {
        senders.push({ label: s.track.label, enabled: s.track.enabled, muted: s.track.muted, state: s.track.readyState });
      }
    }
  }
  return {
    обращенийЗаУстройствами: window.__spikeGum || 0,
    соединений: pcs.length,
    состояния: pcs.map((p) => p.connectionState),
    входящихЗвуковыхДорожек: window.__spikeIn || 0,
    исходящиеДорожки: senders,
    состояниеАудиоГрафа: window.__spikeCtx ? window.__spikeCtx.state : null,
    заголовок: document.title,
    видимыйТекст: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400),
  };
})()`;

const run = async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--no-sandbox',
      '--use-fake-ui-for-media-stream',      // не спрашивать разрешений
      '--autoplay-policy=no-user-gesture-required',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    permissions: ['microphone', 'camera'],
    locale: 'ru-RU',
  });
  await ctx.addInitScript(PAYLOAD);
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[спайк]')) console.log(t);
  });

  console.log('открываю', URL_ARG);
  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(6_000);
  console.log('заголовок:', await page.title());

  // Имя и вход. Селекторы не угадываем заранее — печатаем, что нашли, и
  // пробуем по очереди: спайк на то и спайк, чтобы узнать разметку.
  const nameField = page.locator('input[type="text"], input[name*="name" i], input[placeholder*="мя" i]').first();
  if (await nameField.count().catch(() => 0)) {
    try { await nameField.fill(NAME, { timeout: 5_000 }); console.log('имя введено'); }
    catch (e) { console.log('имя ввести не удалось:', e.message); }
  } else {
    console.log('поля имени не нашлось');
  }

  const joinCandidates = [
    // Телемост подписывает кнопку «Подключиться» — проверено прогоном
    // 14.09.2026; остальные подписи оставлены запасом на другие экраны.
    'button:has-text("Подключиться")',
    '[role="button"]:has-text("Подключиться")',
    'button:has-text("Присоединиться")',
    'button:has-text("Продолжить")',
    'button:has-text("Войти")',
    '[role="button"]:has-text("Присоединиться")',
  ];
  for (const sel of joinCandidates) {
    const b = page.locator(sel).first();
    if (await b.count().catch(() => 0)) {
      try {
        await b.click({ timeout: 5_000 });
        console.log('нажал:', sel);
        break;
      } catch (e) { console.log('клик не прошёл:', sel, e.message); }
    }
  }

  const started = Date.now();
  while (Date.now() - started < WATCH_MS) {
    await page.waitForTimeout(15_000);
    const probe = await page.evaluate(PROBE).catch((e) => ({ ошибка: e.message }));
    console.log(new Date().toISOString().slice(11, 19), JSON.stringify(probe, null, 1));
  }

  await page.screenshot({ path: '/tmp/telemost-spike.png', fullPage: false }).catch(() => {});
  console.log('снимок экрана: /tmp/telemost-spike.png');
  await browser.close();
};

run().catch((e) => { console.error('спайк упал:', e); process.exit(1); });
