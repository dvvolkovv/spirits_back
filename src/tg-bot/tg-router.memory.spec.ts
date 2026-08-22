import { TgRouterService } from './tg-router.service';

/**
 * Память бота.
 *
 * Бот читал из профиля ровно одно поле — имя, а историю брал только из
 * tg_bot_messages. Всё, что владелец рассказывал ассистентам в вебке, лежит в
 * графе Neo4j и боту было не видно; обратно тоже ничего не писалось, поэтому он
 * не мог научиться и переспрашивал про семью.
 *
 * Полноту решает состав чата, а не его тип: боевые «группы» на 22.08.2026 — это
 * личные рабочие чаты с одним участником. Появился второй — приватные разделы
 * графа из промпта уходят, чтобы личное не прозвучало при посторонних.
 */

function makeRouter(distinctWriters: number) {
  const pg = { query: jest.fn(async () => ({ rows: [{ n: distinctWriters }] })) };
  const neo4j = {
    getProfileDescription: jest.fn(async () => 'Profile: name: Дмитрий\nInterests: авиация(confidence:8)'),
    consolidateFromChat: jest.fn(async () => {}),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, claudeCli as any, neo4j as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'роль' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'привет' }]);
  return { svc, neo4j, claudeCli };
}

const cfg: any = { id: 'cfg-1', tg_chat_id: -5231294306, owner_user_id: '79030169187', preset_agent_id: '12' };

describe('TgRouterService: профиль владельца в промпте', () => {
  it('чат с одним участником — полный профиль, включая приватные разделы', async () => {
    const { svc, neo4j } = makeRouter(1);

    await svc.generateReply(cfg, 'Дмитрий');

    expect(neo4j.getProfileDescription).toHaveBeenCalledWith('79030169187', { includePrivate: true });
  });

  it('появился второй собеседник — приватные разделы отключаются', async () => {
    const { svc, neo4j } = makeRouter(2);

    await svc.generateReply(cfg, 'Дмитрий');

    expect(neo4j.getProfileDescription).toHaveBeenCalledWith('79030169187', { includePrivate: false });
  });

  it('профиль реально попадает в system-промпт, а не просто загружается', async () => {
    const { svc, claudeCli } = makeRouter(1);

    await svc.generateReply(cfg, 'Дмитрий');

    expect(String(claudeCli.textWithCost.mock.calls[0][1].system)).toContain('авиация');
  });

  it('без Neo4j работает как раньше и не падает', async () => {
    const claudeCli = {
      textWithCost: jest.fn(async (_p: string, _o: any) => ({ text: 'ответ', costUsd: 0 })),
    };
    const svc = new TgRouterService({} as any, null as any, null as any, null as any, claudeCli as any);
    jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'роль' });
    jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([]);

    await expect(svc.generateReply(cfg, 'Дмитрий')).resolves.toMatchObject({ text: 'ответ' });
  });
});

describe('TgRouterService.consolidateAfterReply', () => {
  it('в сольном чате записывает разговор в граф', async () => {
    const { svc, neo4j } = makeRouter(1);

    await svc.consolidateAfterReply(cfg, 'у меня дочь учится в Китае', 'понял, запомнил');

    expect(neo4j.consolidateFromChat).toHaveBeenCalledWith(
      '79030169187', '12', 'у меня дочь учится в Китае', 'понял, запомнил',
    );
  });

  it('в общем чате не пишет: чужие слова не должны оседать в профиле владельца', async () => {
    const { svc, neo4j } = makeRouter(3);

    await svc.consolidateAfterReply(cfg, 'реплика постороннего', 'ответ');

    expect(neo4j.consolidateFromChat).not.toHaveBeenCalled();
  });

  it('падение графа не роняет ответ пользователю', async () => {
    const { svc, neo4j } = makeRouter(1);
    neo4j.consolidateFromChat.mockRejectedValueOnce(new Error('neo4j down') as never);

    await expect(svc.consolidateAfterReply(cfg, 'вопрос', 'ответ')).resolves.toBeUndefined();
  });
});
