import axios from 'axios';
import { Neo4jService } from './neo4j.service';

/**
 * K1 — консолидация профиля не воскрешает граф удалённого аккаунта.
 *
 * Удаление переводит user_id в state='deleted', стирает граф (DETACH DELETE)
 * и обнуляет profile_data до '{}'. automaticProfilingAllowed на пустом
 * профиле по умолчанию отвечает true, поэтому ход чата или звонок, который
 * шёл в момент удаления, без отдельного гейта по состоянию заново создавал
 * Profile и его сущности. Гейт — SELECT state='active' непосредственно перед
 * каждой записью в Neo4j; privacy-проверка при этом не меняется.
 *
 * profile-privacy здесь НЕ мокается: профиль после удаления — '{}', и
 * настоящий automaticProfilingAllowed пропускает его — ровно как на проде.
 */

const STATE_GATE_RE = /FROM user_id\b[\s\S]*internal_id\s*=\s*\$1[\s\S]*state\s*=\s*'active'/;
const WRITE_RE = /\b(MERGE|SET|CREATE)\b/;

function makeService(opts: { cliAnswer?: string; states: string[] }) {
  // states — что вернёт user_id.state на очередной проверке; последний
  // элемент повторяется. Так моделируется удаление посреди консолидации.
  const states = [...opts.states];
  const events: string[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []): Promise<any> => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/FROM ai_profiles_consolidated/.test(s)) {
        // Оболочка профиля после core.immediate: profile_data = '{}'.
        return { rows: [{ profile_data: {} }], rowCount: 1 };
      }
      if (/FROM custom_chat_history/.test(s)) {
        return { rows: [{ content: 'PREV' }], rowCount: 1 };
      }
      if (/FROM user_id/.test(s)) {
        const state = states.length > 1 ? states.shift()! : states[0];
        events.push(`state:${state}`);
        // Семантика прод-SQL: строка возвращается, только если запрос
        // фильтрует по internal_id = $1 и state = 'active'.
        const active = STATE_GATE_RE.test(s) && params[0] === 'u-k1' && state === 'active';
        return { rows: active ? [{ '?column?': 1 }] : [], rowCount: active ? 1 : 0 };
      }
      throw new Error(`Unexpected SQL: ${s}`);
    }),
  };
  const cli = { text: jest.fn(async () => opts.cliAnswer ?? '{"interests":["chess"],"values":["honesty"]}') };
  const run = jest.fn(async (cypher: string, _params?: any): Promise<any> => {
    events.push(`neo:${cypher.replace(/\s+/g, ' ').trim()}`);
    return { records: [] };
  });
  const session = { run, close: jest.fn(async () => undefined) };
  const svc = new Neo4jService(pg as any, cli as any);
  (svc as any).driver = {};
  (svc as any).getSession = jest.fn(() => session);
  return { svc, pg, cli, run, events };
}

const writesOf = (run: jest.Mock) => run.mock.calls.map((c) => String(c[0])).filter((c) => WRITE_RE.test(c));

/** Каждой записи в граф непосредственно предшествует проверка, давшая active. */
function expectGateBeforeEveryWrite(events: string[]): void {
  let gate: string | null = null;
  for (const e of events) {
    if (e.startsWith('state:')) { gate = e; continue; }
    if (e.startsWith('neo:') && WRITE_RE.test(e)) {
      expect(gate).toBe('state:active');
      gate = null;
    }
  }
}

describe('Neo4jService — гейт на активный аккаунт перед записью в граф', () => {
  const savedOpenAIKey = process.env.OPENAI_API_KEY;
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    jest.restoreAllMocks();
  });

  it('удалённый аккаунт с пустым профилем: consolidateFromChat ничего не пишет в граф', async () => {
    const { svc, run } = makeService({ states: ['deleted'] });
    const embedding = jest.spyOn(svc, 'updateProfileEmbedding');

    await svc.consolidateFromChat('u-k1', '12', 'я люблю шахматы', 'отлично', '');

    expect(writesOf(run)).toEqual([]);
    expect(embedding).not.toHaveBeenCalled();
  });

  it('аккаунт удалили посреди записи: следующая группа записей не выполняется', async () => {
    // Первая проверка — active (interests пишутся), дальше — deleted.
    const { svc, run, events } = makeService({ states: ['active', 'deleted'] });

    await svc.consolidateFromChat('u-k1', '12', 'я люблю шахматы', 'отлично', '');

    const writes = writesOf(run);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('Interest');
    expect(writes.join('\n')).not.toContain('Value');
    expect(writes.join('\n')).not.toContain('consolidation_count');
    expectGateBeforeEveryWrite(events);
  });

  it('эмбеддинг удалённого аккаунта не сохраняется, даже если OpenAI уже ответил', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    const { svc, run } = makeService({ states: ['deleted'] });
    jest.spyOn(svc, 'getProfileDescription').mockResolvedValue('A sufficiently long profile description');

    await svc.updateProfileEmbedding('u-k1');

    expect(writesOf(run)).toEqual([]);
  });

  it('активный аккаунт: сущности, счётчик и эмбеддинг пишутся как раньше, каждой записи предшествует гейт', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    const { svc, run, events } = makeService({ states: ['active'] });
    jest.spyOn(svc, 'getProfileDescription').mockResolvedValue('A sufficiently long profile description');

    await svc.consolidateFromChat('u-k1', '12', 'я люблю шахматы', 'отлично', '');

    const writes = writesOf(run);
    expect(writes.some((w) => w.includes('Interest'))).toBe(true);
    expect(writes.some((w) => w.includes('Value'))).toBe(true);
    expect(writes.some((w) => w.includes('consolidation_count'))).toBe(true);
    expect(writes.some((w) => w.includes('p.embedding'))).toBe(true);
    expectGateBeforeEveryWrite(events);
  });
  // K1b: ночная компакция (profile-compaction.service) могла идти в момент
  // удаления — после LLM-группировки mergeEntitiesInProfile делал
  // MERGE (p:Profile {phone}) и воскрешал узел удалённого аккаунта.
  it('компакция: mergeEntitiesInProfile не воскрешает Profile удалённого аккаунта', async () => {
    const { svc, run } = makeService({ states: ['deleted'] });

    await svc.mergeEntitiesInProfile('u-k1', 'interest', ['шахматы', 'chess'], 'шахматы');

    expect(writesOf(run)).toEqual([]);
  });

  it('компакция: у активного аккаунта merge пишет каноническую сущность, перед записью — гейт', async () => {
    const { svc, run, events } = makeService({ states: ['active'] });

    await svc.mergeEntitiesInProfile('u-k1', 'interest', ['шахматы', 'chess'], 'шахматы');

    const writes = writesOf(run);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('MERGE (p:Profile {phone: $phone})');
    expectGateBeforeEveryWrite(events);
  });
});

/**
 * Ревью K1: internal_id — это телефон (или uuid почтового входа), и в логах
 * его быть не должно. Принятой безопасной формы для userId в логах проекта нет
 * (maskPhone — только для SMS-номеров), поэтому строки — без идентификатора.
 */
describe('Neo4jService — логи без internal_id', () => {
  const savedOpenAIKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    jest.restoreAllMocks();
  });

  function spyLogs(svc: Neo4jService): () => string[] {
    const logger = (svc as any).logger;
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      jest.spyOn(logger, m).mockImplementation(() => undefined));
    return () => spies.flatMap((s) => s.mock.calls.map((c: any[]) => String(c[0])));
  }

  it('нераспознанный ответ модели: warn без идентификатора', async () => {
    const { svc } = makeService({ cliAnswer: 'not-json', states: ['active'] });
    const logs = spyLogs(svc);

    await svc.consolidateFromChat('u-k1', '12', 'я люблю шахматы', 'отлично', '');

    expect(logs().some((m) => /failed to parse JSON/.test(m))).toBe(true);
    expect(logs().filter((m) => m.includes('u-k1'))).toEqual([]);
  });

  it('эмбеддинг и замена сущностей: логи без идентификатора', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    jest.spyOn(axios, 'post').mockResolvedValue({ data: { data: [{ embedding: [0.1, 0.2, 0.3] }] } });
    const { svc } = makeService({ states: ['active'] });
    jest.spyOn(svc, 'getProfileDescription').mockResolvedValue('A sufficiently long profile description');
    const logs = spyLogs(svc);

    await svc.updateProfileEmbedding('u-k1');
    await svc.replaceEntities('u-k1', 'interest', ['шахматы']);

    expect(logs().some((m) => /Embedding updated/.test(m))).toBe(true);
    expect(logs().some((m) => /replaceEntities/.test(m))).toBe(true);
    expect(logs().filter((m) => m.includes('u-k1'))).toEqual([]);
  });
});
