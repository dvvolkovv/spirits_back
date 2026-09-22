import './env.mjs';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { MeetingBot } from './bot.mjs';
import { platformFor } from './platform-url.mjs';

/**
 * HTTP-обёртка над ботами.
 *
 * Контракт намеренно повторяет Attendee: `POST /api/v1/bots`,
 * `POST /api/v1/bots/{id}/leave`, `GET /api/v1/bots/{id}` и ключ в заголовке
 * `Authorization: Token <ключ>`. Благодаря этому наш `AttendeeClient` работает
 * с этим сервисом без единой правки — достаточно направить на него адрес.
 */

const PORT = Number(process.env.MEETING_BOT_PORT || 8180);

/**
 * Ключ доступа. Без него сервис не поднимается: он умеет заводить браузеры в
 * чужих встречах, и открытым его оставлять нельзя.
 */
const API_KEY = process.env.MEETING_BOT_API_KEY || '';

/** Секрет подписи вебхуков — тот же, что проверяет бэкенд. */
const WEBHOOK_SECRET = process.env.MEETING_BOT_WEBHOOK_SECRET || process.env.ATTENDEE_WEBHOOK_SECRET || '';


const bots = new Map();

const log = {
  info: (...a) => console.log(new Date().toISOString().slice(11, 19), ...a),
  warn: (...a) => console.warn(new Date().toISOString().slice(11, 19), ...a),
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

function view(bot) {
  return { id: bot.id, meeting_url: bot.meetingUrl, state: bot.state, metadata: bot.metadata ?? null };
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}

const server = http.createServer(async (req, res) => {
  // Ключ проверяем до всего: ошибка в маршруте не должна давать подсказок о
  // том, что здесь вообще есть.
  const auth = req.headers.authorization || '';
  if (!API_KEY || auth !== `Token ${API_KEY}`) return json(res, 401, { error: 'unauthorized' });

  const url = new URL(req.url, 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);

  // POST /api/v1/bots
  if (req.method === 'POST' && parts.join('/') === 'api/v1/bots') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid json' });

    const meetingUrl = String(body.meeting_url || '');
    const platform = platformFor(meetingUrl);
    if (!platform) return json(res, 400, { error: 'unsupported meeting url' });

    // Префикс `mb_` — не украшение: по нему клиент бэкенда понимает, куда
    // слать `leave` и отправку в чат, зная один лишь идентификатор.
    const id = `mb_${randomBytes(8).toString('hex')}`;
    const bot = new MeetingBot({
      id,
      meetingUrl,
      displayName: String(body.bot_name || 'Ассистент'),
      platform,
      wsUrl: body.websocket_settings?.audio?.url || '',
      webhookUrl: body.webhooks?.[0]?.url || '',
      webhookSecret: WEBHOOK_SECRET,
      metadata: body.metadata ?? null,
      // Токен входа Zoom от бэкенда: одноразовый, живёт ровно до входа.
      obfToken: body.zoom_settings?.obf_token || '',
      log,
    });
    bots.set(id, bot);

    // Отвечаем сразу, не дожидаясь входа: вход занимает от секунд до минут
    // (комната ожидания), а вызывающий должен получить id немедленно — так же
    // ведёт себя Attendee, и на этом построена наша логика ожидания звука.
    bot.start().catch(async (e) => {
      log.warn(`[${id}] вход не удался: ${e?.message}`);
      await bot.setState('fatal_error', { sub: 'could_not_join_meeting' });
      await bot.stop().catch(() => {});
    });

    return json(res, 201, view(bot));
  }

  // POST /api/v1/bots/{id}/leave
  if (req.method === 'POST' && parts.length === 5 && parts[3] && parts[4] === 'leave') {
    const bot = bots.get(parts[3]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    await bot.stop().catch(() => {});
    bots.delete(bot.id);
    return json(res, 200, view(bot));
  }

  // POST /api/v1/bots/{id}/send_chat_message
  if (req.method === 'POST' && parts.length === 5 && parts[3] && parts[4] === 'send_chat_message') {
    const bot = bots.get(parts[3]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    const body = await readBody(req);
    if (!body) return json(res, 400, { error: 'invalid json' });
    const ok = await bot.sendChat(String(body.message || ''));
    // Отказ отдаём кодом, а не полем: клиент бэкенда смотрит именно на статус,
    // и ассистент по нему честно скажет, что написать не вышло.
    return ok ? json(res, 200, { ok: true }) : json(res, 400, { error: 'chat not sent' });
  }

  // GET /api/v1/bots/{id}/chat-sample — кусок разметки ленты чата.
  //
  // Не часть договора с бэкендом, а инструмент отладки: разметку площадок
  // приходится разбирать на живых встречах, и вытащить её из работающего бота
  // дешевле, чем заходить рядом вторым браузером.
  if (req.method === 'GET' && parts.length === 5 && parts[3] && parts[4] === 'chat-sample') {
    const bot = bots.get(parts[3]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    return json(res, 200, { html: await bot.chatSample() });
  }

  // GET /api/v1/bots/{id}
  if (req.method === 'GET' && parts.length === 4 && parts[3]) {
    const bot = bots.get(parts[3]);
    if (!bot) return json(res, 404, { error: 'bot not found' });
    return json(res, 200, view(bot));
  }

  return json(res, 404, { error: 'not found' });
});

if (!API_KEY) {
  console.error('MEETING_BOT_API_KEY не задан — сервис не поднимается');
  process.exit(1);
}

server.listen(PORT, () => log.info(`meeting-bot слушает :${PORT}`));

// Уходим по-человечески: иначе браузеры останутся сидеть в чужих встречах.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    log.info(`получен ${sig}, выводим ботов из встреч: ${bots.size}`);
    await Promise.allSettled([...bots.values()].map((b) => b.stop()));
    process.exit(0);
  });
}
