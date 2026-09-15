import { chromium } from 'playwright';
import WebSocket from 'ws';
import { TELEMOST_PAYLOAD, TELEMOST_JOIN } from './payload/telemost.mjs';
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

const PLATFORMS = {
  telemost: { payload: TELEMOST_PAYLOAD, join: TELEMOST_JOIN, name: 'Телемост' },
};

export class MeetingBot {
  constructor({ id, meetingUrl, displayName, platform, wsUrl, webhookUrl, webhookSecret, metadata, log = console }) {
    Object.assign(this, { id, meetingUrl, displayName, platform, wsUrl, webhookUrl, webhookSecret, metadata, log });
    this.state = 'ready';
    this.browser = null;
    this.page = null;
    this.ws = null;
    this.chatAuthors = new Map();
    /** Людей во встрече ПО ПОДТВЕРЖДЁННЫМ событиям, а не по площадке. */
    this.humans = 0;
    this.syncing = false;
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

      case 'participants':
        await this.syncParticipants(Number(data?.humans ?? 0));
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
  async syncParticipants(target) {
    if (this.syncing || target === this.humans) return;
    this.syncing = true;
    try {
      while (this.humans < target) {
        if (!(await this.participantEvent(this.humans + 1, 'join'))) return;
        this.humans++;
      }
      while (this.humans > target) {
        if (!(await this.participantEvent(this.humans, 'leave'))) return;
        this.humans--;
      }
      this.log.info?.(`[${this.id}] людей во встрече: ${this.humans}`);
    } finally {
      this.syncing = false;
    }
  }

  async participantEvent(index, kind) {
    return sendWebhook(this.webhookUrl, this.webhookSecret, event(this.id, this.metadata, 'participant_events.join_leave', {
      participant_name: `Участник ${index}`,
      participant_uuid: `participant-${index}`,
      event_type: kind,
      timestamp_ms: Date.now(),
    }), this.log);
  }

  // ── Жизненный цикл ──────────────────────────────────────────────────────

  async start() {
    const platform = PLATFORMS[this.platform];
    if (!platform) throw new Error(`площадка ${this.platform} не поддержана`);

    await this.setState('joining');
    this.browser = await chromium.launch({
      headless: false,
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
      ],
    });
    const ctx = await this.browser.newContext({ permissions: ['microphone', 'camera'], locale: 'ru-RU' });
    await ctx.exposeFunction('__botSend', (type, data) => { void this.onPageEvent(type, data); });
    await ctx.addInitScript(platform.payload);
    this.page = await ctx.newPage();

    await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await this.joinMeeting(platform.join);
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

    const name = await waitFor(sel.nameInput);
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
    while (Date.now() < deadline) {
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
    try { await this.page?.locator(PLATFORMS[this.platform].join.leaveButton).first().click({ timeout: 3_000 }); } catch { /* уйдём закрытием браузера */ }
    try { this.ws?.close(); } catch { /* уже закрыт */ }
    try { await this.browser?.close(); } catch (e) { this.log.warn?.(`[${this.id}] браузер не закрылся: ${e?.message}`); }
    if (this.state !== 'fatal_error') await this.setState('ended', { sub: 'left_meeting' });
  }
}
