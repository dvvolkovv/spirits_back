import { ChatService } from './chat.service';
import { COLLEAGUES_RULE_GENERAL, COLLEAGUES_RULE_NARROW, colleaguesRule } from './colleagues-rule';

/**
 * Блок «Коллеги-ассистенты»: что делать с просьбой из чужой области.
 *
 * Находка «Затыков недели» 19–25.10.2026 (2c97fc26): узкие ассистенты брались
 * за вопросы чужой области вместо переадресации. Решение владельца 27.10.2026:
 * мягкая переадресация для категорий personal и business; Роману (assistant)
 * и своим ассистентам пользователей — как было.
 */
const flat = (s: string) => s.replace(/\s+/g, ' ');

describe('правило о чужой области', () => {
  it.each(['personal', 'business'])('%s — мягкая переадресация', (category) => {
    expect(colleaguesRule(category)).toBe(COLLEAGUES_RULE_NARROW);
  });

  it.each(['assistant', '', 'custom'])('«%s» — прежняя строка', (category) => {
    expect(colleaguesRule(category)).toBe(COLLEAGUES_RULE_GENERAL);
  });

  it('без категории — прежняя строка', () => {
    expect(colleaguesRule(null)).toBe(COLLEAGUES_RULE_GENERAL);
    expect(colleaguesRule(undefined)).toBe(COLLEAGUES_RULE_GENERAL);
  });

  it('прежняя строка — слово в слово та, что была у всех до 27.10', () => {
    expect(COLLEAGUES_RULE_GENERAL).toBe(
      'Если пользователь спрашивает про кого-то из них или просит сделать что-то по их специализации — расскажи про коллегу честно, без выдумок, и предложи переключиться на него.',
    );
  });

  it('узкому: сначала предложить коллегу и переключение; остаётся — помогать самому', () => {
    const t = flat(COLLEAGUES_RULE_NARROW);
    expect(t).toMatch(/Просьба целиком в области коллеги — сначала предложи его/);
    expect(t).toMatch(/Переключиться\?/);
    expect(t).toMatch(/Хочет остаться с тобой — помогай сам/);
  });

  it('узкому: общий вопрос — коротко и назвать, кто разберёт подробнее', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(
      /Общий вопрос, который задевает чужую область, — ответь коротко и назови, кто из коллег разберёт подробнее/,
    );
  });

  it('узкому: о самой платформе — по справке, никого не предлагая', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(/о самой платформе Linkeon — отвечай сам, по справке, никого не предлагая/);
  });

  it('пример — без имени живого коллеги: иначе его предлагали бы всем', () => {
    expect(COLLEAGUES_RULE_NARROW).toContain('<коллеге>');
  });

  // Человеку в кризисе «это скорее к коллеге» звучало бы отказом, а правило о
  // кризисе (crisis-rule.ts) прямо велит не отправлять к другим ассистентам.
  it('узкому: в кризисной ситуации никого не предлагать — последней строкой, отсылкой к правилу о кризисе', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(/В кризисной ситуации никого не предлагай — тогда действует правило о кризисе\.$/);
  });

  // Без предела узкий специалист называл бы коллегу в каждом ответе на тему,
  // которая задевает чужую область.
  it('узкому: назвать коллегу на общий вопрос — не чаще раза за тему', () => {
    expect(flat(COLLEAGUES_RULE_NARROW)).toMatch(/назови, кто из коллег разберёт подробнее, — не чаще раза за тему\./);
  });

  it('универсалу — прежняя строка без новых оговорок', () => {
    expect(COLLEAGUES_RULE_GENERAL).not.toMatch(/кризис|не чаще/);
  });
});

describe('блок «Коллеги» в промпте релея', () => {
  function service() {
    const pg = {
      query: jest.fn(async (sql: string) =>
        /FROM agents a\s+LEFT JOIN agent_translations/.test(sql)
          ? { rows: [{ display_name: 'Оля', description: 'Исследование ценностей' }] }
          : { rows: [] },
      ),
    };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    return new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  }
  const prefix = (agentId: string, agentCategory: string | null): Promise<string> =>
    (service() as any).buildRelayStablePrefix({
      agentId,
      agentName: 'Дмитрий',
      agentDescription: '',
      agentSystemPrompt: 'Ты ассистент.',
      agentCategory,
      userId: 'u1',
      userLanguage: 'ru',
    });

  it('бизнес-специалисту (Дмитрий, id 19) — мягкая переадресация', async () => {
    const p = await prefix('19', 'business');
    expect(p).toContain(COLLEAGUES_RULE_NARROW);
    expect(p).not.toContain(COLLEAGUES_RULE_GENERAL);
  });

  it('личному (personal) — тоже', async () => {
    expect(await prefix('2', 'personal')).toContain(COLLEAGUES_RULE_NARROW);
  });

  it('Роману (assistant, id 12) — прежняя строка', async () => {
    const p = await prefix('12', 'assistant');
    expect(p).toContain(COLLEAGUES_RULE_GENERAL);
    expect(p).not.toContain(COLLEAGUES_RULE_NARROW);
  });

  it('правило — в блоке коллег, сразу после списка', async () => {
    const p = await prefix('19', 'business');
    const head = p.indexOf('--- Коллеги-ассистенты в Linkeon ---');
    const line = p.indexOf('• Оля — Исследование ценностей', head);
    expect(head).toBeGreaterThan(-1);
    expect(line).toBeGreaterThan(head);
    expect(p.indexOf(COLLEAGUES_RULE_NARROW, head)).toBeGreaterThan(line);
  });

  it('своему ассистенту — ни блока, ни правила', async () => {
    const p = await prefix('custom:6f1c2b9e-0000-4000-8000-000000000000', null);
    expect(p).not.toContain('Коллеги-ассистенты');
    expect(p).not.toContain(COLLEAGUES_RULE_NARROW);
    expect(p).not.toContain(COLLEAGUES_RULE_GENERAL);
  });
});
