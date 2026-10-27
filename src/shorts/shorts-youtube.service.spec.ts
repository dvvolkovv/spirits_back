import { Logger } from '@nestjs/common';
import { decryptSecret } from '../calendar/crypto';
import { ShortsYoutubeService, connectPage, parseYoutubeCommand } from './shorts-youtube.service';
import { HttpRequest, HttpResponse } from './youtube/youtube-http';
import { verifyState } from './youtube/youtube-state';

const OWNER = 37948399;
const SECRET = 'GOCSPX-test-secret-0123456789';
const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });

/** База в миниатюре: ровно те запросы, что делает сервис YouTube. */
function fakeDb(init: { account?: any; mode?: string; session?: string | null; published?: string | null } = {}) {
  const st: any = {
    account: init.account ?? null,
    mode: init.mode ?? 'manual',
    session: init.session ?? null,
    published: init.published ?? null,
  };
  const query = jest.fn(async (sql: string, p: any[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    if (s.startsWith('SELECT * FROM short_youtube_account')) return { rows: st.account ? [{ ...st.account }] : [] };
    if (s.startsWith('INSERT INTO short_youtube_account')) {
      st.account = {
        channel_id: p[0], channel_title: p[1], refresh_token_enc: p[2], scopes: p[3],
        status: 'connected', last_error: null, connected_at: new Date().toISOString(),
      };
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_settings SET youtube_mode = CASE")) {
      if (st.mode === 'manual') st.mode = 'unlisted';
      return { rows: [{ youtube_mode: st.mode }], rowCount: 1 };
    }
    if (s.startsWith("UPDATE short_youtube_account SET status = 'revoked'")) {
      if (st.account) Object.assign(st.account, { status: 'revoked', last_error: p[0] });
      return { rows: [], rowCount: st.account ? 1 : 0 };
    }
    if (s.startsWith('SELECT upload_session FROM short_publication')) return { rows: [{ upload_session: st.session }] };
    if (s.startsWith('UPDATE short_publication SET upload_session')) {
      st.session = p[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT url FROM short_publication')) return { rows: st.published ? [{ url: st.published }] : [] };
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, st };
}

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

function setup(db = fakeDb(), http = fakeHttp()) {
  const tg = { sendMessage: jest.fn(async () => ({ message_id: 1 })) };
  const storage = { download: jest.fn(async () => Buffer.from('video-bytes')) };
  const settings = {
    get: jest.fn(async () => ({ youtubeMode: db.st.mode })),
    update: jest.fn(async (patch: any) => {
      if (patch.youtubeMode) db.st.mode = patch.youtubeMode;
      return { youtubeMode: db.st.mode };
    }),
  };
  const svc = new ShortsYoutubeService({ query: db.query } as any, tg as any, storage as any, settings as any);
  svc.http = http.http;
  const said = (): string[] => tg.sendMessage.mock.calls.map((c: any[]) => c[1] as string);
  return { svc, tg, storage, settings, db, http, said };
}

const dm = (text: string, from = OWNER) => ({ text, chat: { id: from, type: 'private' }, from: { id: from }, message_id: 10 });

const env = { ...process.env };
beforeEach(() => {
  process.env.BLOG_APPROVER_TG_ID = String(OWNER);
  process.env.YOUTUBE_OAUTH_CLIENT_ID = 'cid.apps.googleusercontent.com';
  process.env.YOUTUBE_OAUTH_CLIENT_SECRET = SECRET;
  process.env.PUBLIC_BASE_URL = 'https://test.linkeon.io';
  process.env.CALENDAR_SECRET_KEY = 'k'.repeat(32);
  delete process.env.SHORTS_STAND;
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  process.env = env;
});

describe('parseYoutubeCommand', () => {
  it('режимы по-русски; регистр, лишние пробелы и @Бот не мешают', () => {
    expect(parseYoutubeCommand('/youtube')).toEqual({ mode: null, arg: '' });
    expect(parseYoutubeCommand('/youtube@LinkeonAgentBot по  ссылке')).toEqual({ mode: 'unlisted', arg: 'по ссылке' });
    expect(parseYoutubeCommand('/YouTube Публично')).toEqual({ mode: 'public', arg: 'публично' });
    expect(parseYoutubeCommand('/youtube вручную')).toEqual({ mode: 'manual', arg: 'вручную' });
    expect(parseYoutubeCommand('/youtube громко')).toEqual({ mode: null, arg: 'громко' });
  });

  it('другие команды и не текст — null', () => {
    for (const t of ['/youtubex', '/short тема', 'youtube', undefined, 42]) expect(parseYoutubeCommand(t)).toBeNull();
  });
});

describe('команда /youtube', () => {
  it('чужой, группа, другая команда — не наше, бот молчит', async () => {
    const { svc, tg } = setup();
    expect(await svc.handleCommand(dm('/youtube', 1))).toBe(false);
    expect(await svc.handleCommand({ ...dm('/youtube'), chat: { id: -100, type: 'supergroup' } })).toBe(false);
    expect(await svc.handleCommand(dm('/start'))).toBe(false);
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('канал не подключён — статус и ссылка на вход; state подписан на чат владельца', async () => {
    const { svc, said } = setup();
    expect(await svc.handleCommand(dm('/youtube'))).toBe(true);
    const text = said()[0];
    expect(text).toContain('канал не подключён — ролики идут набором');
    expect(text).toContain('«Дополнительно» → «Перейти»');
    const url = new URL(text.match(/https:\/\/accounts\.google\.com\S+/)[0]);
    expect(url.searchParams.get('redirect_uri')).toBe('https://test.linkeon.io/webhook/shorts/youtube/oauth/callback');
    expect(verifyState(SECRET, 'https://test.linkeon.io/webhook/shorts/youtube/oauth/callback', url.searchParams.get('state')))
      .toEqual({ chatId: OWNER });
  });

  it('подключён — канал, режим и как сменить', async () => {
    const db = fakeDb({ mode: 'public', account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toMatch(/^YouTube: подключён канал «Linkeon», режим — публично\./);
    expect(said()[0]).toContain('/youtube по ссылке');
  });

  it('доступ пропал — причина и ссылка на переподключение', async () => {
    const db = fakeDb({
      mode: 'public',
      account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'revoked', last_error: 'HTTP 400 invalid_grant' },
    });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toContain('доступ к каналу «Linkeon» пропал (HTTP 400 invalid_grant) — ролики идут набором');
    expect(said()[0]).toContain('https://accounts.google.com/');
  });

  it('режим без подключённого канала — сохраняется, но с предупреждением и ссылкой', async () => {
    const { svc, settings, said, db } = setup();
    await svc.handleCommand(dm('/youtube публично'));
    expect(settings.update).toHaveBeenCalledWith({ youtubeMode: 'public' });
    expect(db.st.mode).toBe('public');
    expect(said()[0]).toMatch(/^Готово: ролики на YouTube — публично\. Но канал не подключён, поэтому пока набор\./);
    expect(said()[0]).toContain('https://accounts.google.com/');
  });

  it('режим при подключённом канале — коротко; «вручную» — про набор', async () => {
    const db = fakeDb({ account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube по ссылке'));
    await svc.handleCommand(dm('/youtube вручную'));
    expect(said()).toEqual(['Готово: ролики на YouTube — по ссылке.', 'Готово: YouTube — вручную, буду присылать набор.']);
  });

  it('незнакомый режим — подсказка, настройки не трогаем', async () => {
    const { svc, settings, said } = setup();
    expect(await svc.handleCommand(dm('/youtube громко'))).toBe(true);
    expect(settings.update).not.toHaveBeenCalled();
    expect(said()[0]).toBe('Не понял режим. Можно: /youtube публично, /youtube по ссылке, /youtube вручную.');
  });

  it('нет клиента OAuth на сервере — так и говорим', async () => {
    delete process.env.YOUTUBE_OAUTH_CLIENT_SECRET;
    const { svc, said } = setup();
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toMatch(/^YouTube не настроен на этом сервере/);
  });

  it('стенд — пометка в сообщении', async () => {
    process.env.SHORTS_STAND = 'true';
    const { svc, said } = setup();
    await svc.handleCommand(dm('/youtube громко'));
    expect(said()[0].startsWith('[СТЕНД] ')).toBe(true);
  });
});

describe('адрес возврата Google', () => {
  const stateFor = (chat = OWNER): string => new URL(setup().svc.connectUrl(chat)).searchParams.get('state');
  const tokensOk = () =>
    reply(200, {
      access_token: 'access-xyz',
      refresh_token: 'refresh-xyz',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
    });
  const channelOk = (title = 'Linkeon') => reply(200, { items: [{ id: 'UCu_Pq4rFXmTT8CDG27O_i2A', snippet: { title, customUrl: '@linkeons' } }] });

  it('успех: канал с зашифрованным токеном, «вручную» → «по ссылке», сообщение владельцу, страница без токенов', async () => {
    const db = fakeDb();
    const { svc, said } = setup(db, fakeHttp(tokensOk(), channelOk()));
    const page = await svc.completeConnect({ code: 'code-1', state: stateFor() });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Канал подключён');
    expect(page.html).not.toContain('refresh-xyz');
    expect(page.html).not.toContain('access-xyz');
    expect(db.st.account.channel_id).toBe('UCu_Pq4rFXmTT8CDG27O_i2A');
    expect(db.st.account.refresh_token_enc).not.toContain('refresh-xyz');
    expect(decryptSecret(db.st.account.refresh_token_enc)).toBe('refresh-xyz');
    expect(db.st.mode).toBe('unlisted');
    expect(said()[0]).toBe(
      'YouTube подключён: канал «Linkeon» (@linkeons). Ролики будут загружаться сами, режим — по ссылке. ' +
        'Проверьте первый ролик: если открывается по ссылке и не стал приватным — /youtube публично.',
    );
  });

  it('режим «публично» подключение не трогает', async () => {
    const db = fakeDb({ mode: 'public' });
    const { svc, said } = setup(db, fakeHttp(tokensOk(), channelOk()));
    await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(db.st.mode).toBe('public');
    expect(said()[0]).toContain('режим — публично.');
  });

  it('отмена на экране Google — страница, без запросов и сообщений', async () => {
    const { svc, http, tg } = setup();
    const page = await svc.completeConnect({ error: 'access_denied', state: stateFor() });
    expect(page.html).toContain('Подключение отменено');
    expect(http.http).not.toHaveBeenCalled();
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('чужой или битый state — 400, без запросов', async () => {
    const { svc, http } = setup();
    for (const state of [undefined, 'x.y', stateFor(OWNER + 1)]) {
      const page = await svc.completeConnect({ code: 'c', state });
      expect(page.status).toBe(400);
      expect(page.html).toContain('Ссылка устарела');
    }
    expect(http.http).not.toHaveBeenCalled();
  });

  it('Google отказал в обмене — 502 и причина владельцу', async () => {
    const { svc, said } = setup(fakeDb(), fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Bad Request' })));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(said()[0]).toBe('YouTube не подключён: обмен кода: HTTP 400 invalid_grant: Bad Request');
  });

  it('браузер повторил адрес возврата сразу после подключения — «уже подключён», бот молчит', async () => {
    const db = fakeDb({
      account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected', connected_at: new Date().toISOString() },
    });
    const { svc, tg } = setup(db, fakeHttp(reply(400, { error: 'invalid_grant' })));
    const page = await svc.completeConnect({ code: 'used', state: stateFor() });
    expect(page.status).toBe(200);
    expect(page.html).toContain('Канал уже подключён');
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('нет клиента OAuth — 503', async () => {
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const { svc } = setup();
    expect((await svc.completeConnect({ code: 'c', state: 'x' })).status).toBe(503);
  });

  it('текст страницы экранируется', () => {
    expect(connectPage(200, 'Канал <b>', 'a & "b"').html).toContain('Канал &lt;b&gt;</h1><p>a &amp; &quot;b&quot;</p>');
  });
});
