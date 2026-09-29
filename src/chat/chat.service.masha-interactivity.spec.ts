import { ChatService } from './chat.service';
import { ASK_RULE } from './ask-rule';
import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';

/**
 * Маша (agent 3) идёт локальным CLI, мимо релея. Шаг у неё один возможный —
 * инструмент продуктов, о вызове сообщает onProgress. Правило карточек — в
 * system вызова CLI, до хвоста языка.
 */

const USER = '79030169187';

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
    textWithCost: jest.fn(async (_prompt: string, opts: any) => {
      opts.onProgress?.({ kind: 'tool_use', name: 'mcp__products__manage_product' });
      return { text: 'Поправила заголовок сайта.', costUsd: 0.01 };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any, undefined as any, undefined as any, {} as any,
    claudeCli as any, language as any, balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
  });
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'addTokenTask').mockResolvedValue(undefined);
  return { svc, claudeCli };
}

async function runMasha(ui?: { activity: boolean; ask: boolean }, resOverrides?: Record<string, unknown>) {
  const { svc, claudeCli } = makeService();
  const writes: any[] = [];
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { writes.push(JSON.parse(s)); return true; }),
    end: jest.fn(),
    json: jest.fn(),
    ...resOverrides,
  };
  await svc.streamChat(USER, 'поправь заголовок', '3', `${USER}_3`, '', res,
    undefined, false, undefined, undefined, false, false, ui);
  await new Promise((r) => setImmediate(r));
  return { opts: claudeCli.textWithCost.mock.calls[0][1], writes };
}

describe('Маша: шаги работы и карточки', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => {
    process.env.JWT_SECRET = 'test-secret-masha-interactivity';
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });

  it('вызов инструмента продуктов — шаг для клиента, который умеет', async () => {
    const { writes } = await runMasha({ activity: true, ask: false });
    expect(writes.filter((w) => w.type === 'activity')).toEqual([{ type: 'activity', kind: 'product' }]);
  });

  it('без ui шагов нет', async () => {
    const { writes } = await runMasha(undefined);
    expect(writes.some((w) => w.type === 'activity')).toBe(false);
  });

  it('правило карточек в system при ui.ask; язык остаётся последней строкой', async () => {
    const { opts } = await runMasha({ activity: false, ask: true });
    const system = String(opts.system);
    expect(system).toContain(ASK_RULE);
    expect(system.trimEnd().endsWith(LANGUAGE_REPLY_LINE.ru)).toBe(true);
  });

  it('без ui.ask правила нет', async () => {
    const { opts } = await runMasha(undefined);
    expect(String(opts.system)).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
  });

  it('res уже закрыт (таймаут CLI убил процесс, но onProgress ещё зовётся) — шаг не пишем', async () => {
    const { writes } = await runMasha({ activity: true, ask: false }, { writableEnded: true });
    expect(writes.some((w) => w.type === 'activity')).toBe(false);
  });
});
