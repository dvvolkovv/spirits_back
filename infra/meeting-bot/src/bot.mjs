import { chromium } from 'playwright';
import { cp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { TELEMOST_PAYLOAD, TELEMOST_JOIN } from './payload/telemost.mjs';
import { ZOOM_PAYLOAD } from './payload/zoom.mjs';
import { meetPayload, MEET_JOIN } from './payload/meet.mjs';
import { zoomPageOrigin, zoomPageUrl } from './zoom-page.mjs';
import { signZoomJoin, parseZoomUrl } from './zoom-jwt.mjs';
import { event, send as sendWebhook } from './webhooks.mjs';

/**
 * Одна встреча — один бот: браузер, страница площадки, вебсокет к воркеру и
 * вебхуки в бэкенд.
 *
 * Состояния повторяют Attendee (`joining`, `joined_recording`, `ended`,
 * `fatal_error`): по ним уже написаны и наш контроллер вебхуков, и разбор
 * причин в воркере. Менять их значило бы переписывать работающее ради вкуса.
 */

/** Частота звука в обе стороны. Родная для Realtime — ни одного ресемпла. */
const SAMPLE_RATE = 24_000;

/** Сколько ждём страницу и вход. */
const PAGE_TIMEOUT_MS = 60_000;

/** Пауза между входом во встречу и первым звуком: даём площадке разойтись. */
const JOIN_SETTLE_MS = Number(process.env.BOT_JOIN_SETTLE_MS || 2_500);

/** Сколько ждём впуска из комнаты ожидания, прежде чем сдаться с причиной. */
const ADMIT_TIMEOUT_MS = Number(process.env.BOT_ADMIT_TIMEOUT_MS || 900_000);

/**
 * Площадки и способ входа.
 *
 * Их ровно два, и разница принципиальная. В Телемост бот заходит как человек —
 * глазами по вёрстке, потому что другого входа нет. У Zoom есть официальный
 * Meeting SDK: там мы открываем СВОЮ страницу и зовём его API, а вёрстку не
 * трогаем вовсе.
 */
const PLATFORMS = {
  telemost: { payload: TELEMOST_PAYLOAD, join: TELEMOST_JOIN, name: 'Телемост' },
  meet: {
    payload: meetPayload,
    join: MEET_JOIN,
    name: 'Google Meet',
    channel: 'chrome',
    /**
     * Профиль с уже выполненным входом в аккаунт Google.
     *
     * Meet пускает анонимного бота только через проверку на человека, которую
     * мы обходить не стали (решение владельца 16.09.2026). Вошедшему под
     * учётной записью она не нужна вовсе — так же устроен и Attendee: при
     * входе с аккаунтом он сам переключается в «робототехнический» режим.
     *
     * Профиль заводится один раз руками (`google-login.sh`), пароль при этом
     * не попадает ни в .env, ни в код.
     */
    profile: process.env.MEET_PROFILE_DIR || join(homedir(), '.linkeon-meet-profile'),
    // Тот же довод, что у Zoom: без устройств в списке площадка считает, что
    // микрофона нет. Meet на экране входа показывает выбранный — «Fake Default
    // Audio Input», — и это признак, что звук он у нас возьмёт.
    chromeArgs: ['--use-fake-device-for-media-stream'],
    // Английский интерфейс — условие работы зацепок.
    //
    // Вход, чат и состав ищутся по подписям: «Ask to join», «Chat with
    // everyone», «People». С языком клиента они бы разъехались: бот, который
    // ходит на встречи у нас, падал бы у клиента с другой локалью. Имя бота при
    // этом остаётся русским — его вписываем мы сами.
    locale: 'en-US',
  },
  zoom: {
    payload: ZOOM_PAYLOAD,
    name: 'Zoom',
    viaSdk: true,
    // Фальшивое устройство — не для звука, а для СПИСКА устройств.
    //
    // Звук мы всё равно подменяем перехватом getUserMedia. Но у контейнера нет
    // ни одной звуковой карты, и `enumerateDevices()` возвращает пустоту —
    // SDK решает, что микрофона нет, и не начинает подключать звук. А именно
    // это и есть его признак входа во встречу (13-й уровень onJoinSpeed), без
    // которого бот вечно ждёт впуска. Тот же флаг стоит у Attendee.
    chromeArgs: ['--use-fake-device-for-media-stream'],
  },
};

export class MeetingBot {
  constructor({ id, meetingUrl, displayName, platform, wsUrl, webhookUrl, webhookSecret, metadata, log = console }) {
    Object.assign(this, { id, meetingUrl, displayName, platform, wsUrl, webhookUrl, webhookSecret, metadata, log });
    this.state = 'ready';
    this.browser = null;
    this.ctx = null;
    /** Временная копия профиля Chrome, если площадка ходит под аккаунтом. */
    this.profileCopy = null;
    this.page = null;
    this.ws = null;
    this.chatAuthors = new Map();
    /** Кто во встрече ПО ПОДТВЕРЖДЁННЫМ событиям, а не по площадке: uuid → имя. */
    this.people = new Map();
    this.syncing = false;
    /** Разрешается, когда мы действительно вошли; отвергается — когда не вышло. */
    this.entered = null;
    this.closed = false;
  }

  /** Сообщить бэкенду о смене состояния. Форма — как у Attendee. */
  async setState(state, { sub } = {}) {
    if (this.state === state) return;
    const old = this.state;
    this.state = state;
    this.log.info?.(`[${this.id}] состояние: ${old} → ${state}${sub ? ` (${sub})` : ''}`);
    await sendWebhook(this.webhookUrl, this.webhookSecret, event(this.id, this.metadata, 'bot.state_change', {
      new_state: state,
      old_state: old,
      ...(sub ? { event_type: sub, event_sub_type: null } : {}),
    }), this.log);
  }

  // ── Звук ────────────────────────────────────────────────────────────────

  /**
   * Вебсокет к воркеру.
   *
   * Переподключаемся молча и настойчиво: обрыв посреди встречи — обычное дело,
   * а воркер держит место за нами полторы минуты (см. `attendee-audio.ts`).
   * Сдаёмся только вместе с самим ботом.
   */
  connectAudio() {
    if (this.closed || !this.wsUrl) return;
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;
    ws.on('open', () => this.log.info?.(`[${this.id}] звук: подключились к воркеру`));
    ws.on('message', (raw) => this.playFromWorker(raw));
    ws.on('error', (e) => this.log.warn?.(`[${this.id}] звук: ${e?.message}`));
    ws.on('close', () => {
      if (this.closed) return;
      this.log.warn?.(`[${this.id}] звук: связь потеряна, переподключаемся`);
      setTimeout(() => this.connectAudio(), 2_000);
    });
  }

  /** Кусок голоса ассистента — в страницу. */
  async playFromWorker(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.trigger !== 'realtime_audio.bot_output' || !msg.data?.chunk) return;
    // Строку отдаём страницу как есть: разбор PCM дешевле сделать там, чем
    // гнать через мост CDP массив чисел.
    try {
      await this.page?.evaluate((chunk) => window.__botPlayPcm?.(chunk), msg.data.chunk);
    } catch (e) {
      // Страница могла уйти — это не повод рушить встречу.
      this.log.warn?.(`[${this.id}] голос не доиграл: ${e?.message}`);
    }
  }

  /** Звук встречи — воркеру. Страница уже отдала готовый PCM16 в base64. */
  sendAudio(chunk) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      trigger: 'realtime_audio.mixed',
      data: { chunk, sample_rate: SAMPLE_RATE },
    }));
  }

  // ── События страницы ────────────────────────────────────────────────────

  async onPageEvent(type, data) {
    switch (type) {
      case 'audio':
        this.sendAudio(String(data));
        break;

      case 'participants': {
        // Телемост умеет только сосчитать людей — имён в его разметке нет.
        // Zoom отдаёт имена, и их мы доносим до ассистента как есть.
        const list = Array.isArray(data?.people)
          ? data.people.map((x) => ({ uuid: String(x.uuid), name: String(x.name || 'участник') }))
          : Array.from({ length: Number(data?.humans ?? 0) }, (_, i) => ({
              uuid: `participant-${i + 1}`,
              name: `Участник ${i + 1}`,
            }));
        await this.syncParticipants(list);
        break;
      }

      case 'joined':
        this.entered?.resolve();
        break;

      case 'join_failed':
        this.entered?.reject(new Error(String(data?.reason || 'вход отклонён')));
        break;

      case 'left':
        this.log.info?.(`[${this.id}] встреча закончилась: ${data?.reason || 'без причины'}`);
        await this.stop();
        break;

      case 'chat_probe':
        // Лента чата не нашлась ни одной зацепкой. Страница отдаёт кусок своей
        // разметки — чтобы вторую редакцию селекторов писать по факту, а не по
        // догадке. Приходит один раз за встречу.
        this.log.warn?.(`[${this.id}] чат не разобрался, разметка панели: ${String(data?.html || '').slice(0, 1200)}`);
        break;

      case 'sdk':
        this.log.info?.(`[${this.id}] Zoom: ${data?.step}`);
        break;

      case 'mic':
        this.log.info?.(`[${this.id}] микрофон ${data?.on ? `включён (${data.how})` : 'включить не вышло'}`);
        break;

      case 'chat': {
        const author = String(data?.author || 'участник');
        if (!this.chatAuthors.has(author)) this.chatAuthors.set(author, `chat-${this.chatAuthors.size + 1}`);
        await sendWebhook(this.webhookUrl, this.webhookSecret, event(this.id, this.metadata, 'chat_messages.update', {
          text: String(data?.text || ''),
          sender_name: author,
          sender_uuid: this.chatAuthors.get(author),
          to: 'everyone',
          timestamp: Math.floor(Date.now() / 1000),
        }), this.log);
        this.log.info?.(`[${this.id}] чат: ${author}: ${String(data?.text || '').slice(0, 60)}`);
        break;
      }

      case 'ready':
        this.log.info?.(`[${this.id}] сценарий страницы в кадре ${data?.url}`);
        break;

      case 'tracks':
        this.log.info?.(`[${this.id}] дорожек участников: ${data?.count}`);
        break;

      default:
        break;
    }
  }

  /**
   * Довести состав у бэкенда до того, что показывает площадка.
   *
   * Состав уходит наружу событиями входа и ухода — их ждёт наш контроллер, и
   * другого способа рассказать о людях у нас нет. Но поток разниц по
   * ненадёжному каналу расходится с правдой НАВСЕГДА: потерянный «пришёл» сам
   * собой не повторится, и ассистент до конца встречи считает, что он наедине
   * (живая встреча 15.09.2026 — ровно такой потерянный вебхук).
   *
   * Поэтому счётчик двигаем только за подтверждёнными событиями, а страница
   * присылает состав каждые две секунды. Не дошло — на следующем тике
   * попробуем снова, и расхождение зарастёт само.
   */
  async syncParticipants(list) {
    if (this.syncing) return;
    const want = new Map(list.map((x) => [x.uuid, x.name]));
    this.syncing = true;
    try {
      for (const [uuid, name] of want) {
        if (this.people.has(uuid)) continue;
        if (!(await this.participantEvent(uuid, name, 'join'))) return;
        this.people.set(uuid, name);
        this.log.info?.(`[${this.id}] пришёл: ${name} (всего ${this.people.size})`);
      }
      for (const [uuid, name] of [...this.people]) {
        if (want.has(uuid)) continue;
        if (!(await this.participantEvent(uuid, name, 'leave'))) return;
        this.people.delete(uuid);
        this.log.info?.(`[${this.id}] ушёл: ${name} (всего ${this.people.size})`);
      }
    } finally {
      this.syncing = false;
    }
  }

  async participantEvent(uuid, name, kind) {
    return sendWebhook(this.webhookUrl, this.webhookSecret, event(this.id, this.metadata, 'participant_events.join_leave', {
      participant_name: name,
      participant_uuid: uuid,
      event_type: kind,
      timestamp_ms: Date.now(),
    }), this.log);
  }

  /**
   * Написать в общий чат встречи. `false` — площадка не приняла.
   *
   * Отказ штатен и важен: ассистент обязан сказать вслух, что написать не
   * вышло, а не сделать вид, что написал. У Телемоста писать нечем вовсе —
   * гостю площадка показывает «Войдите, чтобы написать сообщение».
   */
  async sendChat(text) {
    if (!this.page) return false;
    try {
      // Умеет ли площадка писать, знает её сценарий страницы: у кого есть
      // `__botSendChat` — тот и пишет. У Телемоста его нет вовсе, и отказ здесь
      // штатный, а не поломка.
      return !!(await this.page.evaluate((t) => window.__botSendChat?.(t), String(text)));
    } catch (e) {
      this.log.warn?.(`[${this.id}] в чат не написалось: ${e?.message}`);
      return false;
    }
  }

  // ── Жизненный цикл ──────────────────────────────────────────────────────

  async start() {
    const platform = PLATFORMS[this.platform];
    if (!platform) throw new Error(`площадка ${this.platform} не поддержана`);

    await this.setState('joining');
    // Как поднимается браузер — общее для обоих случаев.
    const launch = {
      headless: false,
      // Настоящий Chrome, если площадка просит.
      //
      // Meet различает браузеры: Chromium из Playwright он не пускает дальше
      // экрана входа — стук до хозяина не доходит вовсе (16.09.2026). Attendee
      // всё это время водил установленный Chrome, и разница оказалась в нём.
      // Остальным площадкам Chromium годится, и лишней зависимости им не надо.
      ...(platform.channel ? { channel: platform.channel } : {}),
      // Не представляться автоматикой.
      //
      // Playwright объявляет себя сам: флаг `--enable-automation` и свойство
      // `navigator.webdriver`. Убираем и то, и другое — у Attendee ровно
      // поэтому стоит тот же флаг блинка. Площадкам, где нас и так пускают,
      // это не мешает: одно поведение на всех вместо ветки на каждую.
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--no-sandbox',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-dev-shm-usage',
        // Изоляция сайтов выключена намеренно: чат Телемоста живёт в кадре
        // другого происхождения, и со включённой изоляцией наш сценарий туда
        // не попадает вовсе. Браузер бота открывает единственную страницу —
        // встречу, куда его позвали.
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        ...(platform.chromeArgs || []),
      ],
    };
    const context = {
      permissions: ['microphone', 'camera'],
      locale: platform.locale || 'ru-RU',
    };

    let ctx;
    if (platform.profile) {
      // Работаем на КОПИИ профиля, а не на нём самом.
      //
      // Chrome держит на профиле замок: второй бот с тем же каталогом не
      // поднимется вовсе. А ещё встреча не должна портить то, что владелец
      // заводил руками, — куки останутся такими же, какими он их оставил.
      this.profileCopy = join(tmpdir(), `meeting-bot-${this.id}`);
      await cp(platform.profile, this.profileCopy, { recursive: true });
      ctx = await chromium.launchPersistentContext(this.profileCopy, { ...launch, ...context, viewport: null });
    } else {
      this.browser = await chromium.launch(launch);
      ctx = await this.browser.newContext(context);
    }
    this.ctx = ctx;

    await ctx.addInitScript(() => {
      // Вторая половина того же: флаг убран при запуске, свойство — здесь.
      try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) { /* уже переопределено */ }
    });
    await ctx.exposeFunction('__botSend', (type, data) => { void this.onPageEvent(type, data); });
    // Площадке может понадобиться имя бота внутри страницы — тогда нагрузка
    // приезжает функцией, а не строкой.
    await ctx.addInitScript(
      typeof platform.payload === 'function' ? platform.payload(this.displayName) : platform.payload,
    );
    // У профильного запуска одна вкладка уже открыта — берём её, иначе пустая
    // так и останется висеть рядом.
    this.page = ctx.pages()[0] || (await ctx.newPage());

    // Консоль страницы — в наш лог.
    //
    // У Zoom это единственный способ узнать, ПОЧЕМУ не пустили: код отказа SDK
    // печатает в консоль и наружу через колбэки не отдаёт (тем же приёмом
    // ловит его Attendee). Шумные уровни отбрасываем, иначе лог утонет в
    // отладке самого SDK.
    this.page.on('console', (m) => {
      const t = m.type();
      if (t !== 'error' && t !== 'warning') return;
      const text = m.text().slice(0, 300);
      if (/favicon|Download the React DevTools|deprecated/i.test(text)) return;
      this.log.warn?.(`[${this.id}] страница: ${text}`);
    });
    this.page.on('pageerror', (e) => this.log.warn?.(`[${this.id}] страница упала: ${e?.message}`));

    if (platform.viaSdk) {
      await this.joinViaSdk();
      return;
    }
    await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await this.joinMeeting(platform.join);
  }

  /**
   * Вход в Zoom: своя страница, подписанный JWT и события SDK.
   *
   * Ждём не вёрстку, а сигнал самой площадки. «Вошёл» тут — не «страница
   * загрузилась»: статус connected приходит и в комнате ожидания, поэтому
   * страница сообщает о входе только на 13-м уровне onJoinSpeed, когда Zoom
   * начал подключать звук.
   */
  async joinViaSdk() {
    const meeting = parseZoomUrl(this.meetingUrl);
    if (!meeting) throw new Error('не разобрал ссылку Zoom');
    const { signature, sdkKey } = signZoomJoin({
      clientId: process.env.ZOOM_SDK_CLIENT_ID,
      clientSecret: process.env.ZOOM_SDK_CLIENT_SECRET,
      meetingNumber: meeting.meetingNumber,
    });

    const entered = new Promise((resolve, reject) => { this.entered = { resolve, reject }; });
    const base = await zoomPageOrigin();
    await this.page.goto(
      zoomPageUrl(base, { signature, sdkKey, meetingNumber: meeting.meetingNumber, password: meeting.password, userName: this.displayName }),
      { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS },
    );
    this.log.info?.(`[${this.id}] Zoom: страница SDK открыта, встреча ${meeting.meetingNumber}`);

    let timer;
    const waited = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('во встречу так и не пустили')), ADMIT_TIMEOUT_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([entered, waited]);
    } catch (e) {
      await this.snapshot(e?.message || 'вход не удался');
      await this.setState('fatal_error', { sub: 'request_to_join_denied' });
      await this.stop();
      return;
    } finally {
      clearTimeout(timer);
      this.entered = null;
    }

    this.log.info?.(`[${this.id}] мы во встрече`);
    await this.setState('joined_recording');
    await this.page.waitForTimeout(JOIN_SETTLE_MS);
    this.connectAudio();
  }

  async joinMeeting(sel) {
    /**
     * Дождаться элемента, а не спросить о нём один раз.
     *
     * Первая редакция брала `count()` сразу после загрузки — и не находила
     * ничего: страница встречи рисует экран входа уже после
     * `domcontentloaded`, и в логе оставалось молчание вместо «имя введено».
     * Ждём явно и недолго; не дождались — идём дальше, шаг может быть
     * необязательным (камеры может не быть вовсе).
     */
    const waitFor = async (selector, timeout = 30_000) => {
      const el = this.page.locator(selector).first();
      try { await el.waitFor({ state: 'visible', timeout }); return el; }
      catch { return null; }
    };

    /**
     * Клик — сперва настоящий, при отказе скриптом.
     *
     * Телемост рисует экран до входа модальным окном, и обёртка этого окна
     * перекрывает собственную кнопку «Подключиться»: Playwright проверяет, кто
     * лежит сверху, и отказывается кликать (живой прогон 15.09.2026). Selenium
     * такой проверки не делал — поэтому адаптер на Attendee входил без правок.
     * Скриптовый клик до элемента доходит всегда; настоящий пробуем первым,
     * потому что он честнее воспроизводит поведение человека.
     */
    const click = async (selector, what, timeout = 10_000) => {
      const el = await waitFor(selector, timeout);
      if (!el) { this.log.info?.(`[${this.id}] ${what}: элемента нет, пропускаем`); return false; }
      try { await el.click({ timeout: 5_000 }); this.log.info?.(`[${this.id}] ${what}`); return true; }
      catch (e) { this.log.info?.(`[${this.id}] ${what}: клик перехвачен, пробуем скриптом`); }
      try { await el.evaluate((node) => node.click()); this.log.info?.(`[${this.id}] ${what} (скриптом)`); return true; }
      catch (e) { this.log.warn?.(`[${this.id}] ${what}: ${e?.message}`); return false; }
    };

    // Имени может не быть вовсе.
    //
    // Под учётной записью Google его не спрашивает — берёт из аккаунта, и
    // ждать поле тридцать секунд незачем: экран входа к этому времени давно
    // нарисован. Тот же вывод и у Attendee: «signed in bot, name input is not
    // present — assuming we don't need to fill it out».
    const name = await waitFor(sel.nameInput, 8_000);
    if (name) {
      await name.fill(this.displayName).catch(() => {});
      this.log.info?.(`[${this.id}] имя введено`);
    } else {
      this.log.warn?.(`[${this.id}] поля имени не дождались`);
    }
    await click(sel.cameraOff, 'камера выключена', 5_000);
    await click(sel.joinButton, 'нажата кнопка входа', 30_000);

    // Ждём панель встречи. Пока её нет — мы либо в комнате ожидания, либо
    // площадка ещё думает; отличить одно от другого со стороны бота нельзя,
    // поэтому просто ждём до потолка и тогда называем причину.
    const deadline = Date.now() + ADMIT_TIMEOUT_MS;
    let announced = false;
    while (Date.now() < deadline) {
      // Прихожая важнее признака входа.
      //
      // У Meet кнопки чата и выхода есть и там, поэтому сначала спрашиваем, не
      // ждём ли мы впуска, и только потом верим признаку. Иначе бот объявляет
      // себя вошедшим, стоя за дверью, — и воркер начинает говорить в пустоту.
      const waiting = sel.waitingRoom
        ? await this.page.locator(sel.waitingRoom).first().count().catch(() => 0)
        : 0;
      if (waiting) {
        if (!announced) { this.log.info?.(`[${this.id}] ждём, пока впустят`); announced = true; }
        await this.page.waitForTimeout(2_000);
        continue;
      }
      if (await this.page.locator(sel.inMeeting).first().count().catch(() => 0)) {
        this.log.info?.(`[${this.id}] мы во встрече`);
        await click(sel.chatButton, 'панель чата открыта');
        await this.setState('joined_recording');
        // Только теперь зовём воркера.
        //
        // Воркер ждёт нашего вебсокета и с первым же байтом начинает
        // приветствие. Пока мы подключались при создании бота, ассистент
        // здоровался, стоя на экране входа, и человек слышал фразу с середины
        // (живая встреча 15.09.2026). Пауза сверх того — на то, чтобы
        // площадка донесла нашу дорожку до остальных.
        await this.page.waitForTimeout(JOIN_SETTLE_MS);
        this.connectAudio();
        return;
      }
      await this.page.waitForTimeout(2_000);
    }
    await this.snapshot('не впустили');
    await this.setState('fatal_error', { sub: 'request_to_join_denied' });
    await this.stop();
  }

  /**
   * Снимок экрана бота.
   *
   * Отлаживать вход вслепую дорого: первая же осечка стоила нам прогона,
   * который ничего не сказал, кроме «дальше тишина». Снимок кладём рядом с
   * логом, ошибку глотаем — диагностика не повод рушить встречу.
   */
  async snapshot(why) {
    const path = `/tmp/meeting-bot-${this.id}.png`;
    try {
      await this.page?.screenshot({ path, fullPage: false });
      this.log.warn?.(`[${this.id}] ${why}: снимок экрана ${path}`);
    } catch (e) {
      this.log.warn?.(`[${this.id}] снимок не сделался: ${e?.message}`);
    }
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    try {
      if (PLATFORMS[this.platform]?.viaSdk) await this.page?.evaluate(() => window.__botLeave?.());
      else await this.page?.locator(PLATFORMS[this.platform].join.leaveButton).first().click({ timeout: 3_000 });
    } catch { /* уйдём закрытием браузера */ }
    try { this.ws?.close(); } catch { /* уже закрыт */ }
    try {
      if (this.browser) await this.browser.close();
      else await this.ctx?.close();
    } catch (e) { this.log.warn?.(`[${this.id}] браузер не закрылся: ${e?.message}`); }
    // Копию профиля убираем за собой: в ней куки живого аккаунта.
    if (this.profileCopy) {
      await rm(this.profileCopy, { recursive: true, force: true })
        .catch((e) => this.log.warn?.(`[${this.id}] копия профиля осталась: ${e?.message}`));
    }
    if (this.state !== 'fatal_error') await this.setState('ended', { sub: 'left_meeting' });
  }
}
