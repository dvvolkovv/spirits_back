import { ChatService } from './chat.service';
import { NOTE_FILE_CLI_PROMPT, NOTE_FILE_CLI_TOOL_NAME } from '../products/products-cli-tool';
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
