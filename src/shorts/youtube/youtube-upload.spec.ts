import { YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
import { HttpRequest, HttpResponse } from './youtube-http';
import { UploadMeta, checkUpload, sendFile, startUpload } from './youtube-upload';

const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });
function fakeHttp(...responses: Array<HttpResponse | Error>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const next = responses.shift();
    if (!next) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    if (next instanceof Error) throw next;
    return next;
  });
  return { http, calls };
}
const caught = (p: Promise<unknown>): Promise<any> => p.then(() => null, (e) => e);

const META: UploadMeta = { title: 'Залог', description: 'Описание', tags: ['аренда'], categoryId: '27', language: 'ru', privacy: 'unlisted' };
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc';

describe('startUpload', () => {
  it('сессия: параметры, заголовки размера, метаданные; 200 + Location на googleapis.com → адрес', async () => {
    const { http, calls } = fakeHttp(reply(200, {}, { location: SESSION }));
    expect(await startUpload(http, 'at', META, 1234)).toBe(SESSION);
    const req = calls[0];
    expect(req).toMatchObject({ method: 'POST', url: 'https://www.googleapis.com/upload/youtube/v3/videos' });
    expect(req.params).toEqual({ uploadType: 'resumable', part: 'snippet,status' });
    expect(req.headers).toMatchObject({ Authorization: 'Bearer at', 'X-Upload-Content-Type': 'video/mp4', 'X-Upload-Content-Length': '1234' });
    expect(req.data).toEqual({
      snippet: { title: 'Залог', description: 'Описание', tags: ['аренда'], categoryId: '27', defaultLanguage: 'ru', defaultAudioLanguage: 'ru' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: false },
    });
  });

  it('любой отказ, в том числе 401, — YoutubeNotUploaded со статусом', async () => {
    for (const [r, status] of [
      [reply(401, { error: { message: 'Invalid Credentials' } }), 401],
      [reply(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }), 403],
      [reply(503), 503],
    ] as Array<[HttpResponse, number]>) {
      const e = await caught(startUpload(fakeHttp(r).http, 'at', META, 1));
      expect(e).toBeInstanceOf(YoutubeNotUploaded);
      expect(e).toMatchObject({ status });
    }
    const q = await caught(startUpload(fakeHttp(reply(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } })).http, 'at', META, 1));
    expect(q.message).toBe('начало загрузки: HTTP 403 quotaExceeded: quota');
  });

  it('обрыв — YoutubeNotUploaded', async () => {
    expect(await caught(startUpload(fakeHttp(new Error('ENOTFOUND')).http, 'at', META, 1))).toBeInstanceOf(YoutubeNotUploaded);
  });

  it('адреса сессии нет или он не на googleapis.com — YoutubeNotUploaded', async () => {
    for (const headers of [{}, { location: 'http://www.googleapis.com/upload/x' }, { location: 'https://evil.example/upload' }, { location: 'не адрес' }]) {
      expect(await caught(startUpload(fakeHttp(reply(200, {}, headers)).http, 'at', META, 1))).toBeInstanceOf(YoutubeNotUploaded);
    }
  });
});

describe('sendFile', () => {
  it('200 и 201 с id — ролик загружен; файл байтами в PUT на адрес сессии, с токеном', async () => {
    for (const status of [200, 201]) {
      const { http, calls } = fakeHttp(reply(status, { id: 'abcdefghijk' }));
      expect(await sendFile(http, SESSION, 'at', Buffer.from('12345'))).toBe('abcdefghijk');
      expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
      expect(calls[0].headers).toMatchObject({ Authorization: 'Bearer at', 'Content-Type': 'video/mp4', 'Content-Length': '5' });
      expect(Buffer.isBuffer(calls[0].data)).toBe(true);
    }
  });

  it('обрыв, 2xx без id, 3xx, 408, 429, 5xx — YoutubeMaybeUploaded', async () => {
    for (const r of [new Error('socket hang up'), reply(200, ''), reply(201, {}), reply(302), reply(308), reply(408), reply(429), reply(503)]) {
      expect(await caught(sendFile(fakeHttp(r).http, SESSION, 'at', Buffer.from('x')))).toBeInstanceOf(YoutubeMaybeUploaded);
    }
  });

  it('явный отказ 4xx — YoutubeNotUploaded со статусом', async () => {
    for (const status of [400, 401, 403]) {
      const e = await caught(sendFile(fakeHttp(reply(status, { error: { message: 'bad' } })).http, SESSION, 'at', Buffer.from('x')));
      expect(e).toBeInstanceOf(YoutubeNotUploaded);
      expect(e).toMatchObject({ status });
    }
  });

  it('адрес сессии не на googleapis.com — YoutubeNotUploaded, HTTP не вызван', async () => {
    const { http, calls } = fakeHttp();
    const e = await caught(sendFile(http, 'https://evil.example/upload', 'at', Buffer.from('x')));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(calls).toHaveLength(0);
  });
});

describe('checkUpload', () => {
  it('вопрос без тела, с токеном и размером; 200 и 201 с id — загружено', async () => {
    for (const status of [200, 201]) {
      const { http, calls } = fakeHttp(reply(status, { id: 'abcdefghijk' }));
      expect(await checkUpload(http, SESSION, 'at', 77)).toEqual({ state: 'complete', videoId: 'abcdefghijk' });
      expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
      expect(calls[0].headers).toEqual({ Authorization: 'Bearer at', 'Content-Range': 'bytes */77', 'Content-Length': '0' });
      expect(calls[0].data).toBeUndefined();
    }
  });

  it('308 без Range или с неполным Range — не догружено', async () => {
    // headers={} — заголовка Range нет вовсе; это не то же самое, что присланный, но пустой
    // (см. тест про непонятный Range ниже) — там YouTube что-то ответил, а здесь просто нет байтов.
    expect(await checkUpload(fakeHttp(reply(308)).http, SESSION, 'at', 77)).toEqual({ state: 'incomplete' });
    expect(await checkUpload(fakeHttp(reply(308, {}, { range: 'bytes=0-41' })).http, SESSION, 'at', 77)).toEqual({ state: 'incomplete' });
    expect(await checkUpload(fakeHttp(reply(308, {}, { range: 'bytes=0-99' })).http, SESSION, 'at', 1000)).toEqual({ state: 'incomplete' });
  });

  it('308 с Range до последнего байта — YouTube собирает ролик: YoutubeMaybeUploaded', async () => {
    const e = await caught(checkUpload(fakeHttp(reply(308, {}, { range: 'bytes=0-76' })).http, SESSION, 'at', 77));
    expect(e).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(e).toMatchObject({ status: 308 });
  });

  it('308 с Range не по протоколу (пустой, не с нулевого байта или не разбирается) — исход неизвестен, YoutubeMaybeUploaded', async () => {
    for (const range of ['bytes=100-200', 'garbage', '']) {
      const e = await caught(checkUpload(fakeHttp(reply(308, {}, { range })).http, SESSION, 'at', 1000));
      expect(e).toBeInstanceOf(YoutubeMaybeUploaded);
      expect(e).toMatchObject({ status: 308 });
    }
  });

  it('404 и 410 — сессии нет (gone)', async () => {
    expect(await checkUpload(fakeHttp(reply(404)).http, SESSION, 'at', 1)).toEqual({ state: 'gone' });
    expect(await checkUpload(fakeHttp(reply(410)).http, SESSION, 'at', 1)).toEqual({ state: 'gone' });
  });

  it('итоговый отказ 4xx — загрузка кончилась отказом (failed)', async () => {
    expect(await checkUpload(fakeHttp(reply(400, { error: { message: 'bad metadata' } })).http, SESSION, 'at', 1))
      .toEqual({ state: 'failed', status: 400, reason: 'HTTP 400 bad metadata' });
  });

  it('403 с явным лимитом (quotaExceeded, uploadLimitExceeded) — тоже failed', async () => {
    for (const reason of ['quotaExceeded', 'uploadLimitExceeded']) {
      expect(await checkUpload(fakeHttp(reply(403, { error: { message: 'limit', errors: [{ reason }] } })).http, SESSION, 'at', 1))
        .toEqual({ state: 'failed', status: 403, reason: `HTTP 403 ${reason}: limit` });
    }
  });

  it('403 без явного лимита — сессия бывает не этого аккаунта (переподключил другой менеджер бренд-канала): исход неизвестен', async () => {
    const noBody = await caught(checkUpload(fakeHttp(reply(403)).http, SESSION, 'at', 1));
    expect(noBody).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(noBody).toMatchObject({ status: 403 });
    // YouTube ответил — пусть и неоднозначно, не «не ответил»; сообщение подсказывает выход.
    expect(noBody.message).toMatch(/отказал в ответе о прошлой загрузке/);
    expect(noBody.message).toMatch(/переподключили другим аккаунтом/);
    const forbidden = await caught(
      checkUpload(fakeHttp(reply(403, { error: { message: 'forbidden', errors: [{ reason: 'forbidden' }] } })).http, SESSION, 'at', 1),
    );
    expect(forbidden).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(forbidden).toMatchObject({ status: 403 });
    expect(forbidden.message).toBe(
      'YouTube отказал в ответе о прошлой загрузке (HTTP 403 forbidden: forbidden) — так бывает, если канал переподключили другим аккаунтом; тогда переподключите прежним',
    );
  });

  it('401, 408, 429, 5xx и обрыв — YoutubeMaybeUploaded', async () => {
    for (const r of [reply(401), reply(408), reply(429), reply(500), new Error('ETIMEDOUT')]) {
      expect(await caught(checkUpload(fakeHttp(r).http, SESSION, 'at', 1))).toBeInstanceOf(YoutubeMaybeUploaded);
    }
  });

  it('адрес сессии не на googleapis.com — gone, HTTP не вызван', async () => {
    const { http, calls } = fakeHttp();
    expect(await checkUpload(http, 'http://www.googleapis.com/upload', 'at', 1)).toEqual({ state: 'gone' });
    expect(calls).toHaveLength(0);
  });
});
