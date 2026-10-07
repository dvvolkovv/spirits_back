import { ChatService } from './chat.service';
import { TgRouterService } from '../tg-bot/tg-router.service';
import { CRISIS_RULE, withCrisisRule } from './crisis-rule';

/**
 * Кризисное правило у пользовательских ассистентов.
 *
 * Штатные ассистенты несут правило в конце своего промпта в таблице agents.
 * У пользовательских (custom_agents) промпт пишет сам пользователь, и правила
 * там нет — его дописывает код. Ровно один раз и только им: второй экземпляр
 * у штатного означал бы, что правило дублируется в каждом ходе.
 */

const flat = (s: string) => s.replace(/\s+/g, ' ');
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe('текст правила', () => {
  it('номера помощи на месте', () => {
    expect(CRISIS_RULE).toContain('112');
    expect(CRISIS_RULE).toContain('+7 (495) 989-50-50');
    expect(CRISIS_RULE).toContain('8-800-2000-122');
    expect(flat(CRISIS_RULE)).toMatch(/Если человек не в России — местная экстренная служба/);
  });

  it('главенство и запреты, ради которых правило написано', () => {
    const f = flat(CRISIS_RULE);
    expect(f).toMatch(/^КРИЗИСНАЯ СИТУАЦИЯ — ЭТО ПРАВИЛО ВАЖНЕЕ ВСЕХ ОСТАЛЬНЫХ/);
    expect(f).toMatch(/Запрет давать советы здесь не действует/);
    expect(f).toMatch(/прямо спроси, думает ли он о самоубийстве/);
    expect(f).toMatch(/Не отправляй к другим ассистентам платформы/);
    expect(f).toMatch(/Не давай сведений о способах навредить/);
  });

  it('withCrisisRule дописывает правило в конец и не теряет его на пустом промпте', () => {
    expect(withCrisisRule('Ты помощник по продажам.')).toBe(`Ты помощник по продажам.\n\n${CRISIS_RULE}`);
    expect(withCrisisRule('')).toBe(CRISIS_RULE);
    expect(withCrisisRule(null)).toBe(CRISIS_RULE);
  });
});

describe('веб: системный промпт релея', () => {
  function makeService() {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    return new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any, undefined as any,
    );
  }
  const prefix = (agentId: string, agentSystemPrompt: string): Promise<string> =>
    (makeService() as any).buildRelayStablePrefix({
      agentId, agentName: 'Помощник', agentDescription: '', agentSystemPrompt,
      userId: 'u1', userLanguage: 'ru',
    });

  const CUSTOM = 'custom:6f1c2b9e-0000-4000-8000-000000000000';

  it('пользовательский ассистент получает правило ровно один раз, после своей персоны', async () => {
    const p = await prefix(CUSTOM, 'Ты помощник по продажам. Отвечай только про продажи.');

    expect(count(p, CRISIS_RULE)).toBe(1);
    expect(p.indexOf(CRISIS_RULE)).toBeGreaterThan(p.indexOf('Отвечай только про продажи.'));
  });

  it('и с пустым промптом тоже', async () => {
    expect(count(await prefix(CUSTOM, ''), CRISIS_RULE)).toBe(1);
  });

  it('штатному ассистенту код правило не добавляет: оно у него в промпте из БД', async () => {
    const p = await prefix('12', 'Ты Роман.');

    expect(p).not.toContain('КРИЗИСНАЯ СИТУАЦИЯ');
  });
});

describe('Telegram: промпт ассистента бота', () => {
  const pg = { query: jest.fn() };
  const agents = { getAgentById: jest.fn(), getAgentByName: jest.fn() };
  const router = new TgRouterService(pg as any, {} as any, {} as any, agents as any, {} as any);
  const resolve = (cfg: any) => (router as any).resolveSystemPrompt(cfg);

  beforeEach(() => jest.resetAllMocks());

  it('пользовательский ассистент: свой промпт, затем правило', async () => {
    pg.query.mockResolvedValue({ rows: [{ name: 'Продажник', system_prompt: 'Ты помощник по продажам.' }] });

    const r = await resolve({ custom_agent_id: 'c-1', tg_chat_id: '-100', owner_user_id: 'u-1' });

    expect(r.name).toBe('Продажник');
    expect(r.systemPrompt).toBe(`Ты помощник по продажам.\n\n${CRISIS_RULE}`);
  });

  it('штатный ассистент — промпт из БД как есть', async () => {
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '-5218835753', preset_agent_id: '12', owner_user_id: 'u-1' });

    expect(r).toEqual({ name: 'Роман', systemPrompt: 'промпт Романа' });
  });
});
