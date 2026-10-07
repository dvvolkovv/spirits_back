import { Client } from 'pg';
import { ChatService } from './chat.service';
import { loadCoworkers } from './coworkers';

/**
 * Список коллег для системного промпта — против живого Postgres.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ИСПОЛНЯЕТ SQL. Кто попадёт в блок «Коллеги-ассистенты»,
 * решает запрос: is_active, служебные имена через `<> ALL($3::text[])`,
 * описание, перевод на язык пользователя. Юнит-тест (coworkers.spec.ts)
 * подменяет pg и SQL не исполняет — здесь он исполняется целиком, тем же
 * запросом, что уходит с прода.
 *
 * КАК ГОНЯТЬ. Нужна любая база, где роль может создать TEMP-таблицу: файл
 * заводит `agents` и `agent_translations` как TEMP на своём единственном
 * соединении — они перекрывают настоящие таблицы только в этой сессии и
 * исчезают при отключении. Постоянных таблиц файл не трогает.
 *
 *   createdb -h /var/run/postgresql coworkers_spec
 *   COWORKERS_PG_URL='postgresql:///coworkers_spec?host=/var/run/postgresql' npx jest src/chat/coworkers.integration.spec.ts
 *   dropdb -h /var/run/postgresql coworkers_spec
 *
 * Без COWORKERS_PG_URL файл пропускается целиком (skipped), а не зеленеет.
 */

const PG = process.env.COWORKERS_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('коллеги ассистента против живого Postgres', () => {
  jest.setTimeout(30_000);

  let client: Client;
  const pg = { query: (sql: string, params?: any[]) => client.query(sql, params) };

  beforeAll(async () => {
    client = new Client({ connectionString: PG });
    await client.connect();
    // Колонки — как в base/001_core_schema.sql + agents/004 (is_active) и
    // agents/001_agent_translations.sql. Нужные запросу, без лишних.
    await client.query(`CREATE TEMP TABLE agents (
      id integer PRIMARY KEY,
      name text,
      system_prompt text,
      description text,
      category varchar DEFAULT 'business',
      display_name text,
      is_active boolean NOT NULL DEFAULT true
    )`);
    await client.query(`CREATE TEMP TABLE agent_translations (
      entity_type text NOT NULL,
      entity_id text NOT NULL,
      locale text NOT NULL,
      display_name text,
      description text,
      PRIMARY KEY (entity_type, entity_id, locale)
    )`);
    // Состав — как на проде 06.10.2026 по смыслу: активные, выключенные,
    // служебная строка и строка без описания.
    await client.query(`INSERT INTO agents (id, name, display_name, description, is_active) VALUES
      (2,  'Оля',           'Оля',     'Исследование ценностей', true),
      (8,  'Герман',        'Герман',  'Про осознанность',       false),
      (12, 'Роман',         'Роман',   'Бизнес-ассистент',       true),
      (15, 'smm_producer',  'Юлия',    'SMM-продюсер',           false),
      (18, 'linkeon_voice', 'Линкеон', 'Голосовой ассистент',    true),
      (21, 'Полина',        'Полина',  NULL,                     true),
      (22, 'Кира',          'Кира',    'Дизайнер',               true)`);
    await client.query(`INSERT INTO agent_translations (entity_type, entity_id, locale, display_name, description) VALUES
      ('agent', '2',  'es', 'Olia',   'Exploración de valores'),
      ('agent', '8',  'es', 'German', 'Sobre la atención plena'),
      ('agent', '15', 'es', 'Yulia',  'Productora SMM')`);
  });

  afterAll(async () => {
    await client?.end();
  });

  const names = async (selfId: number, locale: string) =>
    (await loadCoworkers(pg as any, selfId, locale)).map((c) => c.display_name);

  it('только активные и не служебные, без себя и без строк без описания', async () => {
    expect(await names(12, 'ru')).toEqual(['Оля', 'Кира']);
  });

  it('выключенные не возвращаются и через перевод', async () => {
    // У Германа и Юлии есть испанские переводы — LEFT JOIN не должен их
    // «оживлять». У Киры перевода нет: она остаётся с русскими колонками.
    expect(await names(12, 'es')).toEqual(['Olia', 'Кира']);
  });

  it('у Маши тот же список, только без неё самой', async () => {
    await client.query(`INSERT INTO agents (id, name, display_name, description, is_active)
                        VALUES (3, 'Маша', 'Маша', 'Игропрактик', true)`);
    try {
      expect(await names(3, 'ru')).toEqual(['Оля', 'Роман', 'Кира']);
    } finally {
      await client.query('DELETE FROM agents WHERE id = 3');
    }
  });

  it('блок в промпте релея: ни выключенных, ни служебного', async () => {
    const language = { resolveUserLanguage: async () => 'ru' };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any, language as any, undefined as any,
    );
    const prefix: string = await (svc as any).buildRelayStablePrefix({
      agentId: '12', agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты Роман.',
      userId: 'u1', userLanguage: 'ru',
    });

    const start = prefix.indexOf('--- Коллеги-ассистенты в Linkeon ---');
    expect(start).toBeGreaterThan(-1);
    const block = prefix.slice(start, prefix.indexOf('\n\n', start));
    expect(block).toContain('• Оля — Исследование ценностей');
    expect(block).toContain('• Кира — Дизайнер');
    for (const gone of ['Герман', 'Юлия', 'Линкеон', 'Полина']) expect(block).not.toContain(gone);
  });

  it('пользовательский ассистент: Number(custom:…) запрос бы уронил — поэтому его и не зовём', async () => {
    // Фиксирует причину ветки `!isCustom` в buildRelayStablePrefix: до правки
    // блок коллег у пользовательских ассистентов пропадал именно так.
    await expect(loadCoworkers(pg as any, Number('custom:abc'), 'ru')).rejects.toThrow(/integer/);
  });
});
