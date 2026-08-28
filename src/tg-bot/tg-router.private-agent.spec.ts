import { TgRouterService } from './tg-router.service';

/**
 * Пиннингует то, ради чего вся задача: в личном чате отвечает ассистент из
 * preferred_agent (его пишут веб и мини-апп), а НЕ preset_agent_id строки
 * конфига. До этой правки мини-апп переключал одно поле, бот читал другое, и
 * переключение не действовало ни на что.
 */
describe('resolveSystemPrompt для личного чата', () => {
  const pg = { query: jest.fn() };
  const agents = { getAgentById: jest.fn(), getAgentByName: jest.fn() };

  const router = new TgRouterService(
    pg as any,
    {} as any, // grammy
    {} as any, // configs
    agents as any,
    {} as any, // claudeCli
  );
  const resolve = (cfg: any) => (router as any).resolveSystemPrompt(cfg);

  beforeEach(() => jest.resetAllMocks());

  it('берёт preferred_agent владельца, а не preset_agent_id из строки', async () => {
    // В строке конфига лежит Роман (id 12) — так его завели при создании.
    // Владелец переключился на Олю в мини-аппе. Отвечать обязана Оля.
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Оля' }] });
    agents.getAgentByName.mockResolvedValue({ name: 'Оля', system_prompt: 'промпт Оли' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: '12', owner_user_id: 'u-1' });

    expect(r).toEqual({ name: 'Оля', systemPrompt: 'промпт Оли' });
    expect(agents.getAgentById).not.toHaveBeenCalled();
  });

  it('групповой конфиг по-прежнему читает preset_agent_id', async () => {
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '-5218835753', preset_agent_id: '12', owner_user_id: 'u-1' });

    expect(r).toEqual({ name: 'Роман', systemPrompt: 'промпт Романа' });
    expect(agents.getAgentByName).not.toHaveBeenCalled();
  });

  it('preferred_agent пуст — дефолтный ассистент', async () => {
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: null }] });
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: null, owner_user_id: 'u-1' });

    expect(r.name).toBe('Роман');
    expect(agents.getAgentById).toHaveBeenCalledWith('12');
  });

  it('ассистента переименовали — дефолтный, а не падение', async () => {
    pg.query.mockResolvedValue({ rows: [{ preferred_agent: 'Ассистент-которого-нет' }] });
    agents.getAgentByName.mockResolvedValue(null);
    agents.getAgentById.mockResolvedValue({ name: 'Роман', system_prompt: 'промпт Романа' });

    const r = await resolve({ tg_chat_id: '777', preset_agent_id: null, owner_user_id: 'u-1' });

    expect(r.name).toBe('Роман');
  });
});
