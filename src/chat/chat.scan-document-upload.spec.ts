jest.mock('multer', () => {
  // Разбор multipart не нужен: тест кладёт файл и поля в req сам. Остальное
  // (memoryStorage и прочие свойства) — настоящее, чтобы не задеть соседей.
  const actual = jest.requireActual('multer');
  const multer: any = (...args: unknown[]) => ({
    ...actual(...args),
    single: () => (_req: unknown, _res: unknown, cb: (err?: unknown) => void) => cb(),
  });
  Object.assign(multer, actual);
  return multer;
});
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  ...jest.requireActual('@anthropic-ai/claude-agent-sdk'),
  query: jest.fn(),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ChatController } from './chat.controller';

/**
 * PDF, который Маша разбирает через scan-document, сохраняется в реестр
 * загрузок (spec 2026-11-16-chat-uploads-media-notes): source='scan', всегда
 * основная сессия Маши `<userId>_3` — поля «Чистого листа» не читаются (лента
 * у ассистента одна, ветка feat/context-reset). Сбой или долгое сохранение
 * разбор не ломают; в журнал — только вид ошибки, без сессии (в ней номер
 * телефона), имени файла и текста ошибки.
 */

const PROFILE = { name: 'Анна', family_name: 'Петрова', profile: ['юрист'] };
const PDF_BYTES = Buffer.from('%PDF-1.4 test');
const PDF_FILE = { originalname: 'resume.pdf', buffer: PDF_BYTES, mimetype: 'application/pdf', size: PDF_BYTES.length };

function scanReplies(text = JSON.stringify(PROFILE)) {
  (query as unknown as jest.Mock).mockImplementation(() => (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  })());
}

function makeController(uploads?: { saveOriginals: jest.Mock }) {
  const ctrl = new ChatController({} as any, {} as any, undefined as any, undefined, undefined, uploads as any);
  const logger = { warn: jest.fn(), log: jest.fn(), error: jest.fn(), debug: jest.fn() };
  (ctrl as any).logger = logger;
  return { ctrl, logger };
}

function makeReq(body: Record<string, unknown> = {}, file: unknown = PDF_FILE) {
  return { file, body, headers: {} } as any;
}

function makeRes() {
  const res: any = { statusCode: 0, payload: undefined };
  res.status = jest.fn((code: number) => { res.statusCode = code; return res; });
  res.json = jest.fn((p: unknown) => { res.payload = p; return res; });
  return res;
}

const okSave = () => ({ saveOriginals: jest.fn(async (_input: any) => ({ saved: [] as unknown[], failed: [] as string[] })) });

/** Весь текст предупреждений журнала одной строкой. */
const warnText = (logger: { warn: jest.Mock }) => logger.warn.mock.calls.map((c) => String(c[0])).join('\n');

const ENV_KEYS = ['CHAT_UPLOADS_ENABLED', 'CHAT_UPLOADS_SAVE_BUDGET_MS'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.CHAT_UPLOADS_ENABLED = 'true';
  delete process.env.CHAT_UPLOADS_SAVE_BUDGET_MS;
  scanReplies();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k] as string;
  }
  jest.restoreAllMocks();
});

describe('scan-document: PDF Маши сохраняется в загрузки', () => {
  it('флаг включён — saveOriginals с сессией Маши и source=scan, имя раскодировано; разбор отвечает как раньше', async () => {
    const uploads = okSave();
    const { ctrl } = makeController(uploads);
    const res = makeRes();
    const mangled = Buffer.from('резюме.pdf', 'utf8').toString('latin1');
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq({}, { ...PDF_FILE, originalname: mangled }), res);
    expect(uploads.saveOriginals).toHaveBeenCalledTimes(1);
    expect(uploads.saveOriginals).toHaveBeenCalledWith({
      userId: 'u-1',
      sessionId: 'u-1_3',
      source: 'scan',
      files: [{ buffer: PDF_BYTES, originalname: 'резюме.pdf', mimetype: 'application/pdf' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ output: PROFILE });
  });

  it('поля fresh/freshTs в multipart игнорируются — PDF в основной сессии Маши', async () => {
    const uploads = okSave();
    const { ctrl } = makeController(uploads);
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq({ fresh: 'true', freshTs: '1731700000000' }), makeRes());
    expect(uploads.saveOriginals).toHaveBeenCalledTimes(1);
    expect(uploads.saveOriginals.mock.calls[0][0].sessionId).toBe('u-1_3');
  });

  it('сбой сохранения не ломает разбор; в журнале только вид ошибки', async () => {
    const uploads = { saveOriginals: jest.fn(async () => { throw new Error('minio down'); }) };
    const { ctrl, logger } = makeController(uploads);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ output: PROFILE });
    expect(warnText(logger)).toMatch(/saveOriginals/);
    expect(warnText(logger)).not.toMatch(/minio down|u-1|resume/);
  });

  it('файл не сохранился (failed) — разбор отвечает, в логе предупреждение без сессии и имени', async () => {
    const uploads = { saveOriginals: jest.fn(async () => ({ saved: [], failed: ['resume.pdf'] })) };
    const { ctrl, logger } = makeController(uploads);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(logger.warn).toHaveBeenCalled();
    expect(warnText(logger)).not.toMatch(/u-1|resume/);
  });

  it('сохранение дольше бюджета — разбор отвечает, обработчик не висит', async () => {
    process.env.CHAT_UPLOADS_SAVE_BUDGET_MS = '30';
    const uploads = { saveOriginals: jest.fn(() => new Promise(() => {})) };
    const { ctrl, logger } = makeController(uploads);
    const res = makeRes();
    const t0 = Date.now();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(res.statusCode).toBe(200);
    expect(warnText(logger)).toMatch(/save budget 30ms exceeded/);
  });

  it('разбор упал — 500, а PDF всё равно сохранён', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    (query as unknown as jest.Mock).mockImplementation(() => { throw new Error('sdk down'); });
    const uploads = okSave();
    const { ctrl } = makeController(uploads);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(res.statusCode).toBe(500);
    expect(uploads.saveOriginals).toHaveBeenCalledTimes(1);
  });

  it('флаг выключен — saveOriginals не зовётся', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    const uploads = okSave();
    const { ctrl } = makeController(uploads);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(uploads.saveOriginals).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });

  it('сервис загрузок не подключён — разбор работает', async () => {
    const { ctrl } = makeController(undefined);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.payload).toEqual({ output: PROFILE });
  });

  it('без файла — 400, сохранения нет', async () => {
    const uploads = okSave();
    const { ctrl } = makeController(uploads);
    const res = makeRes();
    await ctrl.scanDocument({ userId: 'u-1' }, makeReq({}, undefined), res);
    expect(res.statusCode).toBe(400);
    expect(uploads.saveOriginals).not.toHaveBeenCalled();
  });
});
