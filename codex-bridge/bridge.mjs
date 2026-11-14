import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { translateRequest } from './translate.mjs';
import { assembleMessage, createAnthropicStream, createSseParser } from './sse.mjs';

export const DEFAULT_BODY_LIMIT = 100 * 1024 * 1024;
export const DEFAULT_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
export const DEFAULT_UPSTREAM = 'https://chatgpt.com/backend-api/codex';
export const DEFAULT_BRIDGE_MODEL = 'gpt-6-astra';
export const DEFAULT_LOG_PATH = path.join(os.homedir(), '.linkeon', 'logs', 'codex-bridge.log');
// User-Agent сверен с реальным Codex CLI: 0.154.0 — закреплённый пин пакета
// @openai/codex (runbook выката). Серверы Linkeon — Linux x86_64; значение
// для Linux вводится диффом 3 (Task 5), до него — значение мака.
export const UPSTREAM_UA = process.env.CODEX_BRIDGE_UA
  ?? 'codex_cli_rs/0.154.0 (MacOS 25.6.0; arm64)';

// --- Хелперы, инлайнные из ~/.linkeon/tools/claude-model-router.mjs ---
// (на серверах роутера нет; мост обязан быть самодостаточным)

function safeLogEvent(event = {}) {
  const safe = { time: event.time ?? new Date().toISOString() };
  for (const field of ['id', 'type', 'route', 'model', 'status', 'error']) {
    if (event[field] !== undefined) safe[field] = event[field];
  }
  return safe;
}

export function sendJson(res, status, payload) {
  if (res.writableEnded || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function errorEnvelope(type, message) {
  return { type: 'error', error: { type, message } };
}

export function sendError(res, status, type, message) {
  sendJson(res, status, errorEnvelope(type, message));
}

export function readBody(req, bodyLimit) {
  const declaredLength = Number(req.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
    req.on('error', () => {});
    req.resume();
    return Promise.resolve({ tooLarge: true });
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > bodyLimit) {
        tooLarge = true;
        chunks.length = 0;
        settle({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({
      tooLarge,
      body: tooLarge ? null : Buffer.concat(chunks),
    }));
    req.on('error', () => {
      if (!settled) {
        settled = true;
        reject(Object.assign(new Error('Request read failed'), { safeType: 'request_read' }));
      }
    });
  });
}

export function createFileLogger(filePath = DEFAULT_LOG_PATH) {
  const parent = path.dirname(filePath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  const fd = openSync(filePath, 'a', 0o600);
  chmodSync(filePath, 0o600);
  let closed = false;
  const logger = (event) => {
    if (closed) return;
    appendFileSync(fd, `${JSON.stringify(safeLogEvent(event))}\n`);
  };
  logger.close = () => {
    if (closed) return;
    closed = true;
    closeSync(fd);
  };
  return logger;
}

export function isMain(metaUrl = import.meta.url, argvPath = process.argv[1]) {
  return Boolean(argvPath) && fileURLToPath(metaUrl) === path.resolve(argvPath);
}

export function loadCodexAuth(authPath = DEFAULT_AUTH_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(authPath, 'utf8'));
    const tokens = parsed?.tokens;
    if (tokens && typeof tokens.access_token === 'string' && tokens.access_token) {
      return {
        accessToken: tokens.access_token,
        accountId: typeof tokens.account_id === 'string' ? tokens.account_id : '',
      };
    }
  } catch {
    // нет файла/не JSON — считаем, что аутентификации нет
  }
  return null;
}

// Сбой записи лога (ENOSPC/EIO) не должен рвать запрос или процесс —
// тот же принцип, что в роутере: логирование best-effort.
function emit(log, event) {
  try {
    log(event);
  } catch {
    // Runtime logging is best-effort and must not interrupt a request.
  }
}

export function createBridge({
  upstream = DEFAULT_UPSTREAM,
  authPath = DEFAULT_AUTH_PATH,
  model = DEFAULT_BRIDGE_MODEL,
  reasoningEffort = 'medium',
  log = () => {},
  bodyLimit = DEFAULT_BODY_LIMIT,
} = {}) {
  const server = http.createServer(async (req, res) => {
    const id = randomUUID();
    let clientGone = false;
    try {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : 0;
      const expectedHost = `127.0.0.1:${port}`;
      if (req.headers.host !== expectedHost) {
        sendError(res, 421, 'misdirected_request', 'Loopback Host required');
        emit(log, { id, type: 'response', route: 'host-check', status: 421 });
        return;
      }
      const origin = req.headers.origin;
      const fetchSite = req.headers['sec-fetch-site'];
      if ((origin !== undefined && origin !== `http://${expectedHost}`)
        || (typeof fetchSite === 'string' && fetchSite.toLowerCase() === 'cross-site')) {
        sendError(res, 403, 'forbidden_origin', 'Cross-site request forbidden');
        emit(log, { id, type: 'response', route: 'origin-check', status: 403 });
        return;
      }
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        sendError(res, 400, 'bad_request', 'Bad request');
        return;
      }
      const requestPath = url.pathname;
      if (req.method === 'GET' && requestPath === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'HEAD' && requestPath === '/api/hello') {
        res.writeHead(200);
        res.end();
        return;
      }
      if (req.method !== 'POST'
        || (requestPath !== '/v1/messages' && requestPath !== '/v1/messages/count_tokens')) {
        sendError(res, 404, 'not_found', 'Not found');
        return;
      }
      const contentType = req.headers['content-type'];
      if (typeof contentType !== 'string'
        || contentType.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        sendError(res, 415, 'unsupported_media_type', 'application/json required');
        return;
      }

      const incoming = await readBody(req, bodyLimit);
      if (incoming.tooLarge) {
        sendError(res, 413, 'body_too_large', 'Request body too large');
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(incoming.body.toString('utf8'));
      } catch {
        sendError(res, 400, 'invalid_json', 'Malformed JSON');
        return;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        sendError(res, 400, 'invalid_request', 'JSON object required');
        return;
      }

      if (requestPath === '/v1/messages/count_tokens') {
        const approx = Math.max(1, Math.ceil(incoming.body.length / 4));
        emit(log, { id, type: 'response', route: 'count_tokens', status: 200 });
        sendJson(res, 200, { input_tokens: approx });
        return;
      }

      const auth = loadCodexAuth(authPath);
      if (!auth) {
        emit(log, { id, type: 'error', route: 'codex', model, status: 401, error: 'auth_missing' });
        sendError(res, 401, 'codex_auth_missing',
          'Codex auth unavailable: open the Codex app (or run codex login) once to refresh login');
        return;
      }

      const payload = translateRequest(parsed, { model, reasoningEffort });
      const target = new URL(`${upstream.replace(/\/+$/, '')}/responses`);
      const transport = target.protocol === 'https:' ? https : http;
      const upstreamRequest = transport.request(target, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          authorization: `Bearer ${auth.accessToken}`,
          ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
          'openai-beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          'user-agent': UPSTREAM_UA,
          session_id: randomUUID(),
        },
        agent: false,
      }, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;
        if (status !== 200) {
          const chunks = [];
          let collected = 0;
          upstreamRes.on('data', (c) => {
            if (collected < 4096) { chunks.push(c); collected += c.length; }
          });
          upstreamRes.on('end', () => {
            let message = `Upstream status ${status}`;
            try {
              const e = JSON.parse(Buffer.concat(chunks).toString('utf8'));
              if (typeof e?.error?.message === 'string') message = e.error.message.slice(0, 300);
              else if (typeof e?.message === 'string') message = e.message.slice(0, 300);
            } catch {
              // оставляем дефолтное сообщение; тело upstream не логируем
            }
            if (status === 401) {
              message = `Codex token rejected: open the Codex app once to refresh login (${message})`;
            }
            emit(log, { id, type: 'error', route: 'codex', model, status, error: 'upstream_status' });
            sendError(res, status, 'upstream_error', message);
          });
          upstreamRes.on('error', () => {
            if (!res.writableEnded && !res.destroyed) sendError(res, 502, 'bad_gateway', 'Upstream read failed');
          });
          return;
        }

        // stream:false (Claude Code не использует, но контракт Anthropic требует):
        // upstream всё равно стримится, фреймы копятся и собираются в один JSON.
        // При отсутствующем поле stream мост отвечает SSE — осознанное отклонение
        // от дефолта Anthropic (где отсутствие поля означало бы non-streaming):
        // единственный потребитель Claude Code всегда шлёт stream явно.
        const nonStreaming = parsed.stream === false;
        const frames = [];
        const stream = createAnthropicStream({
          model,
          write: nonStreaming
            ? (frame) => frames.push(frame)
            : (frame) => {
              if (!res.writableEnded && !res.destroyed) res.write(frame);
            },
        });
        if (!nonStreaming) {
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.flushHeaders();
        }
        const parser = createSseParser((ev) => {
          try {
            stream.handleEvent(ev);
          } catch {
            // ошибка перевода одного события не должна рвать поток
          }
        });
        upstreamRes.setEncoding('utf8');
        upstreamRes.on('data', (chunk) => parser.push(chunk));
        upstreamRes.on('end', () => {
          stream.finishIfOpen();
          if (clientGone) {
            emit(log, { id, type: 'error', route: 'codex', model, status: 499, error: 'client_disconnect' });
          } else {
            emit(log, { id, type: 'response', route: 'codex', model, status: 200 });
          }
          if (nonStreaming) {
            try {
              sendJson(res, 200, assembleMessage(frames));
            } catch (error) {
              sendError(res, 500, error.safeType ?? 'api_error',
                error.message ?? 'Stream assembly failed');
            }
            return;
          }
          if (!res.writableEnded) res.end();
        });
        upstreamRes.on('error', () => {
          if (clientGone) {
            emit(log, { id, type: 'error', route: 'codex', model, status: 499, error: 'client_disconnect' });
          } else {
            emit(log, { id, type: 'error', route: 'codex', model, status: 200, error: 'upstream_stream' });
          }
          if (nonStreaming) {
            sendError(res, 502, 'bad_gateway', 'Upstream stream failed');
            return;
          }
          stream.failOpen('Upstream connection error');
          if (!res.writableEnded) res.end();
        });
      });
      // Обрыв клиента — в т.ч. до прихода заголовков upstream: уничтожаем запрос
      // сразу (иначе генерация на chatgpt.com продолжает жечь квоту, а при
      // зависшем upstream сокет висит вечно) и помечаем обрыв, чтобы логи не
      // приняли его за ошибку upstream — 499 client_disconnect, как в forward() роутера.
      // После нормального завершения destroyed === true и destroy() — no-op.
      res.on('close', () => {
        clientGone = true;
        if (!upstreamRequest.destroyed) upstreamRequest.destroy();
      });
      upstreamRequest.on('error', () => {
        if (res.writableEnded || res.destroyed) return;
        emit(log, { id, type: 'error', route: 'codex', model, status: 502, error: 'upstream_request' });
        sendError(res, 502, 'bad_gateway', 'Upstream request failed');
      });
      upstreamRequest.end(JSON.stringify(payload));
    } catch (error) {
      emit(log, { id, type: 'error', route: 'codex', model, status: 500, error: error?.safeType ?? error?.name ?? 'Error' });
      if (!res.writableEnded && !res.destroyed) sendError(res, 500, 'internal_error', 'Internal error');
    }
  });
  server.requestTimeout = 0;
  return server;
}

if (isMain(import.meta.url)) {
  const port = Number.parseInt(process.env.BRIDGE_PORT ?? '8790', 10);
  const logPath = process.env.BRIDGE_LOG_PATH ?? DEFAULT_LOG_PATH;
  const log = createFileLogger(logPath);
  const bridge = createBridge({
    authPath: process.env.CODEX_AUTH_PATH ?? DEFAULT_AUTH_PATH,
    log,
    reasoningEffort: process.env.CODEX_BRIDGE_REASONING_EFFORT ?? 'medium',
  });
  bridge.on('error', (error) => {
    emit(log, { type: 'server_error', route: `127.0.0.1:${port}`, error: error.code ?? error.name ?? 'Error' });
  });
  bridge.listen(port, '127.0.0.1', () => {
    emit(log, { type: 'listen', route: `127.0.0.1:${port}`, status: 200 });
  });
}
