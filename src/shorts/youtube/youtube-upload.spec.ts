import { YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded } from './youtube-errors';
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

const META: UploadMeta = { title: 'Залог', description: 'Описание', tags: ['аренда'], categoryId: '27', language: 'ru', privacy: 'unlisted' };
const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc';

describe('startUpload', () => {
  it('сессия: параметры, заголовки размера, метаданные; 200 + Location → адрес', async () => {
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

  it('401 — YoutubeAuthError; 403 квота — YoutubeNotUploaded с причиной и статусом; обрыв — YoutubeNotUploaded', async () => {
    await expect(startUpload(fakeHttp(reply(401, { error: { message: 'Invalid Credentials' } })).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeAuthError);
    const quota = startUpload(fakeHttp(reply(403, { error: { message: 'quota', errors: [{ reason: 'quotaExceeded' }] } })).http, 'at', META, 1);
    await expect(quota).rejects.toThrow(new YoutubeNotUploaded('начало загрузки: HTTP 403 quotaExceeded: quota', 403));
    await expect(startUpload(fakeHttp(new Error('ENOTFOUND')).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });

  it('200 без Location — YoutubeNotUploaded', async () => {
    await expect(startUpload(fakeHttp(reply(200, {})).http, 'at', META, 1)).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('sendFile', () => {
  it('201 с id — ролик загружен; файл байтами в PUT на адрес сессии', async () => {
    const { http, calls } = fakeHttp(reply(201, { id: 'abcdefghijk' }));
    expect(await sendFile(http, SESSION, Buffer.from('12345'))).toBe('abcdefghijk');
    expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(calls[0].headers).toMatchObject({ 'Content-Type': 'video/mp4', 'Content-Length': '5' });
    expect(Buffer.isBuffer(calls[0].data)).toBe(true);
  });

  it('обрыв, 408, 5xx, 308 — YoutubeMaybeUploaded; прочие 4xx — YoutubeNotUploaded', async () => {
    for (const r of [new Error('socket hang up'), reply(408), reply(503), reply(308)]) {
      await expect(sendFile(fakeHttp(r).http, SESSION, Buffer.from('x'))).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
    }
    await expect(sendFile(fakeHttp(reply(400, { error: { message: 'bad' } })).http, SESSION, Buffer.from('x'))).rejects.toBeInstanceOf(YoutubeNotUploaded);
  });
});

describe('checkUpload', () => {
  it('вопрос без тела с размером; 200/201 с id — загружено', async () => {
    const { http, calls } = fakeHttp(reply(200, { id: 'abcdefghijk' }));
    expect(await checkUpload(http, SESSION, 77)).toEqual({ state: 'complete', videoId: 'abcdefghijk' });
    expect(calls[0]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(calls[0].headers).toEqual({ 'Content-Range': 'bytes */77', 'Content-Length': '0' });
    expect(calls[0].data).toBeUndefined();
  });

  it('308 — не догружено; 404 и 410 — сессии нет', async () => {
    expect(await checkUpload(fakeHttp(reply(308)).http, SESSION, 1)).toEqual({ state: 'incomplete' });
    expect(await checkUpload(fakeHttp(reply(404)).http, SESSION, 1)).toEqual({ state: 'gone' });
    expect(await checkUpload(fakeHttp(reply(410)).http, SESSION, 1)).toEqual({ state: 'gone' });
  });

  it('обрыв и прочие ответы — YoutubeMaybeUploaded', async () => {
    await expect(checkUpload(fakeHttp(new Error('ETIMEDOUT')).http, SESSION, 1)).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
    await expect(checkUpload(fakeHttp(reply(500)).http, SESSION, 1)).rejects.toBeInstanceOf(YoutubeMaybeUploaded);
  });
});
