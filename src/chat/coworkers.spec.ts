import { ChatService } from './chat.service';
import { loadCoworkers } from './coworkers';
import { AgentsService } from '../agents/agents.service';

/**
 * Блок «Коллеги-ассистенты» в системном промпте: только те, кого пользователь
 * может выбрать.
 *
 * До правки в SQL блока стояло лишь `a.id != $1 AND a.description IS NOT NULL`,
 * хотя комментарий над ним обещал фильтр по is_active. На проде в промпт
 * каждого ассистента релея попадали выключенные Герман и Юлия и служебная
 * строка голосового цикла «Линкеон» — с припиской «предложи переключиться на
 * него». На экране выбора их нет.
 *
 * Юнит-тест подменяет pg, поэтому SQL здесь не исполняется. Фейк ниже
 * применяет к таблице только те условия, которые реально стоят в запросе:
 * убери фильтр из SQL — и выключенный ассистент «попадёт» в блок, тест
 * покраснеет. Сам SQL против живого Postgres прогоняет
 * coworkers.integration.spec.ts.
 */

interface Row {
  id: number;
  name: string;
  display_name: string;
  description: string | null;
  is_active: boolean;
}

const TABLE: Row[] = [
  { id: 2, name: 'Оля', display_name: 'Оля', description: 'Исследование ценностей', is_active: true },
  { id: 8, name: 'Герман', display_name: 'Герман', description: 'Про осознанность', is_active: false },
  { id: 12, name: 'Роман', display_name: 'Роман', description: 'Бизнес-ассистент', is_active: true },
  { id: 15, name: 'smm_producer', display_name: 'Юлия', description: 'SMM-продюсер', is_active: false },
  { id: 18, name: 'linkeon_voice', display_name: 'Линкеон', description: 'Голосовой ассистент', is_active: true },
  { id: 22, name: 'Кира', display_name: 'Кира', description: 'Дизайнер', is_active: true },
];

/** Фейк pg: на запрос коллег отвечает строками, прошедшими условия ИЗ САМОГО SQL. */
function makePg() {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (!/FROM agents a\s+LEFT JOIN agent_translations/.test(sql)) return { rows: [] };
    const flat = sql.replace(/\s+/g, ' ');
    let rows = TABLE.filter((r) => r.id !== Number(params[0]));
    if (/\ba\.is_active\b/.test(flat)) rows = rows.filter((r) => r.is_active);
    if (/a\.name <> ALL\(\$3::text\[\]\)/.test(flat)) {
      rows = rows.filter((r) => !(params[2] as string[]).includes(r.name));
    }
    if (/a\.description IS NOT NULL/.test(flat)) rows = rows.filter((r) => r.description !== null);
    return { rows: rows.map((r) => ({ display_name: r.display_name, description: r.description })) };
  });
  return { query, calls };
}

function makeService(pg: { query: jest.Mock }) {
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  return new ChatService(
    pg as any, null as any, null as any, null as any, null as any, language as any, undefined as any,
  );
}

/** Стабильная часть промпта релея — то, что уходит в --system-prompt. */
async function stablePrefix(svc: ChatService, agentId: string, agentName = 'Роман'): Promise<string> {
  return (svc as any).buildRelayStablePrefix({
    agentId,
    agentName,
    agentDescription: '',
    agentSystemPrompt: 'Ты ассистент.',
    userId: 'u1',
    userLanguage: 'ru',
  });
}

/** Блок коллег из промпта: строки между заголовком и пустой строкой. */
function coworkerBlock(prefix: string): string {
  const start = prefix.indexOf('--- Коллеги-ассистенты в Linkeon ---');
  expect(start).toBeGreaterThan(-1);
  return prefix.slice(start, prefix.indexOf('\n\n', start));
}

describe('loadCoworkers', () => {
  it('отдаёт в запрос себя, язык и список служебных имён', async () => {
    const pg = makePg();
    await loadCoworkers(pg as any, 12, 'es');

    expect(pg.calls).toHaveLength(1);
    const [selfId, locale, service] = pg.calls[0].params;
    expect(selfId).toBe(12);
    expect(locale).toBe('es');
    expect(service).toEqual(AgentsService.SERVICE_AGENTS);
    expect(service).toContain('linkeon_voice');
  });

  it('фильтр — тот же, что у экрана выбора: активные и не служебные', async () => {
    const pg = makePg();
    await loadCoworkers(pg as any, 12, 'ru');

    const flat = pg.calls[0].sql.replace(/\s+/g, ' ');
    expect(flat).toMatch(/\ba\.is_active\b/);
    expect(flat).toMatch(/a\.name <> ALL\(\$3::text\[\]\)/);
  });
});

describe('блок «Коллеги-ассистенты» в промпте релея', () => {
  it('выключенные ассистенты в блок не попадают', async () => {
    const block = coworkerBlock(await stablePrefix(makeService(makePg()), '12'));

    expect(block).not.toContain('Герман');
    expect(block).not.toContain('Юлия');
  });

  it('служебный «Линкеон» в блок не попадает', async () => {
    const block = coworkerBlock(await stablePrefix(makeService(makePg()), '12'));

    expect(block).not.toContain('Линкеон');
  });

  it('активные коллеги на месте, себя ассистент не видит', async () => {
    const block = coworkerBlock(await stablePrefix(makeService(makePg()), '12'));

    expect(block).toContain('• Оля — Исследование ценностей');
    expect(block).toContain('• Кира — Дизайнер');
    expect(block).not.toContain('Роман');
  });

  it('пользовательскому ассистенту блок не добавляется и запрос не делается', async () => {
    const pg = makePg();
    const prefix = await stablePrefix(makeService(pg), 'custom:6f1c2b9e-0000-4000-8000-000000000000', 'Мой помощник');

    expect(prefix).not.toContain('Коллеги-ассистенты');
    expect(pg.calls.some((c) => /FROM agents a/.test(c.sql))).toBe(false);
  });
});
