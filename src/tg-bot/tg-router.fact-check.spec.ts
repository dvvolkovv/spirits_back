import { TgRouterService } from './tg-router.service';
import { FACT_CHECK_RULE } from '../chat/fact-check-rule';

/**
 * «Проверка фактов» в промпте Telegram-бота — решение владельца 28.10.2026.
 *
 * У бота есть WebSearch и WebFetch, то есть та же почва для находки 88bb12c8
 * («Затыки недели»: проверяя реестр или профиль, ассистент делал неверный
 * вывод и выдавал его за проверенный), что у ассистентов на релее. Правило —
 * всем ботам, и штатным, и с ассистентом пользователя: оно про честность
 * ответа, а не про бренд, поэтому стоит в общем блоке «ВОЗМОЖНОСТИ», рядом
 * со словами про интернет.
 */

function makeRouter() {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ name: 'Роман', systemPrompt: 'Ты Роман.' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'проверь компанию' }]);
  return { svc, claudeCli };
}

const systemFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].system || '');
const preset: any = { id: 1, tg_chat_id: '-100123', owner_user_id: 'u-1', preset_agent_id: '12' };
const custom: any = { id: 2, tg_chat_id: '-100123', owner_user_id: 'u-1', custom_agent_id: 'c-1' };

describe('Telegram: «Проверка фактов» в промпте', () => {
  it.each([['штатный ассистент', preset], ['ассистент пользователя', custom]])('%s получает правило', async (_name, cfg) => {
    const { svc, claudeCli } = makeRouter();
    await svc.generateReply(cfg, 'Дмитрий');
    const system = systemFrom(claudeCli);
    expect(system).toContain(FACT_CHECK_RULE);
    // В Telegram ответ уходит простым текстом: ссылка на источник — полным адресом.
    expect(system).toMatch(/ПРОВЕРКА ФАКТОВ[\s\S]*полным адресом https:\/\/…, без markdown/);
  });
});

describe('FACT_CHECK_RULE', () => {
  const flat = FACT_CHECK_RULE.replace(/\s+/g, ' ');

  it('источник — открытая в этом ходе страница и что на ней видно', () => {
    expect(flat).toMatch(/ссылкой на страницу, которую ты сам открыл в этом ходе/);
    expect(flat).toMatch(/что именно на ней видно/);
  });

  it('неполное совпадение и вывод по косвенным — не проверенный факт', () => {
    expect(flat).toMatch(/совпадение неполное/);
    expect(flat).toMatch(/называй его предположением/);
  });

  it('«не нашёл» не значит «не существует» (концепция §1); не можешь проверить — как проверить самому', () => {
    expect(flat).toMatch(/«Не нашёл» не значит «не существует»/);
    expect(flat).toMatch(/подскажи, как человеку проверить самому/);
  });
});
