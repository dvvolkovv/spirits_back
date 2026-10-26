import { EventEmitter } from 'events';
import * as http from 'http';
import { AddressInfo } from 'net';
import { Logger } from '@nestjs/common';
import { WebSocket } from 'ws';
import { JwtService } from '../common/services/jwt.service';
import { LanguageService } from '../common/services/language.service';
import { SpeechkitSttService } from './speechkit-stt.service';
import {
  attachVoiceWs,
  handleConnection,
  LANGUAGE_RESOLVE_TIMEOUT_MS,
  VOICE_WS_MAX_PAYLOAD,
  VOICE_WS_MAX_PENDING_BYTES,
} from './voice-ws';

/// Голосовой шлюз слушает на языке профиля. Язык читается из базы уже после
/// апгрейда сокета, а клиент (voiceDictation.ts) шлёт аудио сразу, не дожидаясь
/// ready, — поэтому здесь же проверяется, что начало фразы не теряется.
function fakeWs() {
  const ws: any = new EventEmitter();
  ws.readyState = WebSocket.OPEN;
  ws.sent = [] as any[];
  ws.send = jest.fn((raw: string) => ws.sent.push(JSON.parse(raw)));
  ws.close = jest.fn();
  return ws;
}

function fakeStt() {
  const handle = { push: jest.fn(), end: jest.fn() };
  const stt: any = { available: true, openStream: jest.fn(() => handle) };
  return { stt, handle };
}

const langs = (value: string | Promise<string> | (() => Promise<string>)) => ({
  resolveUserLanguage: jest.fn(() =>
    typeof value === 'string' ? Promise.resolve(value) : typeof value === 'function' ? value() : value,
  ),
});

describe('голосовой WebSocket: язык из профиля', () => {
  it('китайский профиль — lang_unsupported, сокет закрыт, стрим SpeechKit не открывается', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    await handleConnection(ws, 'u-1', stt, langs('zh'));
    expect(ws.sent).toEqual([{ type: 'error', message: 'lang_unsupported' }]);
    expect(ws.close).toHaveBeenCalled();
    expect(stt.openStream).not.toHaveBeenCalled();
  });

  it('английский профиль — стрим открыт на английском, потом ready', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    const languages = langs('en');
    await handleConnection(ws, 'u-1', stt, languages);
    expect(languages.resolveUserLanguage).toHaveBeenCalledWith('u-1');
    expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'en');
    expect(ws.sent).toEqual([{ type: 'ready' }]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('язык не прочитался — русский', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    await handleConnection(ws, 'u-1', stt, langs(() => Promise.reject(new Error('db down'))));
    expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'ru');
  });

  it('сервиса языков нет — русский', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    await handleConnection(ws, 'u-1', stt, null);
    expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'ru');
  });

  it('база молчит — не дольше двух секунд, потом русский и предупреждение в лог', async () => {
    expect(LANGUAGE_RESOLVE_TIMEOUT_MS).toBeLessThanOrEqual(2000);
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    jest.useFakeTimers();
    try {
      const ws = fakeWs();
      const { stt } = fakeStt();
      const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>(() => {})));
      await jest.advanceTimersByTimeAsync(LANGUAGE_RESOLVE_TIMEOUT_MS);
      await done;
      expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'ru');
      expect(warn.mock.calls.some((c) => /u-1/.test(String(c[0])))).toBe(true);
    } finally {
      jest.useRealTimers();
      warn.mockRestore();
    }
  });

  it('язык прочитан быстро — предупреждения о таймауте нет', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    try {
      const { stt } = fakeStt();
      await handleConnection(fakeWs(), 'u-1', stt, langs('en'));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('буфер ожидания переполнен — сокет закрыт, стрим не открывается', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    let release!: (l: string) => void;
    const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>((r) => { release = r; })));
    const chunk = Buffer.alloc(VOICE_WS_MAX_PAYLOAD);
    for (let sent = 0; sent <= VOICE_WS_MAX_PENDING_BYTES; sent += chunk.length) ws.emit('message', chunk, true);
    expect(ws.close).toHaveBeenCalled();
    ws.emit('close');
    release('en');
    await done;
    expect(stt.openStream).not.toHaveBeenCalled();
  });

  it('сокет уже не OPEN к моменту открытия стрима — стрим не открывается', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    let release!: (l: string) => void;
    const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>((r) => { release = r; })));
    ws.readyState = WebSocket.CLOSING;
    release('en');
    await done;
    expect(stt.openStream).not.toHaveBeenCalled();
  });

  it('аудио и stop, пришедшие до определения языка, доходят до стрима по порядку', async () => {
    const ws = fakeWs();
    const { stt, handle } = fakeStt();
    let release!: (l: string) => void;
    const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>((r) => { release = r; })));
    const a = Buffer.from([1]);
    const b = Buffer.from([2]);
    ws.emit('message', a, true);
    ws.emit('message', b, true);
    ws.emit('message', Buffer.from(JSON.stringify({ type: 'stop' })), false);
    expect(stt.openStream).not.toHaveBeenCalled();
    release('de');
    await done;
    expect(handle.push.mock.calls.map((c) => c[0])).toEqual([a, b]);
    expect(handle.end).toHaveBeenCalledTimes(1);
    expect(handle.end.mock.invocationCallOrder[0]).toBeGreaterThan(handle.push.mock.invocationCallOrder[1]);
  });

  it('клиент ушёл, пока читался язык, — стрим не открывается', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    let release!: (l: string) => void;
    const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>((r) => { release = r; })));
    ws.emit('close');
    release('en');
    await done;
    expect(stt.openStream).not.toHaveBeenCalled();
    expect(ws.sent).toEqual([]);
  });

  it('после открытия стрима аудио идёт напрямую, закрытие сокета завершает стрим', async () => {
    const ws = fakeWs();
    const { stt, handle } = fakeStt();
    await handleConnection(ws, 'u-1', stt, langs('fr'));
    const c = Buffer.from([3]);
    ws.emit('message', c, true);
    expect(handle.push).toHaveBeenCalledWith(c);
    ws.emit('close');
    expect(handle.end).toHaveBeenCalled();
  });

  it('SpeechKit не настроен — прежняя ошибка, язык даже не читается', async () => {
    const ws = fakeWs();
    const { stt } = fakeStt();
    stt.available = false;
    const languages = langs('en');
    await handleConnection(ws, 'u-1', stt, languages);
    expect(ws.sent).toEqual([{ type: 'error', message: 'voice not configured' }]);
    expect(languages.resolveUserLanguage).not.toHaveBeenCalled();
    expect(stt.openStream).not.toHaveBeenCalled();
  });
});

describe('голосовой WebSocket: живой сервер', () => {
  let server: http.Server;
  let stt: any;
  let handle: { push: jest.Mock; end: jest.Mock };
  let url: string;
  let clients: WebSocket[] = [];
  /** Клиент, которого afterEach закроет, даже если тест упал на полпути. */
  const open = (u: string) => {
    const c = new WebSocket(u);
    c.on('error', () => {});
    clients.push(c);
    return c;
  };

  beforeEach(async () => {
    clients = [];
    ({ stt, handle } = fakeStt());
    server = http.createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const deps = new Map<any, any>([
      [JwtService, { verifyAccess: (t: string) => { if (t !== 'good') throw new Error('bad'); return { userId: 'u-1' }; } }],
      [SpeechkitSttService, stt],
      [LanguageService, langs('en')],
    ]);
    attachVoiceWs({ get: (cls: any) => deps.get(cls), getHttpServer: () => server } as any);
    url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/voice/stream?token=good`;
  });

  afterEach(async () => {
    for (const c of clients) c.terminate();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** Подключиться и дождаться ready. */
  const connect = async () => {
    const client = open(url);
    await new Promise<void>((resolve, reject) => {
      client.on('message', (d) => { if (JSON.parse(String(d)).type === 'ready') resolve(); });
      client.on('error', reject);
    });
    return client;
  };

  it('фрейм как у ворклета (100 мс PCM) доходит до стрима', async () => {
    const client = await connect();
    const frame = Buffer.alloc(3200, 1);
    client.send(frame);
    await new Promise((r) => setTimeout(r, 50));
    expect(handle.push).toHaveBeenCalledWith(frame);
    expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'en');
    client.terminate();
  });

  it('фрейм больше потолка — сервер рвёт соединение с кодом 1009, до стрима не доходит', async () => {
    const client = await connect();
    const closed = new Promise<number>((r) => client.on('close', (code) => r(code)));
    client.send(Buffer.alloc(VOICE_WS_MAX_PAYLOAD + 1));
    expect(await closed).toBe(1009);
    expect(handle.push).not.toHaveBeenCalled();
  });

  it('без верного токена — 401 до апгрейда', async () => {
    const client = open(url.replace('token=good', 'token=bad'));
    const status = await new Promise<number>((r) => client.on('unexpected-response', (_req, res) => r(res.statusCode || 0)));
    expect(status).toBe(401);
  });
});
