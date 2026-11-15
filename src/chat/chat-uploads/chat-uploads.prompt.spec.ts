import 'reflect-metadata';
import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from '../chat.service';
import { ChatUploadsService, ChatUploadRecord } from './chat-uploads.service';

jest.mock('axios');
jest.mock('../../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * Память загрузок в текущем чате (spec 2026-11-13-chat-upload-memory, Task 6).
 *
 * Каждый текстовый ход — обычный resume, холодный старт и «чистый лист» —
 * везёт в теле реплики к релею последние загрузки сессии (до 10): имя и
 * короткоживущую подписанную ссылку. При ротации релей вырезает блок
 * `User uploaded files` из переносимого хвоста, и до этой правки память о
 * файле терялась; теперь она восстанавливается из реестра chat_uploads.
 *
 * Подписанная ссылка живёт ТОЛЬКО в пер-ходовой части (поле message):
 * stablePrefix (systemPrompt) уходит релею один раз и кэшируется, а подпись
 * чеканится заново каждый ход — там она сломала бы кэш промпта и утекла бы
 * в долгоживущие поверхности.
 *
 * Запрос к реестру идёт по СЫРОМУ ключу сессии Postgres (freshSessionId или
 * `<userId>_<assistantId>`) — тому же, что у custom_chat_history и
 * chat_uploads, а не по ключу релея с языковым суффиксом.
 */

const OLD_JWT_SECRET = process.env.JWT_SECRET;
const OLD_BACKEND_URL = process.env.BACKEND_URL;
const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
const realSetTimeout = global.setTimeout;

function restoreEnv(name: string, old: string | undefined): void {
  if (old === undefined) delete process.env[name];
  else process.env[name] = old;
}

beforeAll(() => {
  // assistantUrl подписывает ссылку JWT_SECRET и берёт хост из BACKEND_URL.
  process.env.JWT_SECRET = 'chat-uploads-prompt-spec';
  process.env.BACKEND_URL = 'https://backend.test';
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  restoreEnv('JWT_SECRET', OLD_JWT_SECRET);
  restoreEnv('BACKEND_URL', OLD_BACKEND_URL);
  restoreEnv('CHAT_UPLOADS_ENABLED', OLD_UPLOADS_FLAG);
});

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

/** Синтетическая запись реестра — без единого байта реальных данных. */
const RECORD: ChatUploadRecord = {
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'u-test',
  sessionId: 'u-test_12',
  originalName: 'a.pdf',
  mime: 'application/pdf',
  sizeBytes: 1,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  storageKey: 'synthetic/a.pdf',
  createdAt: '2026-11-13T00:00:00.000Z',
};

/** Настоящий ChatUploadsService (assistantBlock чеканит реальную подпись), выборка — мок. */
function makeUploads(recent: ChatUploadRecord[] = [RECORD]) {
  const pgStub = { query: jest.fn(async () => ({ rows: [] })) };
  const storageStub = {
    createBucketIfAbsent: jest.fn(),
    upload: jest.fn(),
    delete: jest.fn(),
    downloadStream: jest.fn(),
  };
  const uploads = new ChatUploadsService(pgStub as any, storageStub as any);
  const recentSpy = jest.spyOn(uploads, 'recentForSession').mockResolvedValue(recent);
  return { uploads, recentSpy };
}

function makeSvc(uploads?: ChatUploadsService): { svc: ChatService; pg: { query: jest.Mock } } {
  const pg = {
    query: jest.fn(async (sql: string) =>
      /AS spent/.test(sql) ? { rows: [{ spent: 0 }] } : { rows: [] },
    ),
  };
  const language = {
    resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru'),
  };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined, undefined, undefined, undefined,
  );
  // Позиционная сборка до последнего параметра не доходит — подставляем полем
  // (тот же приём, что у redis в chat.service.guest-carry.spec.ts).
  if (uploads) (svc as any).chatUploads = uploads;
  return { svc, pg: pg as { query: jest.Mock } };
}

/** Прогон текстового хода и поля, ушедшие на релей. */
async function run(
  svc: ChatService,
  message: string,
  opts: { fresh?: boolean; history?: { type: string; content: string }[]; probe?: boolean } = {},
): Promise<Record<string, string>> {
  const post = axios.post as jest.Mock;
  post.mockClear();
  post.mockImplementation(async () => ({
    data: sseStream([{ type: 'delta', text: 'ок' }, { type: 'done' }]),
  }));
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
  };
  await (svc as any).streamUniversalAgent(
    'u-test', message, '12', '12',
    opts.history ?? [], '', res,
    'Роман', '', '',
    undefined,
    !!opts.fresh,
    opts.fresh ? 'u-test_12_fresh_1' : undefined,
    // requestLang, clientTz, balanceBlock, agentCategory
    undefined, undefined, undefined, undefined,
    !!opts.probe,
  );
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
  expect(post).toHaveBeenCalled();
  return fieldsOf(post.mock.calls[0][1]);
}

describe('streamUniversalAgent: память последних загрузок', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CHAT_UPLOADS_ENABLED = 'true';
  });

  it('после ротации prompt снова содержит имя и подписанную ссылку', async () => {
    const { uploads, recentSpy } = makeUploads();
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'что в файле?');

    expect(fields.message).toContain('Earlier user uploads');
    expect(fields.message).toContain('a.pdf');
    expect(fields.message).toContain('sig=');
    // I2 (ревью): блок модель видит каждый ход — заголовок обязан запрещать
    // показ подписанного адреса пользователю: ссылка осядет в истории и
    // протухнет через час. Файл пользователю — только через url из find_files.
    expect(fields.message).toContain('NEVER show');
    // Подписанная ссылка — только в пер-ходовой части, не в системном промпте.
    expect(fields.systemPrompt || '').not.toContain('sig=');
    expect(fields.systemPrompt || '').not.toContain('Earlier user uploads');
    // Запрос к реестру — по сырому ключу сессии Postgres, без языкового суффикса релея.
    expect(recentSpy).toHaveBeenCalledWith('u-test', 'u-test_12', []);
    expect(recentSpy.mock.calls[0][1]).not.toContain('_ru');
    // Блок стоит до формы ответа и языковой строки; реплика заканчивается текстом пользователя.
    const uploadsAt = fields.message.indexOf('Earlier user uploads');
    const formAt = fields.message.indexOf('--- ФОРМА ОТВЕТА ---');
    expect(formAt).toBeGreaterThan(uploadsAt);
    expect(fields.message.endsWith('что в файле?')).toBe(true);
  });

  it('холодный старт: блок в теле хода, в history подписанных ссылок нет', async () => {
    const { uploads } = makeUploads();
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'напомни, что было в файле?', {
      history: [
        { type: 'user', content: 'ранний вопрос' },
        { type: 'assistant', content: 'ранний ответ' },
      ],
    });

    expect(fields.message).toContain('Earlier user uploads');
    expect(fields.message).toContain('sig=');
    expect(fields.history).toContain('ранний вопрос');
    expect(fields.history).not.toContain('sig=');
    expect(fields.history).not.toContain('Earlier user uploads');
  });

  it('чистый лист: блок есть, реестр опрошен по fresh-сессии', async () => {
    const { uploads, recentSpy } = makeUploads();
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'новая тема — что было в файле?', { fresh: true });

    expect(fields.message).toContain('Earlier user uploads');
    expect(fields.message).toContain('a.pdf');
    expect(recentSpy).toHaveBeenCalledWith('u-test', 'u-test_12_fresh_1', []);
  });

  it('флаг выключен — блока нет нигде, реестр не опрашивается', async () => {
    delete process.env.CHAT_UPLOADS_ENABLED;
    const { uploads, recentSpy } = makeUploads();
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'что в файле? (флаг выключен)');

    expect(recentSpy).not.toHaveBeenCalled();
    expect(fields.message).not.toContain('Earlier user uploads');
    expect(fields.message).not.toContain('sig=');
    expect(fields.systemPrompt || '').not.toContain('sig=');
  });

  it('сбой реестра — не повод ронять ход', async () => {
    const { uploads, recentSpy } = makeUploads();
    recentSpy.mockRejectedValue(new Error('db down'));
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'что в файле? (сбой БД)');

    expect(fields.message).not.toContain('Earlier user uploads');
    expect(fields.message.endsWith('что в файле? (сбой БД)')).toBe(true);
  });

  it('пинг мониторинга (probe) блок не везёт и реестр не опрашивает', async () => {
    const { uploads, recentSpy } = makeUploads();
    const { svc } = makeSvc(uploads);
    const fields = await run(svc, 'ответь одним словом ок', { probe: true });

    expect(recentSpy).not.toHaveBeenCalled();
    expect(fields.message).not.toContain('Earlier user uploads');
  });

  it('M6: в custom_chat_history уходит СЫРОЙ текст — подписанная ссылка не сохраняется', async () => {
    // Блок живёт только в пер-ходовой части запроса к релею. Ранняя запись
    // человеческой строки (saveUserMessageRow) обязана нести исходное
    // сообщение: подпись в истории утечёт в долгоживущую поверхность
    // (GET /webhook/chat/history, выгрузки) и всё равно умрёт через час.
    const { uploads } = makeUploads();
    const { svc, pg } = makeSvc(uploads);
    const fields = await run(svc, 'что в файле?');

    // Блок действительно был в ходе — иначе проверка истории ничего не значит.
    expect(fields.message).toContain('Earlier user uploads');
    expect(fields.message).toContain('sig=');

    const humanInserts = pg.query.mock.calls.filter(
      ([sql, params]) =>
        String(sql).startsWith('INSERT INTO custom_chat_history') &&
        String(sql).includes("'human'") &&
        Array.isArray(params),
    );
    expect(humanInserts.length).toBeGreaterThan(0);
    for (const [, params] of humanInserts) {
      const serialized = JSON.stringify(params);
      expect(serialized).not.toContain('sig=');
      expect(serialized).not.toContain('Earlier user uploads');
      expect(serialized).not.toContain('exp=');
    }
    // Сырой текст пользователя сохранён как есть.
    expect(
      humanInserts.some(([, params]) => (params as any[]).includes('что в файле?')),
    ).toBe(true);
  });
});

/**
 * Сторож DI (по духу chat.service.guest-carry.spec.ts): зависимость обязана
 * быть объявлена КЛАССОМ ChatUploadsService. Интерфейс стёрся бы в Object при
 * компиляции, Nest не нашёл бы провайдер, и @Optional() молча подставил
 * undefined — на проде память загрузок не сработала бы никогда.
 */
describe('ChatService: DI-тип памяти загрузок', () => {
  it('конструктор объявляет зависимость классом ChatUploadsService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatService);
    expect(Array.isArray(paramTypes)).toBe(true);
    expect(paramTypes).toContain(ChatUploadsService);
  });
});
