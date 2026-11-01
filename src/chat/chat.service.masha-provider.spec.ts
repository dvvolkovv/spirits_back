import { ChatService } from './chat.service';

/**
 * Путь Маши (agent.id === 3, локальный CLI, минуя релей) следует выбору
 * модели ответов человека так же, как путь релея (chat.service.llm-provider.spec.ts)
 * и TG-ботов (tg-router.model.spec.ts): kimi/qwen уходят в ClaudeCliService
 * полем provider через cliProviderOption (answer-provider.ts); личный
 * Claude — явно тем же полем (рубильник к нему не применяется), «Как у
 * всех» — без поля (рубильник применит сам ClaudeCliService). Проба
 * мониторинга выбор вообще не читает (resolveAnswerProvider).
 *
 * Харнес — минимальная версия той же сборки, что в chat.service.masha-prompt.spec.ts
 * и chat.service.masha-cost.spec.ts: ChatService собирается позиционно (первые
 * шесть зависимостей), llmProvider — последний @Optional-параметр конструктора,
 * подставляется полем после сборки (как costGrowth в chat.service.masha-cost.spec.ts).
 */

const USER = 'u-1';

function makeService(choice: 'claude' | 'qwen' | 'kimi' = 'claude', routeChoice: 'user' | 'global' = 'user') {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) return { rows: [{ tokens: 100_000 }] };
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'Давай разберём это вместе.', costUsd: 0.01 })),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any, undefined as any, {} as any, claudeCli as any, language as any, balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
  });
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  jest.spyOn(svc as any, 'addTokenTask').mockResolvedValue(undefined);
  const llmProvider = { route: jest.fn(async () => ({ provider: choice, choice: routeChoice })) };
  (svc as any).llmProvider = llmProvider;
  return { svc, claudeCli, llmProvider };
}

function makeRes() {
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    json: jest.fn(),
  };
  return res;
}

/** Прогоняет ход Маши; probe=true — как пинг мониторинга (chat.controller.ts). */
async function runMasha(svc: ChatService, probe = false) {
  await svc.streamChat(
    USER, 'Мне тревожно перед встречей', '3', `${USER}_3`, '', makeRes(),
    undefined, false, undefined, undefined, false, probe,
  );
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

describe('Маша (локальный CLI): выбор модели ответов человека', () => {
  afterEach(() => jest.clearAllMocks());

  it('выбран Kimi — в опциях CLI provider: kimi', async () => {
    const { svc, claudeCli, llmProvider } = makeService('kimi');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('kimi');
    expect(llmProvider.route).toHaveBeenCalledWith(USER);
  });

  it('личный Claude — provider claude явно (рубильник к нему не применяется)', async () => {
    const { svc, claudeCli } = makeService('claude');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBe('claude');
  });

  it('«Как у всех» — provider не задан (рубильник применит ClaudeCliService)', async () => {
    const { svc, claudeCli } = makeService('qwen', 'global');
    await runMasha(svc);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
  });

  it('проба мониторинга — выбор не читается, provider не задан', async () => {
    const { svc, claudeCli, llmProvider } = makeService('kimi');
    await runMasha(svc, true);
    expect(claudeCli.textWithCost.mock.calls[0][1].provider).toBeUndefined();
    expect(llmProvider.route).not.toHaveBeenCalled();
  });
});
