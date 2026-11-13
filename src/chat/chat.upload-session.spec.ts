import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';
import { relaySessionKey } from './relay-session';
import { verifyProductToolToken } from '../products/product-tool.token';
import { relayFsKey } from './linkeon-relay-fields';
import { verifyLinkeonToolToken } from '../mcp/linkeon-tool.token';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

// relayFsKey (ревью 26.10.2026) без секретов не выдаёт fs_key вовсе — тестам
// этого файла, которые сверяют fs_key, нужен хоть один.
const OLD_JWT_SECRET = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'chat-upload-session-spec'; });
afterAll(() => {
  if (OLD_JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_JWT_SECRET;
});

/**
 * Ход с ВЛОЖЕНИЯМИ уходит в ТУ ЖЕ сессию релея, что и текстовый ход.
 *
 * Инцидент 08.09.2026, пользователь 79030169187: прислал выписку ЕГРИП, получил
 * разбор, а через девять минут на вопрос «выписка на сколько листов?» услышал
 * «точного числа заранее не назвать» — файл к тому моменту десять минут лежал на
 * диске релея. Такой же провал был на каждом файле за три недели до этого.
 *
 * Причина: два ключа сессии на один разговор. Текстовый ход шёл в
 * `<userId>_<assistantId>_<язык>`, загрузка — в `<userId>_<assistantId>`.
 * Путь к файлу объявляется в промпте только той сессии, куда файл прислали;
 * `_<язык>`-сессия резюмится и блок `history` при resume не получает, так что
 * до неё не доходила даже строка `📎 имя` из нашей БД.
 *
 * Тест проверяет ровно поля, уезжающие на релей: сам ключ, персону и историю.
 * Проверять ответ модели тут нечего — сломанный путь возвращал связный текст,
 * просто собранный без файла.
 */

const ANSWER = 'Готово.';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const AGENT = {
  id: 12,
  name: 'Роман',
  display_name: 'Роман',
  description: 'бизнес-ассистент',
  system_prompt: 'Ты Роман, помогаешь с налогами и документами.',
  category: 'business',
  is_active: true,
};

interface Pg {
  query: jest.Mock;
  calls: { sql: string; params: any[] }[];
}

function makePg(
  profileData: unknown = { automaticProfiling: true },
  profilingSequence?: boolean[],
  agentSystemPrompt = AGENT.system_prompt,
): Pg {
  const sequence = [...(profilingSequence || [])];
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
    if (/SELECT profile_data FROM ai_profiles_consolidated/.test(sql)) {
      const data = profilingSequence
        ? { automaticProfiling: sequence.length > 0 ? sequence.shift() : false }
        : profileData;
      return { rows: [{ profile_data: data }] };
    }
    if (/FROM agents WHERE id/.test(sql)) return { rows: [{ ...AGENT, system_prompt: agentSystemPrompt }] };
    if (/FROM agents a\s+LEFT JOIN agent_translations/.test(sql)) {
      return { rows: [{ display_name: 'Оля', description: 'коуч' }] };
    }
    if (/FROM custom_chat_history/.test(sql) && /SELECT sender_type/.test(sql)) {
      return { rows: [
        { sender_type: 'ai', content: 'Собрал обращение заново.' },
        { sender_type: 'human', content: 'еще раз составь обращение' },
      ] };
    }
    return { rows: [] };
  });
  return { query, calls } as Pg;
}

function makeService(
  pg: Pg,
  lang = 'ru',
  businessProfile?: { renderForPrompt: jest.Mock },
): ChatService {
  // Тот же контракт, что у текстового хода: профиль главный, поле `lang` из
  // запроса — подстраховка на случай, когда язык туда ещё не доехал.
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || lang) };
  return new ChatService(
    pg as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
    businessProfile as any,
  );
}

function makeReq(body: any = {}) {
  return {
    headers: { authorization: 'Bearer token' },
    files: [{ originalname: 'egrul.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message: 'что тут по листам?', assistantId: '12', ...body },
  } as any;
}

function makeRes() {
  const written: any[] = [];
  return {
    written,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

const PROFILE = 'Дмитрий, ИП прекращено 2021';
const BUSINESS_PROFILE = 'BUSINESS PROFILE COPY MARKER';

/** Прогоняет upload-and-chat и отдаёт поля, ушедшие на релей. */
async function upload(
  pg: Pg,
  body: any = {},
  businessProfile?: { renderForPrompt: jest.Mock },
): Promise<Record<string, string>> {
  const svc = makeService(pg, 'ru', businessProfile);
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
  const ctrl = new ChatController(svc, jwtSvc as any, neo4j as any, undefined);
  const post = jest.fn(async () => ({ data: sseStream([{ type: 'delta', text: ANSWER }, { type: 'done' }]) }));
  (axios as any).default = { post };
  (axios as any).post = post;

  await ctrl.uploadAndChat(makeReq(body), makeRes());
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  expect(post).toHaveBeenCalled();
  return fieldsOf(post.mock.calls[0][1]);
}

/** Как upload(), но со своей лентой событий релея; отдаёт и поля, и то, что ушло клиенту. */
async function uploadRun(body: any, events: any[]): Promise<{ fields: Record<string, string>; written: any[] }> {
  const svc = makeService(makePg());
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
  const ctrl = new ChatController(svc, jwtSvc as any, neo4j as any, undefined);
  const post = jest.fn(async () => ({ data: sseStream(events) }));
  (axios as any).default = { post };
  (axios as any).post = post;
  const res = makeRes();
  await ctrl.uploadAndChat(makeReq(body), res);
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  return { fields: fieldsOf((post.mock.calls[0] as any[])[1]), written: res.written };
}

describe('relaySessionKey', () => {
  it('обычный ход: язык — часть ключа', () => {
    expect(relaySessionKey('u1', '12', 'ru')).toBe('u1_12_ru');
    expect(relaySessionKey('u1', '12', 'en')).toBe('u1_12_en');
  });

  it('чистый лист: ключ fresh-сессии перебивает всё', () => {
    expect(relaySessionKey('u1', '12', 'ru', 'u1_12_fresh_1786468316338'))
      .toBe('u1_12_fresh_1786468316338');
  });
});

describe('uploadAndChat: файл уходит в сессию разговора, а не в свою', () => {
  afterEach(() => jest.clearAllMocks());

  it('ключ сессии — тот же, что у текстового хода', async () => {
    const fields = await upload(makePg());

    expect(fields.sessionId).toBe(relaySessionKey('u1', '12', 'ru'));
    // Ровно то, что делал сломанный путь: ключ без языка, отдельная сессия.
    expect(fields.sessionId).not.toBe('u1_12');
  });

  it('язык из запроса доезжает до ключа: пустой язык профиля не разводит сессии', async () => {
    const fields = await upload(makePg(), { lang: 'en' });

    expect(fields.sessionId).toBe('u1_12_en');
  });

  it('чистый лист: файл уходит в fresh-сессию, а не в основную', async () => {
    const fields = await upload(makePg(), { fresh: 'true', freshTs: '1786468316338' });

    expect(fields.sessionId).toBe('u1_12_fresh_1786468316338');
  });

  it('везёт персону ассистента: иначе на файл ответит generic-агент релея', async () => {
    // Релей всегда передаёт --system-prompt, подставляя свой «universal agent»,
    // когда поля нет. При общей сессии это подменяло бы Романа на каждом ходе
    // с файлом — новый системный промпт применяется и при --resume.
    const fields = await upload(makePg());

    expect(fields.systemPrompt).toContain('Роман');
    expect(fields.systemPrompt).toContain(AGENT.system_prompt);
  });

  it('везёт хвост переписки: холодный старт сессии не теряет разговор', async () => {
    const fields = await upload(makePg());

    expect(fields.history).toContain('еще раз составь обращение');
  });

  it('профиль уезжает в системный промпт, а не в текст реплики', async () => {
    // Раньше профиль клеился в начало message и оседал в истории сессии
    // отдельной копией на каждый ход с файлом.
    const fields = await upload(makePg());

    expect(fields.systemPrompt).toContain(PROFILE);
    expect(fields.message).toBe('что тут по листам?');
  });

  it('missing automaticProfiling key остаётся enabled', async () => {
    const fields = await upload(makePg({}));

    expect(fields.systemPrompt).toContain(PROFILE);
    expect(fields.sessionId).toBe(relaySessionKey('u1', '12', 'ru'));
  });

  it('revoked upload не resumeит profile-bearing сессию', async () => {
    const fields = await upload(makePg({ automaticProfiling: false }));

    expect(fields.systemPrompt || '').not.toContain(PROFILE);
    expect(fields.sessionId).toBe(`${relaySessionKey('u1', '12', 'ru')}_noprofiling`);
  });

  it('перепроверяет consent и sanitizes prompt на multipart boundary', async () => {
    // Персона и первичная сборка ещё видели разрешение; непосредственно перед
    // fd.append настройка отозвана. Ранний builder gate здесь недостаточен.
    const fields = await upload(
      makePg({ automaticProfiling: false }, [true, true, true, false]),
    );

    expect(fields.systemPrompt || '').not.toContain(PROFILE);
    expect(fields.systemPrompt || '').not.toContain('User profile:');
    expect(fields.systemPrompt || '').toContain(AGENT.system_prompt);
    expect(fields.sessionId).toBe(`${relaySessionKey('u1', '12', 'ru')}_noprofiling`);
  });

  it('на multipart boundary удаляет builder copies, а не совпадающие фрагменты персоны', async () => {
    const personalBlock = `User profile:\n${PROFILE}\n\n`;
    const businessBlock = `${BUSINESS_PROFILE}\n\n`;
    const persona = `PERSONA BEFORE\n${personalBlock}${businessBlock}PERSONA AFTER`;
    const fields = await upload(
      makePg(
        { automaticProfiling: false },
        [true, true, true, true, false],
        persona,
      ),
      {},
      { renderForPrompt: jest.fn(async () => BUSINESS_PROFILE) },
    );

    expect(fields.systemPrompt.split(personalBlock)).toHaveLength(2);
    expect(fields.systemPrompt.split(businessBlock)).toHaveLength(2);
    expect(fields.systemPrompt).toContain(
      `--- Персона и инструкции ассистента Роман ---\n${persona}\n\n`,
    );
    expect(fields.sessionId).toBe(`${relaySessionKey('u1', '12', 'ru')}_noprofiling`);
  });

  it('везёт поля точки продуктов — продукты, файлы и справка, как у текстового хода', async () => {
    const f = await upload(makePg(), { ui: JSON.stringify({ activity: true, ask: true }) });
    expect(f.products_mcp_url).toMatch(/\/webhook\/mcp\/products$/);
    expect(verifyProductToolToken(f.products_token)).toEqual({ userId: 'u1', channel: 'web', lang: 'ru', client: 'web', agent: 'staff', turn: null });
  });

  it('без ui (Flutter) — клиент app', async () => {
    const f = await upload(makePg());
    expect(verifyProductToolToken(f.products_token).client).toBe('app');
  });
});

describe('uploadAndChat: инструменты Linkeon и папка хода', () => {
  afterEach(() => jest.clearAllMocks());

  it('везёт токен хода, адрес точки и fs_key той же сессии, что у текстового хода', async () => {
    const f = await upload(makePg());
    expect(verifyLinkeonToolToken(f.linkeon_token)).toEqual({ userId: 'u1' });
    expect(f.linkeon_mcp_url).toMatch(/\/webhook\/mcp\/linkeon$/);
    expect(f.fs_key).toBe(relayFsKey(relaySessionKey('u1', '12', 'ru')));
  });

  it('шаг работы: загрузка с префиксом fs_key — без префикса', async () => {
    const fsKey = relayFsKey(relaySessionKey('u1', '12', 'ru'));
    const { written } = await uploadRun({ ui: JSON.stringify({ activity: true, ask: false }) }, [
      { type: 'tool', tool: 'Read', input: JSON.stringify({ file_path: `/tmp/agent-uploads/${fsKey}_egrul.pdf` }) },
      { type: 'delta', text: ANSWER },
      { type: 'done' },
    ]);
    expect(written).toContainEqual({ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' });
  });
});

/** Синтетическая запись chat_uploads — общая для тестов памяти загрузок. */
const UPLOAD_RECORD = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u1',
  sessionId: 'u1_12',
  originalName: 'a.pdf',
  mime: 'application/pdf',
  sizeBytes: 1,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  storageKey: 'synthetic/a.pdf',
  createdAt: '2026-11-13T00:00:00.000Z',
};
const UPLOAD_LINK = '📎 [a.pdf](/webhook/chat-uploads/11111111-1111-4111-8111-111111111111)';

function makeChatUploadsMock(result: { saved: any[]; failed: string[] }) {
  return {
    saveOriginals: jest.fn(async () => result),
    ownerUrl: jest.fn((id: string) => `/webhook/chat-uploads/${id}`),
  };
}

function makeUploadReq(name: string, message: string) {
  return {
    headers: { authorization: 'Bearer token' },
    files: [{ originalname: name, buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message, assistantId: '12' },
  } as any;
}

/**
 * Память загрузок (spec 2026-11-13-chat-upload-memory, Task 3): исходник
 * уезжает в наше хранилище ДО отправки на релей, а приватная ссылка на него
 * ложится в историю — даже если ассистент ответил полной пустотой. Иначе
 * файл, присланный на упавшем ходе, не находился бы ни после ротации, ни
 * на следующий вопрос.
 */
describe('uploadAndChat: исходник сохраняется до релея', () => {
  const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeEach(() => { process.env.CHAT_UPLOADS_ENABLED = 'true'; });
  afterEach(() => {
    jest.clearAllMocks();
    if (OLD_UPLOADS_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_UPLOADS_FLAG;
  });

  it('сохраняет исходник до relay и кладёт ссылку в историю даже при пустом ответе', async () => {
    const chatUploads = makeChatUploadsMock({ saved: [UPLOAD_RECORD], failed: [] });
    const svc = makeService(makePg());
    const persist = jest.spyOn(svc, 'persistUploadTurn').mockResolvedValue(0);
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
    // Контроллер собирается позиционно; chatUploads — последний опциональный
    // аргумент (до появления в сигнатуре каст, чтобы RED компилировался).
    const ctrl = new (ChatController as any)(svc, jwtSvc, neo4j, undefined, undefined, chatUploads);
    // Пустой ответ: ни delta, ни done — поток сразу заканчивается.
    const post = jest.fn(async () => ({ data: sseStream([]) }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const res = makeRes();

    await ctrl.uploadAndChat(makeUploadReq('a.pdf', 'что тут написано?'), res);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    // Исходник сохранён ДО запроса на релей: даже если релей упадёт, файл останется.
    expect(chatUploads.saveOriginals).toHaveBeenCalledTimes(1);
    expect(chatUploads.saveOriginals.mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
    expect(chatUploads.saveOriginals.mock.calls[0][0].userId).toBe('u1');
    // Сессия истории — userId_assistantId (без языкового суффикса релея).
    expect(chatUploads.saveOriginals.mock.calls[0][0].sessionId).toBe('u1_12');

    // Пустой ответ ассистента не отменяет запись истории: пользовательское
    // сообщение с приватной ссылкой на исходник обязано сохраниться.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].userMsg).toContain(UPLOAD_LINK);
    expect(persist.mock.calls[0][0].userMsg).toContain('что тут написано?');

    // M6 (ревью 13.11.2026): успешное сохранение (failed=[]) не выдаёт
    // upload_persist_failed — событие только для реальных сбоев.
    expect(res.written.some((w: any) => w.type === 'upload_persist_failed')).toBe(false);
  });
});

/**
 * Ревью I1 (13.11.2026): сохранение исходников идёт ДО первого байта ответа
 * (до res.status/begin). Деградация MinIO/Postgres не должна держать клиента
 * на молчащем соединении: nginx режет 504, а бэкенд продолжает и платит за
 * ход релея, который никто не ждёт. Сохранение ограничено бюджетом
 * CHAT_UPLOADS_SAVE_BUDGET_MS (дефолт 20с): при превышении ход продолжается
 * без исходников, а клиенту уходит upload_persist_failed.
 */
describe('uploadAndChat: бюджет сохранения исходников (ревью I1)', () => {
  const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  const OLD_BUDGET = process.env.CHAT_UPLOADS_SAVE_BUDGET_MS;
  beforeEach(() => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    // Инъекция короткого бюджета: не ждём 20с и не воюем с фейковыми таймерами.
    process.env.CHAT_UPLOADS_SAVE_BUDGET_MS = '30';
  });
  afterEach(() => {
    jest.clearAllMocks();
    if (OLD_UPLOADS_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_UPLOADS_FLAG;
    if (OLD_BUDGET === undefined) delete process.env.CHAT_UPLOADS_SAVE_BUDGET_MS;
    else process.env.CHAT_UPLOADS_SAVE_BUDGET_MS = OLD_BUDGET;
  });

  function setup(chatUploads: any, events: any[]) {
    const svc = makeService(makePg());
    const persist = jest.spyOn(svc, 'persistUploadTurn').mockResolvedValue(0);
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
    const ctrl = new (ChatController as any)(svc, jwtSvc, neo4j, undefined, undefined, chatUploads);
    const post = jest.fn(async () => ({ data: sseStream(events) }));
    (axios as any).default = { post };
    (axios as any).post = post;
    return { svc, persist, ctrl, post };
  }

  it('saveOriginals висит — через бюджет ход продолжается без него и с upload_persist_failed', async () => {
    const chatUploads = {
      // Никогда не резолвится: имитация зависшего MinIO. Поздний reject
      // обязан гаситься в контроллере, не становясь unhandledRejection.
      saveOriginals: jest.fn(() => new Promise<any>(() => {})),
      ownerUrl: jest.fn((id: string) => `/webhook/chat-uploads/${id}`),
    };
    const { persist, ctrl, post } = setup(chatUploads, [
      { type: 'delta', text: ANSWER },
      { type: 'done' },
    ]);
    const res = makeRes();

    await ctrl.uploadAndChat(makeUploadReq('a.pdf', 'что тут написано?'), res);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    // Релей вызван и ответ доставлен несмотря на зависшее сохранение.
    expect(post).toHaveBeenCalled();
    expect(res.written).toContainEqual({
      type: 'upload_persist_failed',
      content: 'Файл не сохранён для будущих разговоров',
    });
    expect(res.written.find((w: any) => w.type === 'end')?.content).toBe(ANSWER);
    expect(res.end).toHaveBeenCalled();
    // Ничего не сохранено — история в прежнем формате, без ссылок.
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].userMsg).toBe('📎 a.pdf\nчто тут написано?');
  });

  it('быстрый saveOriginals — бюджет не срабатывает, upload_persist_failed нет', async () => {
    const chatUploads = makeChatUploadsMock({ saved: [UPLOAD_RECORD], failed: [] });
    const { persist, ctrl, post } = setup(chatUploads, [
      { type: 'delta', text: ANSWER },
      { type: 'done' },
    ]);
    const res = makeRes();

    await ctrl.uploadAndChat(makeUploadReq('a.pdf', 'что тут написано?'), res);
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    expect(post).toHaveBeenCalled();
    expect(res.written.some((w: any) => w.type === 'upload_persist_failed')).toBe(false);
    expect(persist.mock.calls[0][0].userMsg).toContain(UPLOAD_LINK);
  });
});

/**
 * Ревью I2 (13.11.2026): при невыставленном флаге строка истории обязана
 * байт-в-байт совпадать с прежней `📎 имена\nсообщение` (historyMerge.ts
 * сверяет строки истории посимвольно), а сохранение исходников не вызывается.
 */
describe('uploadAndChat: инвариант истории при выключенной фиче (ревью I2)', () => {
  const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeEach(() => { delete process.env.CHAT_UPLOADS_ENABLED; });
  afterEach(() => {
    jest.clearAllMocks();
    if (OLD_UPLOADS_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_UPLOADS_FLAG;
  });

  it('флаг не выставлен — userMsg посимвольно старого формата, saveOriginals не вызван', async () => {
    const chatUploads = makeChatUploadsMock({ saved: [], failed: [] });
    const svc = makeService(makePg());
    const persist = jest.spyOn(svc, 'persistUploadTurn').mockResolvedValue(0);
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
    const ctrl = new (ChatController as any)(svc, jwtSvc, neo4j, undefined, undefined, chatUploads);
    const post = jest.fn(async () => ({ data: sseStream([{ type: 'delta', text: ANSWER }, { type: 'done' }]) }));
    (axios as any).default = { post };
    (axios as any).post = post;

    await ctrl.uploadAndChat(makeUploadReq('scan.jpg', 'переведи'), makeRes());
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));

    expect(chatUploads.saveOriginals).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0].userMsg).toBe('📎 scan.jpg\nпереведи');
  });
});

/**
 * Ревью I3 (13.11.2026): обучение профиля (consolidateAfterChatPublic) —
 * LLM-вызов, ему нужен текст ассистента. При записи хода с пустым ответом
 * (ради ссылки на файл в истории) вызываться не должен; при непустом —
 * работает как раньше.
 */
describe('uploadAndChat: гейт consolidate (ревью I3)', () => {
  const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
  beforeEach(() => { process.env.CHAT_UPLOADS_ENABLED = 'true'; });
  afterEach(() => {
    jest.clearAllMocks();
    if (OLD_UPLOADS_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
    else process.env.CHAT_UPLOADS_ENABLED = OLD_UPLOADS_FLAG;
  });

  async function runWith(events: any[]) {
    const chatUploads = makeChatUploadsMock({ saved: [UPLOAD_RECORD], failed: [] });
    const svc = makeService(makePg());
    const persist = jest.spyOn(svc, 'persistUploadTurn').mockResolvedValue(0);
    const consolidate = jest.spyOn(svc, 'consolidateAfterChatPublic').mockResolvedValue(undefined);
    const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
    const neo4j = { getProfileDescription: jest.fn(async () => PROFILE) };
    const ctrl = new (ChatController as any)(svc, jwtSvc, neo4j, undefined, undefined, chatUploads);
    const post = jest.fn(async () => ({ data: sseStream(events) }));
    (axios as any).default = { post };
    (axios as any).post = post;

    await ctrl.uploadAndChat(makeUploadReq('a.pdf', 'что тут написано?'), makeRes());
    for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    return { persist, consolidate };
  }

  it('пустой ответ — история записана, consolidate не вызван', async () => {
    const { persist, consolidate } = await runWith([]);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(consolidate).not.toHaveBeenCalled();
  });

  it('непустой ответ — consolidate вызван, как раньше', async () => {
    const { persist, consolidate } = await runWith([
      { type: 'delta', text: ANSWER },
      { type: 'done' },
    ]);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(consolidate).toHaveBeenCalledTimes(1);
    expect(consolidate.mock.calls[0][2]).toContain(UPLOAD_LINK);
    expect(consolidate.mock.calls[0][3]).toBe(ANSWER);
  });
});
