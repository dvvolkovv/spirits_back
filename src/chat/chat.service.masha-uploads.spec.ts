import { ChatService } from './chat.service';
import { ChatUploadsService, ChatUploadRecord } from './chat-uploads/chat-uploads.service';
import { FIND_FILES_CLI_PROMPT, NOTE_FILE_CLI_PROMPT, NOTE_FILE_CLI_TOOL_NAME } from '../products/products-cli-tool';
import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';

/**
 * Маша (agent.id === 3) идёт локальным claude CLI мимо релея, поэтому всё,
 * что веб-ассистенты получают через релей, ей отдаётся отдельно: инструмент
 * note_file и блок загрузок сессии. Обе вещи — только при
 * CHAT_UPLOADS_ENABLED=true. Обвязка — как в chat.service.masha-products.spec.ts.
 */

const USER = 'u-masha-uploads';

function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: 100000 }] };
      if (sql.includes('FROM agents a')) {
        return { rows: [{ name: 'Маша', display_name: 'Маша', description: 'психолог', system_prompt: '' }] };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'Посмотрела файл.', costUsd: 0.01 })),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any,
    undefined as any, // neo4j
    {} as any, // tools
    claudeCli as any,
    language as any,
    balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
  });
  // Запись истории и списание — после ответа, в setImmediate; здесь не проверяются.
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'addTokenTask').mockResolvedValue(undefined);
  return { svc, claudeCli };
}

function makeRes() {
  const writes: string[] = [];
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { writes.push(s); return true; }),
    end: jest.fn(),
    json: jest.fn(),
  };
  return { res, writes };
}

/** Ход Маши; setup — подмена полей сервиса до хода (например, реестра загрузок). */
async function runMasha(o: {
  setup?: (svc: ChatService) => void;
  sessionId?: string;
  fresh?: boolean;
  probe?: boolean;
} = {}) {
  const { svc, claudeCli } = makeService();
  o.setup?.(svc);
  const { res, writes } = makeRes();
  await svc.streamChat(
    USER, 'что в файле?', '3', o.sessionId ?? `${USER}_3`, 'Имя: Тест', res,
    undefined, !!o.fresh, undefined, undefined, false, !!o.probe,
  );
  // Хвост хода (история, списание) уходит в setImmediate — дать ему отработать.
  await new Promise((r) => setImmediate(r));
  expect(claudeCli.textWithCost).toHaveBeenCalledTimes(1);
  const [prompt, opts] = claudeCli.textWithCost.mock.calls[0];
  return { svc, claudeCli, opts, prompt: String(prompt), writes };
}

const ENV_KEYS = ['JWT_SECRET', 'BACKEND_URL', 'CHAT_UPLOADS_ENABLED', 'PORT'] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  envSnapshot = {};
  for (const key of ENV_KEYS) envSnapshot[key] = process.env[key];
  process.env.JWT_SECRET = 'masha-uploads-spec';
  process.env.BACKEND_URL = 'https://backend.test';
  delete process.env.PORT;
});

afterEach(() => {
  jest.restoreAllMocks();
  for (const key of ENV_KEYS) {
    const saved = envSnapshot[key];
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
});

describe('Маша: note_file', () => {
  it('флаг включён: note_file автоодобрен после find_files, блок про комментарии — в системном промпте, язык — последней строкой', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { opts } = await runMasha();
    expect(opts.allowedTools).toBe(
      'mcp__products__manage_product,mcp__products__find_files,mcp__products__note_file,mcp__products__report_problem,mcp__products__linkeon_help',
    );
    const system = String(opts.system);
    expect(system).toContain(NOTE_FILE_CLI_PROMPT);
    expect(system.trim().split('\n').pop()).toBe(LANGUAGE_REPLY_LINE.ru.trim());
  });

  // Блок про комментарии — в стабильной части, сразу за поиском файлов, и до
  // волатильной (профиль, задачи, баланс): иначе он ломал бы кэш префикса и
  // отрывался бы от блока, на чьё поле id ссылается.
  it('флаг включён: блок про комментарии — после поиска файлов и до волатильной части', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { opts } = await runMasha({
      // Автопрофилирование разрешено (profile_data без ключей — значения по
      // умолчанию), и волатильная часть начинается с профиля пользователя.
      setup: (svc) => {
        const query = (svc as any).pg.query as jest.Mock;
        const base = query.getMockImplementation()!;
        query.mockImplementation(async (sql: string, params?: unknown[]) =>
          sql.includes('SELECT profile_data FROM ai_profiles_consolidated')
            ? { rows: [{ profile_data: {} }] }
            : base(sql, params));
      },
    });
    const system = String(opts.system);
    const find = system.indexOf(FIND_FILES_CLI_PROMPT);
    const note = system.indexOf(NOTE_FILE_CLI_PROMPT);
    const volatile = system.indexOf('--- Профиль пользователя ---');
    expect(find).toBeGreaterThanOrEqual(0);
    expect(volatile).toBeGreaterThan(0);
    expect(find).toBeLessThan(note);
    expect(note).toBeLessThan(volatile);
  });

  it('флаг выключен: набор инструментов прежний, про note_file ни слова', async () => {
    delete process.env.CHAT_UPLOADS_ENABLED;
    const { opts } = await runMasha();
    expect(opts.allowedTools).toBe(
      'mcp__products__manage_product,mcp__products__find_files,mcp__products__report_problem,mcp__products__linkeon_help',
    );
    expect(String(opts.system)).not.toContain('mcp__products__note_file');
  });

  // «Записала к фото: карточка…» — /карт/i в ответе. Ход, где звали
  // инструмент точки продуктов, метафорическую карту не получает.
  it('ход с note_file не получает метафорическую карту', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { svc, claudeCli } = makeService();
    claudeCli.textWithCost.mockImplementation(async (_p: string, o: any) => {
      o.onProgress?.({ kind: 'tool_use', name: 'mcp__products__note_file' });
      return { text: 'Записала к фото: карточка с планом гостиной.', costUsd: 0.01 };
    });
    const cardSpy = jest.spyOn(svc as any, 'getRandomMetaphorCard')
      .mockResolvedValue('https://images.linkeon.io/cards/card-7.jpg');
    const { res, writes } = makeRes();
    await svc.streamChat(USER, 'запомни, что на фото', '3', `${USER}_3`, 'Имя: Тест', res);
    await new Promise((r) => setImmediate(r));
    expect(cardSpy).not.toHaveBeenCalled();
    const item = writes.map((w) => JSON.parse(w)).find((e) => e.type === 'item');
    expect(item.content).not.toContain('Метафорическая карта');
    // Имя в обработчике — ровно константа CLI, а не строка из теста.
    expect(NOTE_FILE_CLI_TOOL_NAME).toBe('mcp__products__note_file');
  });
});

describe('Маша: блок загрузок сессии', () => {
  const RECORD: ChatUploadRecord = {
    id: '99999999-9999-4999-8999-999999999999',
    userId: USER,
    sessionId: `${USER}_3`,
    originalName: 'план.pdf',
    mime: 'application/pdf',
    sizeBytes: 1,
    sha256: 'a'.repeat(64),
    storageKey: 'synthetic/plan.pdf',
    createdAt: '2026-11-15T07:05:00.000Z',
    source: 'scan',
    thumbKey: null,
    note: 'План квартиры: две комнаты; договорились начать с гостиной.',
    noteUpdatedAt: '2026-11-15T07:10:00.000Z',
    noteAssistantId: '3',
  };
  // Подпись проверяется в chat-uploads.assistant-block.spec.ts; здесь — место
  // блока в промпте Маши, поэтому ссылка подменена постоянной строкой.
  const LINK = `https://backend.test/webhook/chat-uploads/${RECORD.id}?exp=1&sig=spec`;
  // Отсутствие блока — по его заголовку с двоеточием: имя блока без двоеточия
  // («Earlier user uploads») есть и в NOTE_FILE_CLI_PROMPT, который при
  // включённом флаге в промпте Маши стоит всегда — и в пинге, и при сбое реестра.
  const HEADER_LINE = 'Earlier user uploads:';
  const BLOCK = [
    HEADER_LINE,
    'Signed links expire after ~1 hour. If this block appears more than once in the conversation, use ONLY the LATEST copy — links from earlier copies are stale and return 404.',
    'These links are for your internal use only; NEVER show or paste them to the user — to give the user a file, find it via find_files and share only its "url" field.',
    `- id=${RECORD.id} | план.pdf | document | 2026-11-15 | комментарий: План квартиры: две комнаты; договорились начать с гостиной.`,
    `  ${LINK}`,
  ].join('\n');

  /** Настоящий ChatUploadsService (assistantBlock — боевой), выборка и подпись — подменены. */
  function uploadsWith(records: ChatUploadRecord[] = [RECORD]) {
    const uploads = new ChatUploadsService({ query: jest.fn(async () => ({ rows: [] })) } as any, {} as any);
    const recentSpy = jest.spyOn(uploads, 'recentForSession').mockResolvedValue(records);
    jest.spyOn(uploads, 'assistantUrl').mockReturnValue(LINK);
    return { uploads, recentSpy };
  }
  // Позиционная сборка ChatService до chatUploads не доходит — подставляем полем
  // (тот же приём, что в chat-uploads.prompt.spec.ts).
  const withUploads = (uploads: ChatUploadsService) => (svc: ChatService) => {
    (svc as any).chatUploads = uploads;
  };
  // Автопрофилирование разрешено (profile_data без ключей — значения по
  // умолчанию): волатильная часть начинается с профиля пользователя — тот же
  // приём, что в тесте порядка блока note_file выше.
  const withProfile = (svc: ChatService) => {
    const query = (svc as any).pg.query as jest.Mock;
    const base = query.getMockImplementation()!;
    query.mockImplementation(async (sql: string, params?: unknown[]) =>
      sql.includes('SELECT profile_data FROM ai_profiles_consolidated')
        ? { rows: [{ profile_data: {} }] }
        : base(sql, params));
  };

  it('флаг включён: блок — после блока note_file и волатильной части, перед строкой языка; реестр — по ключу `<userId>_3`', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { uploads, recentSpy } = uploadsWith();
    const { opts, prompt } = await runMasha({
      setup: (svc) => {
        withUploads(uploads)(svc);
        withProfile(svc);
      },
    });
    const system = String(opts.system);
    expect(system).toContain(`\n\n${BLOCK}\n`);
    expect(system.indexOf(BLOCK)).toBeGreaterThan(system.indexOf(NOTE_FILE_CLI_PROMPT));
    // Подписи чеканятся каждый ход — блок стоит за волатильной частью, а не в
    // стабильной.
    const volatile = system.indexOf('--- Профиль пользователя ---');
    expect(volatile).toBeGreaterThan(0);
    expect(system.indexOf(BLOCK)).toBeGreaterThan(volatile);
    expect(system.trim().split('\n').pop()).toBe(LANGUAGE_REPLY_LINE.ru.trim());
    expect(recentSpy).toHaveBeenCalledWith(USER, `${USER}_3`, []);
    // В реплику (история + USER) подписанная ссылка не попадает.
    expect(prompt).not.toContain(LINK);
  });

  it('чистый лист: реестр опрошен по fresh-сессии', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { uploads, recentSpy } = uploadsWith();
    const { opts } = await runMasha({ setup: withUploads(uploads), sessionId: `${USER}_3_fresh_1`, fresh: true });
    expect(recentSpy).toHaveBeenCalledWith(USER, `${USER}_3_fresh_1`, []);
    expect(String(opts.system)).toContain(BLOCK);
  });

  it('флаг выключен: блока нет, реестр не опрашивается', async () => {
    delete process.env.CHAT_UPLOADS_ENABLED;
    const { uploads, recentSpy } = uploadsWith();
    const { opts } = await runMasha({ setup: withUploads(uploads) });
    expect(recentSpy).not.toHaveBeenCalled();
    expect(String(opts.system)).not.toContain(HEADER_LINE);
  });

  it('пинг мониторинга (probe): блока нет, реестр не опрашивается', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { uploads, recentSpy } = uploadsWith();
    const { opts } = await runMasha({ setup: withUploads(uploads), probe: true });
    expect(recentSpy).not.toHaveBeenCalled();
    expect(String(opts.system)).not.toContain(HEADER_LINE);
  });

  it('сбой реестра — ход идёт без блока', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { uploads, recentSpy } = uploadsWith();
    recentSpy.mockRejectedValue(new Error('db down'));
    const { opts, writes } = await runMasha({ setup: withUploads(uploads) });
    expect(String(opts.system)).not.toContain(HEADER_LINE);
    expect(writes.map((w) => JSON.parse(w)).some((e) => e.type === 'item')).toBe(true);
  });

  // Текст ошибки pg может повторять данные запроса и имена — в журнал идут
  // только ключ сессии в кавычках и вид ошибки (err-kind.ts); userId уже
  // внутри ключа и отдельно не пишется.
  it('сбой реестра — в журнале ключ сессии и вид ошибки, без текста ошибки', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const { uploads, recentSpy } = uploadsWith();
    recentSpy.mockRejectedValue(Object.assign(new Error('db down: план.pdf'), { code: 'ECONNREFUSED' }));
    let warn: jest.SpyInstance | undefined;
    await runMasha({
      setup: (svc) => {
        withUploads(uploads)(svc);
        warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);
      },
    });
    const lines = warn!.mock.calls.map((call) => String(call[0]));
    expect(lines).toContain(`upload context failed (session "${USER}_3"): Error code=ECONNREFUSED`);
    expect(lines.join('\n')).not.toContain('план.pdf');
    expect(lines.join('\n')).not.toContain('db down');
  });
});
