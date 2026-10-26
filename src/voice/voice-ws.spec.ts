import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import { handleConnection, LANGUAGE_RESOLVE_TIMEOUT_MS } from './voice-ws';

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

  it('база молчит — после таймаута русский, а не вечное ожидание', async () => {
    jest.useFakeTimers();
    try {
      const ws = fakeWs();
      const { stt } = fakeStt();
      const done = handleConnection(ws, 'u-1', stt, langs(new Promise<string>(() => {})));
      await jest.advanceTimersByTimeAsync(LANGUAGE_RESOLVE_TIMEOUT_MS);
      await done;
      expect(stt.openStream).toHaveBeenCalledWith(expect.any(Object), 'ru');
    } finally {
      jest.useRealTimers();
    }
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
