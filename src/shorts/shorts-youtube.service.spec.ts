import { Logger } from '@nestjs/common';
import { decryptSecret, encryptSecret } from '../calendar/crypto';
import { STUCK_PUBLISHING_MINUTES } from './shorts-publisher.service';
import { DOWNLOAD_TIMEOUT_MS } from './short-files';
import { PENDING_UPLOAD_NOTE, ShortsYoutubeService, connectPage, parseYoutubeCommand } from './shorts-youtube.service';
import { YoutubeAttemptSuperseded, YoutubeAuthError, YoutubeMaybeUploaded, YoutubeNotUploaded, YoutubeUploadExpired } from './youtube/youtube-errors';
import { HttpRequest, HttpResponse } from './youtube/youtube-http';
import { verifyState } from './youtube/youtube-state';

const OWNER = 37948399;
const SECRET = 'GOCSPX-test-secret-0123456789';
const reply = (status: number, data: any = {}, headers: any = {}): HttpResponse => ({ status, data, headers });

/**
 * База в миниатюре: ровно те запросы, что делает сервис YouTube. Строка YouTube — статус
 * (pub), адрес сессии и attempts — жетон захватившей её попытки. Условие на жетон фейк
 * соблюдает, только если оно есть в SQL: без него запись проходит, как прошла бы в базе.
 */
function fakeDb(
  init: {
    account?: any; mode?: string; session?: string | null; published?: string | null; pub?: string; attempts?: number;
    noRow?: boolean; clearThrows?: boolean; sessionThrows?: boolean;
  } = {},
) {
  const st: any = {
    account: init.account ?? null,
    mode: init.mode ?? 'manual',
    session: init.session ?? null,
    published: init.published ?? null,
    pub: init.pub ?? 'publishing',
    attempts: init.attempts ?? 1,
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
      if (!st.account || st.account.refresh_token_enc !== p[1]) return { rows: [], rowCount: 0 };
      Object.assign(st.account, { status: 'revoked', last_error: p[0] });
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT upload_session FROM short_publication')) {
      if (init.sessionThrows) throw new Error('Connection terminated unexpectedly');
      return { rows: [{ upload_session: st.session }] };
    }
    if (s.startsWith('SELECT upload_session, status, attempts FROM short_publication')) {
      if (init.sessionThrows) throw new Error('Connection terminated unexpectedly');
      return { rows: init.noRow ? [] : [{ upload_session: st.session, status: st.pub, attempts: st.attempts }] };
    }
    if (s.startsWith('UPDATE short_publication SET upload_session = $2')) {
      const fenced = s.includes('attempts = $3');
      if (st.pub !== 'publishing' || st.session !== null || (fenced && st.attempts !== p[2])) return { rows: [], rowCount: 0 };
      st.session = p[1];
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('UPDATE short_publication SET upload_session = NULL')) {
      if (init.clearThrows) throw new Error('Connection terminated unexpectedly');
      const onlyPublishing = s.includes("status = 'publishing'");
      const fenced = s.includes('attempts = $3');
      if (st.session !== p[1] || (onlyPublishing && st.pub !== 'publishing') || (fenced && st.attempts !== p[2])) return { rows: [], rowCount: 0 };
      st.session = null;
      return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('SELECT url FROM short_publication')) return { rows: st.published ? [{ url: st.published }] : [] };
    throw new Error(`неожиданный запрос: ${s}`);
  });
  return { query, st };
}

/** Ответы Google по очереди; функция — ответ с побочным действием (например, чужой захват строки в этот момент). */
function fakeHttp(...responses: Array<HttpResponse | Error | ((req: HttpRequest) => HttpResponse | Error)>) {
  const calls: HttpRequest[] = [];
  const http = jest.fn(async (req: HttpRequest) => {
    calls.push(req);
    const queued = responses.shift();
    if (!queued) throw new Error(`лишний запрос: ${req.method} ${req.url}`);
    const next = typeof queued === 'function' ? queued(req) : queued;
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
  process.env.SHORTS_ENABLED = 'true';
  delete process.env.SHORTS_STAND;
  delete process.env.YOUTUBE_CHANNEL_ID;
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

  it('подключён, но канал не тот, что в YOUTUBE_CHANNEL_ID — статус о несовпадении, набор', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCother0000000000000000';
    const db = fakeDb({ mode: 'public', account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube'));
    expect(said()[0]).toMatch(/^YouTube: подключён канал «Linkeon», а роликам нужен UCother0000000000000000 \(YOUTUBE_CHANNEL_ID\)/);
    expect(said()[0]).toContain('ролики идут набором');
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
    expect(said()[0]).toContain('PUBLIC_BASE_URL');
  });

  it('стенд — пометка в сообщении', async () => {
    process.env.SHORTS_STAND = 'true';
    const { svc, said } = setup();
    await svc.handleCommand(dm('/youtube громко'));
    expect(said()[0].startsWith('[СТЕНД] ')).toBe(true);
  });

  it('сбой записи режима — сообщение с причиной, команда обработана', async () => {
    const { svc, settings, said } = setup();
    settings.update.mockRejectedValueOnce(new Error('column "youtube_mode" does not exist'));
    expect(await svc.handleCommand(dm('/youtube публично'))).toBe(true);
    expect(said()[0]).toBe('YouTube: не получилось — column "youtube_mode" does not exist');
  });

  it('режим при отозванном доступе — «доступ к каналу пропал»', async () => {
    const db = fakeDb({ account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'revoked' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube публично'));
    expect(said()[0]).toMatch(/^Готово: ролики на YouTube — публично\. Но доступ к каналу пропал, поэтому пока набор\./);
  });

  it('режим при чужом канале — несовпадение вместо короткого подтверждения', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCother0000000000000000';
    const db = fakeDb({ account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected' } });
    const { svc, said } = setup(db);
    await svc.handleCommand(dm('/youtube публично'));
    expect(said()[0]).toMatch(
      /^Готово: ролики на YouTube — публично\. Но подключён канал «Linkeon», а роликам нужен UCother0000000000000000 \(YOUTUBE_CHANNEL_ID\), поэтому пока набор\./,
    );
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

  it('код уже использован, а недавнего подключения нет — 400 «Ссылка устарела», бот молчит', async () => {
    const { svc, tg } = setup(fakeDb(), fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Bad Request' })));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(400);
    expect(page.html).toContain('Ссылка устарела');
    expect(tg.sendMessage).not.toHaveBeenCalled();
  });

  it('прочий сбой обмена — 502, причина в лог и владельцу', async () => {
    const { svc, said } = setup(fakeDb(), fakeHttp(reply(500, {})));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(said()[0]).toBe('YouTube не подключён: обмен кода: HTTP 500');
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

  it('переподключение в пределах 10 минут сорвалось по настоящей причине — 502 и сообщение, а не «уже подключён»', async () => {
    const db = fakeDb({
      account: { channel_id: 'UCx', channel_title: 'Linkeon', refresh_token_enc: 'e', status: 'connected', connected_at: new Date().toISOString() },
    });
    const { svc, said } = setup(db, fakeHttp(tokensOk(), reply(200, { items: [] })));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(said()[0]).toMatch(/^YouTube не подключён: у аккаунта нет канала YouTube/);
  });

  it('сбой Telegram страницу не роняет; сообщение — без превью ссылок', async () => {
    const { svc, tg } = setup(fakeDb(), fakeHttp(tokensOk(), channelOk()));
    tg.sendMessage.mockRejectedValue(new Error('Bad Gateway'));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(200);
    expect((tg.sendMessage.mock.calls[0] as any[])[2]).toEqual({ link_preview_options: { is_disabled: true } });
  });

  it('конвейер выключен — в сообщении о подключении предупреждение', async () => {
    delete process.env.SHORTS_ENABLED;
    const { svc, said } = setup(fakeDb(), fakeHttp(tokensOk(), channelOk()));
    await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(said()[0]).toContain('Конвейер роликов на этом сервере пока выключен (SHORTS_ENABLED)');
  });

  it('нет клиента OAuth — 503', async () => {
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    const { svc } = setup();
    expect((await svc.completeConnect({ code: 'c', state: 'x' })).status).toBe(503);
  });

  it('текст страницы экранируется', () => {
    expect(connectPage(200, 'Канал <b>', 'a & "b"').html).toContain('Канал &lt;b&gt;</h1><p>a &amp; &quot;b&quot;</p>');
  });

  it('канал закреплён в YOUTUBE_CHANNEL_ID, а выбран другой — 502, подключения нет', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCother0000000000000000';
    const db = fakeDb();
    const { svc, said } = setup(db, fakeHttp(tokensOk(), channelOk()));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(db.st.account).toBeNull();
    expect(said()[0]).toMatch(/^YouTube не подключён: выбран канал «Linkeon» \(UCu_Pq4rFXmTT8CDG27O_i2A\), а роликам нужен UCother0000000000000000/);
  });

  it('канал закреплён в YOUTUBE_CHANNEL_ID, а выбран другой — при уже подключённом аккаунте строка и режим не меняются', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCother0000000000000000';
    const db = fakeDb({
      mode: 'manual',
      account: { channel_id: 'UCold', channel_title: 'Старый', refresh_token_enc: 'old', status: 'connected', connected_at: new Date(Date.now() - 3_600_000).toISOString() },
    });
    const { svc } = setup(db, fakeHttp(tokensOk(), channelOk()));
    const page = await svc.completeConnect({ code: 'c', state: stateFor() });
    expect(page.status).toBe(502);
    expect(db.st.account.channel_id).toBe('UCold');
    expect(db.st.account.refresh_token_enc).toBe('old');
    expect(db.st.mode).toBe('manual');
  });

  it('закреплённый канал совпал — подключение как обычно', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCu_Pq4rFXmTT8CDG27O_i2A';
    const db = fakeDb();
    const { svc } = setup(db, fakeHttp(tokensOk(), channelOk()));
    expect((await svc.completeConnect({ code: 'c', state: stateFor() })).status).toBe(200);
    expect(db.st.account.channel_id).toBe('UCu_Pq4rFXmTT8CDG27O_i2A');
  });
});

describe('загрузка ролика', () => {
  const CONNECTED = { channel_id: 'UCx', channel_title: 'Linkeon', status: 'connected' };
  const connected = (extra: any = {}) => fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: encryptSecret('refresh-xyz') }, ...extra });
  const video: any = {
    id: 'v1', videoKey: 'shorts/v1/video.mp4', lang: 'ru', attempts: 1,
    captions: { youtube: { title: 'Как не потерять залог', description: 'Описание\n\nhttps://my.linkeon.io/?utm_source=youtube', tags: ['аренда', 'залог'] } },
  };
  const SESSION = 'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=abc';
  const TOKEN = reply(200, { access_token: 'access-xyz' });
  const alive = () => jest.fn(async () => true);
  const caught = (p: Promise<unknown>): Promise<any> => p.then(() => null, (e) => e);

  it('план: вручную — набор без заметки; нет канала, доступ пропал, нет клиента — набор с заметкой; иначе загрузка', async () => {
    expect(await setup(fakeDb({ mode: 'manual' })).svc.uploadPlan('v1')).toEqual({ kind: 'kit', note: null });
    expect(await setup(fakeDb({ mode: 'public' })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'Канал YouTube не подключён — набор вместо загрузки. Подключить: /youtube' });
    expect(await setup(fakeDb({ mode: 'unlisted', account: { ...CONNECTED, refresh_token_enc: 'e', status: 'revoked' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube' });
    expect(await setup(fakeDb({ mode: 'unlisted', account: { ...CONNECTED, refresh_token_enc: 'e' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'upload', privacy: 'unlisted' });
    delete process.env.YOUTUBE_OAUTH_CLIENT_ID;
    expect(await setup(fakeDb({ mode: 'public' })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: 'YouTube не настроен на сервере — набор вместо загрузки.' });
  });

  it('план: подключённый канал не совпал с YOUTUBE_CHANNEL_ID — набор с заметкой', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCu_Pq4rFXmTT8CDG27O_i2A';
    expect(await setup(fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: 'e' } })).svc.uploadPlan('v1')).toEqual({
      kind: 'kit',
      note: 'Подключён канал «Linkeon», а роликам нужен UCu_Pq4rFXmTT8CDG27O_i2A (YOUTUBE_CHANNEL_ID) — набор вместо загрузки. Переподключить: /youtube',
    });
  });

  it('план: закреплённый канал совпал — загрузка как обычно', async () => {
    process.env.YOUTUBE_CHANNEL_ID = 'UCx'; // то же, что CONNECTED.channel_id
    expect(await setup(fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: 'e' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'upload', privacy: 'public' });
  });

  it('набор при живой сессии загрузки — с предупреждением проверить канал', async () => {
    expect(await setup(fakeDb({ mode: 'manual', session: SESSION })).svc.uploadPlan('v1')).toEqual({ kind: 'kit', note: PENDING_UPLOAD_NOTE });
    expect(await setup(fakeDb({ mode: 'public', session: SESSION, account: { ...CONNECTED, refresh_token_enc: 'e', status: 'revoked' } })).svc.uploadPlan('v1'))
      .toEqual({ kind: 'kit', note: `Доступ к каналу YouTube пропал — набор вместо загрузки. Переподключить: /youtube\n${PENDING_UPLOAD_NOTE}` });
  });

  it('загрузка: токен, сессия с метаданными, адрес лёг в базу до файла, файл с токеном, адрес остаётся до записи published (его стирает публикатор)', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    const seen: any[] = [];
    const keepAlive = jest.fn(async () => {
      seen.push(db.st.session);
      return true;
    });
    expect(await svc.upload(video, 'public', keepAlive, 1)).toEqual({ videoId: 'abcdefghijk', url: 'https://youtube.com/shorts/abcdefghijk', resumed: false });
    expect(seen).toEqual([SESSION]);
    expect(db.st.session).toBe(SESSION);
    const start = http.calls[1];
    expect(start.headers?.Authorization).toBe('Bearer access-xyz');
    expect(start.data.snippet).toEqual({
      title: 'Как не потерять залог', description: 'Описание\n\nhttps://my.linkeon.io/?utm_source=youtube', tags: ['аренда', 'залог'],
      categoryId: '27', defaultLanguage: 'ru', defaultAudioLanguage: 'ru',
    });
    expect(start.data.status).toEqual({ privacyStatus: 'public', selfDeclaredMadeForKids: false, containsSyntheticMedia: false });
    expect(http.calls[2]).toMatchObject({ method: 'PUT', url: SESSION });
    expect(http.calls[2].headers?.Authorization).toBe('Bearer access-xyz');
    expect(Buffer.isBuffer(http.calls[2].data)).toBe(true);
  });

  it('заголовок и описание в теле начала сессии — без угловых скобок (YouTube отверг бы их, 400)', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    const dirty = {
      ...video,
      captions: { youtube: { title: 'Залог <по договору>', description: 'Срок < 30 дней, штраф > 10%', tags: ['аренда'] } },
    };
    await svc.upload(dirty, 'public', alive(), 1);
    const start = http.calls[1];
    expect(start.data.snippet.title).toBe('Залог ‹по договору›');
    expect(start.data.snippet.description).toBe('Срок ‹ 30 дней, штраф › 10%');
  });

  it('прошлая сессия загружена — тот же ролик, без новой загрузки', async () => {
    const db = connected({ session: SESSION });
    const http = fakeHttp(TOKEN, reply(200, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    const r = await svc.upload(video, 'public', alive(), 1);
    expect(r.videoId).toBe('abcdefghijk');
    expect(r.resumed).toBe(true);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1].headers).toMatchObject({ Authorization: 'Bearer access-xyz', 'Content-Range': 'bytes */11' });
    expect(db.st.session).toBe(SESSION);
  });

  it('прошлая сессия не догружена или кончилась отказом — адрес стёрт, новая загрузка', async () => {
    for (const answer of [reply(308), reply(400, { error: { message: 'bad metadata' } })]) {
      const db = connected({ session: SESSION });
      const http = fakeHttp(TOKEN, answer, reply(200, {}, { location: `${SESSION}2` }), reply(200, { id: 'newvideo123' }));
      const { svc } = setup(db, http);
      expect((await svc.upload(video, 'public', alive(), 1)).videoId).toBe('newvideo123');
      expect(http.calls).toHaveLength(4);
      expect(db.st.session).toBe(`${SESSION}2`);
    }
  });

  it('прошлая сессия истекла (404) — YoutubeUploadExpired, адрес остаётся (повтор снова пришлёт набор), новой загрузки нет', async () => {
    const db = connected({ session: SESSION });
    const http = fakeHttp(TOKEN, reply(404));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeUploadExpired);
    expect(db.st.session).toBe(SESSION);
    expect(http.calls).toHaveLength(2);
  });

  it('при живой сессии сбой токена или хранилища — YoutubeMaybeUploaded: прошлая загрузка не проверена, адрес остаётся', async () => {
    const a = connected({ session: SESSION });
    expect(await caught(setup(a, fakeHttp(reply(503, {}))).svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(a.st.session).toBe(SESSION);
    const b = connected({ session: SESSION });
    const s = setup(b, fakeHttp(TOKEN));
    s.storage.download.mockRejectedValueOnce(new Error('minio down'));
    expect(await caught(s.svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(b.st.session).toBe(SESSION);
  });

  it('о прошлой сессии исход неизвестен (обрыв сети, 403 без явного лимита, 308 с непонятным Range) — YoutubeMaybeUploaded, адрес остаётся, новой загрузки нет', async () => {
    for (const answer of [
      new Error('ETIMEDOUT'),
      reply(403, { error: { message: 'forbidden', errors: [{ reason: 'forbidden' }] } }),
      reply(308, {}, { range: 'garbage' }),
    ]) {
      const db = connected({ session: SESSION });
      const http = fakeHttp(TOKEN, answer);
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeMaybeUploaded);
      expect(db.st.session).toBe(SESSION);
      // Ровно токен и вопрос о прошлой сессии — новая сессия не начинается.
      expect(http.calls).toHaveLength(2);
    }
  });

  it('invalid_grant — YoutubeAuthError, аккаунт отозван с причиной; при живой сессии — pendingUpload', async () => {
    const a = connected();
    const ea = await caught(setup(a, fakeHttp(reply(400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }))).svc.upload(video, 'public', alive(), 1));
    expect(ea).toBeInstanceOf(YoutubeAuthError);
    expect(ea.pendingUpload).toBe(false);
    expect(a.st.account).toMatchObject({ status: 'revoked', last_error: 'HTTP 400 invalid_grant: Token has been expired or revoked.' });
    const b = connected({ session: SESSION });
    const eb = await caught(setup(b, fakeHttp(reply(400, { error: 'invalid_grant' }))).svc.upload(video, 'public', alive(), 1));
    expect(eb).toBeInstanceOf(YoutubeAuthError);
    expect(eb.pendingUpload).toBe(true);
    expect(b.st.session).toBe(SESSION);
  });

  it('401 при начале сессии — YoutubeNotUploaded, аккаунт не отзываем', async () => {
    const db = connected();
    const { svc } = setup(db, fakeHttp(TOKEN, reply(401, { error: { message: 'Invalid Credentials' } })));
    const e = await caught(svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 401 });
    expect(db.st.account.status).toBe('connected');
  });

  it('токен не расшифровался — YoutubeAuthError и отзыв, без запросов к Google', async () => {
    const db = fakeDb({ mode: 'public', account: { ...CONNECTED, refresh_token_enc: 'битый' } });
    const { svc, http } = setup(db, fakeHttp());
    const e = await caught(svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeAuthError);
    expect(e.message).toMatch(/не расшифровался/);
    expect(db.st.account.status).toBe('revoked');
    expect(http.http).not.toHaveBeenCalled();
  });

  it('файл оборвался, а YouTube говорит «загружено» — успех', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), reply(201, { id: 'abcdefghijk' }));
    const { svc } = setup(db, http);
    const r = await svc.upload(video, 'public', alive(), 1);
    expect(r.videoId).toBe('abcdefghijk');
    expect(r.resumed).toBe(false);
    expect(db.st.session).toBe(SESSION);
  });

  it('файл оборвался, YouTube говорит «не догружено» — YoutubeNotUploaded, адрес стёрт', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), reply(308));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeNotUploaded);
    expect(db.st.session).toBeNull();
  });

  it('файл оборвался, а сессия кончилась отказом — YoutubeNotUploaded с причиной Google, адрес стёрт', async () => {
    const db = connected();
    const http = fakeHttp(
      TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'),
      reply(403, { error: { message: 'limit', errors: [{ reason: 'uploadLimitExceeded' }] } }),
    );
    const { svc } = setup(db, http);
    const e = await caught(svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 403, message: 'отправка файла: HTTP 403 uploadLimitExceeded: limit' });
    expect(db.st.session).toBeNull();
  });

  it('файл оборвался, а о сессии исход неизвестен (обрыв сети, 403 без явного лимита, 308 с непонятным Range) — YoutubeMaybeUploaded, адрес остаётся', async () => {
    for (const answer of [
      new Error('ECONNRESET'),
      reply(403, { error: { message: 'forbidden', errors: [{ reason: 'forbidden' }] } }),
      reply(308, {}, { range: 'garbage' }),
    ]) {
      const db = connected();
      const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), answer);
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeMaybeUploaded);
      expect(db.st.session).toBe(SESSION);
    }
  });

  it('файл: явный отказ 4xx — YoutubeNotUploaded, адрес стёрт (сессия на повторе повторила бы отказ)', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(400, { error: { message: 'bad' } }));
    const { svc } = setup(db, http);
    const e = await caught(svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(e).toMatchObject({ status: 400 });
    expect(db.st.session).toBeNull();
  });

  it('нет файла или подписей — YoutubeNotUploaded без запросов', async () => {
    const { svc, http } = setup(connected());
    expect(await caught(svc.upload({ ...video, videoKey: null }, 'public', alive(), 1))).toBeInstanceOf(YoutubeNotUploaded);
    expect(await caught(svc.upload({ ...video, captions: null }, 'public', alive(), 1))).toBeInstanceOf(YoutubeNotUploaded);
    expect(http.http).not.toHaveBeenCalled();
  });

  it('скачивание — со сроком: в хранилище уходит abortSignal', async () => {
    const db = connected();
    const { svc, storage } = setup(db, fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), reply(201, { id: 'abcdefghijk' })));
    await svc.upload(video, 'public', alive(), 1);
    expect(storage.download).toHaveBeenCalledWith(expect.objectContaining({ key: 'shorts/v1/video.mp4', abortSignal: expect.any(Object) }));
  });

  it('сумма сроков до keepAlive (скачивание, токен, вопрос о сессии, её начало) меньше порога сторожа', () => {
    expect(DOWNLOAD_TIMEOUT_MS + 15_000 + 30_000 + 30_000).toBeLessThan(STUCK_PUBLISHING_MINUTES * 60_000);
  });

  it('нет аккаунта при живой сессии — YoutubeAuthError с pendingUpload', async () => {
    const e = await caught(setup(fakeDb({ mode: 'public', session: SESSION }), fakeHttp()).svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeAuthError);
    expect(e.pendingUpload).toBe(true);
  });

  it('сбой скачивания без прошлой сессии — исходная ошибка', async () => {
    const s = setup(connected(), fakeHttp(TOKEN));
    s.storage.download.mockRejectedValueOnce(new Error('minio down'));
    const e = await caught(s.svc.upload(video, 'public', alive(), 1));
    expect(e).not.toBeInstanceOf(YoutubeMaybeUploaded);
    expect(e.message).toBe('minio down');
  });

  it('файл оборвался, затем 404 — YoutubeUploadExpired, адрес остаётся', async () => {
    const db = connected();
    const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), reply(404));
    const { svc } = setup(db, http);
    expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeUploadExpired);
    expect(db.st.session).toBe(SESSION);
  });

  it('нет CALENDAR_SECRET_KEY — YoutubeNotUploaded, подключение не отзываем', async () => {
    const db = connected();
    delete process.env.CALENDAR_SECRET_KEY;
    const e = await caught(setup(db, fakeHttp()).svc.upload(video, 'public', alive(), 1));
    expect(e).toBeInstanceOf(YoutubeNotUploaded);
    expect(db.st.account.status).toBe('connected');
  });

  it('отзыв — только того подключения, чей токен не сработал', async () => {
    const db = connected();
    const token = db.st.account.refresh_token_enc;
    const { svc } = setup(db, fakeHttp(reply(400, { error: 'invalid_grant' })));
    await caught(svc.upload(video, 'public', alive(), 1));
    const revokeCall = db.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'revoked'")) as any[];
    expect(String(revokeCall[0])).toContain('refresh_token_enc = $2');
    expect(revokeCall[1][1]).toBe(token);
  });

  it('не прочитал аккаунт или адрес прошлой сессии — YoutubeMaybeUploaded, без запросов к Google', async () => {
    const { svc, http } = setup(connected({ sessionThrows: true }), fakeHttp());
    expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeMaybeUploaded);
    expect(http.http).not.toHaveBeenCalled();
  });

  it('план: адрес сессии не прочитан — набор с предупреждением', async () => {
    expect(await setup(fakeDb({ mode: 'manual', sessionThrows: true })).svc.uploadPlan('v1')).toEqual({ kind: 'kit', note: PENDING_UPLOAD_NOTE });
  });

  /**
   * Жетон попытки — attempts, который вернул захват строки YouTube публикатором. Попытка,
   * зависшая дольше порога сторожа, пока строку захватила новая, не читает и не пишет
   * чужой адрес сессии и не шлёт файл: YoutubeAttemptSuperseded.
   */
  describe('жетон попытки', () => {
    const SESSION_B = `${SESSION}-b`;
    const rowWrites = (db: ReturnType<typeof fakeDb>) =>
      db.query.mock.calls.map((c: any[]) => String(c[0]).replace(/\s+/g, ' ').trim()).filter((s) => s.startsWith('UPDATE short_publication'));

    it('строку держит попытка с другим жетоном — YoutubeAttemptSuperseded до любых запросов к Google, строка не тронута', async () => {
      const db = connected({ attempts: 2, session: SESSION_B });
      const { svc, http } = setup(db, fakeHttp());
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(http.http).not.toHaveBeenCalled();
      expect(rowWrites(db)).toEqual([]);
      expect(db.st).toMatchObject({ pub: 'publishing', attempts: 2, session: SESSION_B });
    });

    it('строку уже забрал сторож (failed) — YoutubeAttemptSuperseded, к Google не ходим', async () => {
      const db = connected({ pub: 'failed' });
      const { svc, http } = setup(db, fakeHttp());
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(http.http).not.toHaveBeenCalled();
      expect(rowWrites(db)).toEqual([]);
    });

    it('строки YouTube нет — YoutubeAttemptSuperseded, к Google не ходим', async () => {
      const { svc, http } = setup(connected({ noRow: true }), fakeHttp());
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(http.http).not.toHaveBeenCalled();
    });

    it('пока начиналась сессия, строку захватила другая попытка — YoutubeAttemptSuperseded: адрес не записан, файл не отправлен', async () => {
      const db = connected();
      const http = fakeHttp(TOKEN, () => {
        db.st.attempts = 2; // захват строки новой попыткой
        return reply(200, {}, { location: SESSION });
      });
      const { svc } = setup(db, http);
      const keepAlive = alive();
      expect(await caught(svc.upload(video, 'public', keepAlive, 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(http.calls).toHaveLength(2);
      expect(http.calls.some((c) => c.method === 'PUT')).toBe(false);
      expect(db.st.session).toBeNull();
      expect(keepAlive).not.toHaveBeenCalled();
    });

    it('прошлая сессия не догружена, а к стиранию адреса строку держит другая попытка — YoutubeAttemptSuperseded: адрес не стёрт, новой сессии нет', async () => {
      const db = connected({ session: SESSION_B });
      const http = fakeHttp(TOKEN, () => {
        db.st.attempts = 2; // пока спрашивали YouTube, строку захватила новая попытка
        return reply(308);
      });
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(db.st.session).toBe(SESSION_B);
      expect(http.calls).toHaveLength(2); // токен и вопрос о прошлой сессии — начала новой нет
    });

    it('продление живости перед файлом не прошло — YoutubeAttemptSuperseded, файл не отправлен, свой адрес остаётся для следующей попытки', async () => {
      const db = connected();
      const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }));
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', jest.fn(async () => false), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(http.calls).toHaveLength(2);
      expect(db.st.session).toBe(SESSION);
    });

    it('файл получил явный отказ, а к стиранию адреса строку держит другая попытка — YoutubeAttemptSuperseded, а не «не стёрто + отказ»', async () => {
      const db = connected();
      const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), () => {
        db.st.attempts = 2; // пока шёл файл, строку захватила новая попытка
        return reply(400, { error: { message: 'bad' } });
      });
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(db.st.session).toBe(SESSION);
    });

    it('файл оборвался, YouTube говорит «не догружено», а к стиранию адреса строку держит другая попытка — YoutubeAttemptSuperseded, адрес не стёрт', async () => {
      const db = connected();
      const http = fakeHttp(TOKEN, reply(200, {}, { location: SESSION }), new Error('socket hang up'), () => {
        db.st.attempts = 2; // пока спрашивали YouTube, строку захватила новая попытка
        return reply(308);
      });
      const { svc } = setup(db, http);
      expect(await caught(svc.upload(video, 'public', alive(), 1))).toBeInstanceOf(YoutubeAttemptSuperseded);
      expect(db.st.session).toBe(SESSION);
    });
  });
});

describe('сообщение о загрузке', () => {
  const URL = 'https://youtube.com/shorts/abcdefghijk';

  it('«по ссылке» — ссылка и подсказка про «публично»', async () => {
    const { svc, said } = setup(fakeDb({ mode: 'unlisted', published: URL }));
    await svc.notifyUploaded('v1', 'unlisted');
    expect(said()).toEqual([`Вышло на YouTube (по ссылке): ${URL}\nЕсли ролик открывается и не стал приватным — /youtube публично.`]);
  });

  it('доступ — тот, с которым грузили, а не текущий режим; набор (строки published нет) — молчим', async () => {
    const a = setup(fakeDb({ mode: 'manual', published: URL }));
    await a.svc.notifyUploaded('v1', 'public');
    expect(a.said()).toEqual([`Вышло на YouTube (публично): ${URL}`]);
    const b = setup(fakeDb({ mode: 'public' }));
    await b.svc.notifyUploaded('v1', 'public');
    expect(b.tg.sendMessage).not.toHaveBeenCalled();
  });

  it('ролик нашёлся по прошлой сессии (доступ неизвестен) — без слова доступа и подсказки', async () => {
    const { svc, said } = setup(fakeDb({ mode: 'public', published: URL }));
    await svc.notifyUploaded('v1', null);
    expect(said()).toEqual([`Вышло на YouTube: ${URL}`]);
  });
});
