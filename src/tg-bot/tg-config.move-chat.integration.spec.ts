import { Client } from 'pg';
import { TgConfigService } from './tg-config.service';

/**
 * Переезд группы в супергруппу (moveToChat) — против живого Postgres.
 *
 * ПОЧЕМУ SQL ИСПОЛНЯЕТСЯ. Переезд — один запрос с изменяющими CTE: что он
 * переносит (конфиг, ВСЯ история чата, включая строки прежних ботов, ждущие
 * видео), что оставляет (доставленные видео, чужие чаты) и как ведёт себя на
 * уникальном индексе активных чатов, решает сам запрос. Юнит-тест видит только
 * его текст.
 *
 * Зачем вся история чата, а не только своего конфига: проверки «писал ли в
 * чате кто-то, кроме владельца» (isSoloChat, onlySpeakerIs) смотрят на
 * tg_chat_id. Оставь строки прежнего бота на старом id — и в супергруппе, где
 * сидят чужие люди, бот решит, что пишет один владелец, и подмешает в промпт
 * его личный профиль.
 *
 * КАК ГОНЯТЬ — как tg-router.only-speaker.integration.spec.ts: таблицы TEMP на
 * единственном соединении, постоянных файл не трогает.
 *
 *   createdb -h /var/run/postgresql pcl_move_spec
 *   TG_GATE_PG_URL='postgresql:///pcl_move_spec?host=/var/run/postgresql' npx jest src/tg-bot/tg-config.move-chat.integration.spec.ts
 *   dropdb -h /var/run/postgresql pcl_move_spec
 *
 * Без TG_GATE_PG_URL файл пропускается (skipped), а не зеленеет.
 */

const PG = process.env.TG_GATE_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('переезд группы в супергруппу против живого Postgres', () => {
  jest.setTimeout(30_000);

  let client: Client;
  const pg = { query: (sql: string, params?: any[]) => client.query(sql, params) };
  const svc = () => {
    const s = new TgConfigService(pg as any, {} as any);
    (s as any).logger = { log: () => {}, warn: () => {}, error: () => {} };
    return s;
  };

  const OLD = -4001;
  const NEW = -1004001;
  const ELSEWHERE = -1009999;

  beforeAll(async () => {
    client = new Client({ connectionString: PG });
    await client.connect();
    await client.query(`CREATE TEMP TABLE tg_bot_configs (id text PRIMARY KEY, tg_chat_id bigint, status text NOT NULL)`);
    await client.query(
      `CREATE UNIQUE INDEX tmp_active_chat ON tg_bot_configs (tg_chat_id) WHERE status IN ('active','silent')`,
    );
    await client.query(`CREATE TEMP TABLE tg_bot_messages (id serial PRIMARY KEY, config_id text, tg_chat_id bigint NOT NULL)`);
    await client.query(
      `CREATE TEMP TABLE tg_bot_video_jobs (job_id text PRIMARY KEY, tg_chat_id bigint NOT NULL, tg_reply_to_message_id bigint, delivery_status text NOT NULL)`,
    );
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('DELETE FROM tg_bot_configs');
    await client.query('DELETE FROM tg_bot_messages');
    await client.query('DELETE FROM tg_bot_video_jobs');
  });

  const chatOf = async (table: string, where: string, params: any[] = []) =>
    (await client.query(`SELECT tg_chat_id FROM ${table} WHERE ${where}`, params)).rows.map((r) => Number(r.tg_chat_id));

  it('конфиг, вся история чата (и прежнего бота) и ждущие видео — на новый id; доставленное и чужое — на месте', async () => {
    await client.query(`INSERT INTO tg_bot_configs VALUES ('cur', $1, 'active'), ('old', $1, 'archived'), ('other', $2, 'active')`, [OLD, ELSEWHERE]);
    await client.query(`INSERT INTO tg_bot_messages (config_id, tg_chat_id) VALUES ('cur', $1), ('old', $1), ('old', $1), ('other', $2)`, [OLD, ELSEWHERE]);
    await client.query(`INSERT INTO tg_bot_video_jobs VALUES ('v-wait', $1, 77, 'pending'), ('v-sent', $1, 78, 'sent')`, [OLD]);

    expect(await svc().moveToChat(OLD, NEW)).toBe(true);

    expect(await chatOf('tg_bot_configs', `id = 'cur'`)).toEqual([NEW]);
    expect(await chatOf('tg_bot_messages', `config_id IN ('cur','old')`)).toEqual([NEW, NEW, NEW]);
    expect(await chatOf('tg_bot_messages', `config_id = 'other'`)).toEqual([ELSEWHERE]);
    expect(await chatOf('tg_bot_video_jobs', `job_id = 'v-wait'`)).toEqual([NEW]);
    expect(await chatOf('tg_bot_video_jobs', `job_id = 'v-sent'`)).toEqual([OLD]);
    // В супергруппе нумерация сообщений своя: ответ на сообщение старой группы
    // не найдётся (или прицепится к чужому) — видео уходит без ответа.
    const reply = (await client.query(`SELECT tg_reply_to_message_id AS r FROM tg_bot_video_jobs WHERE job_id = 'v-wait'`)).rows[0].r;
    expect(reply).toBeNull();
  });

  it('второе служебное сообщение (migrate_from после migrate_to) ничего не меняет', async () => {
    await client.query(`INSERT INTO tg_bot_configs VALUES ('cur', $1, 'active')`, [OLD]);
    await client.query(`INSERT INTO tg_bot_messages (config_id, tg_chat_id) VALUES ('cur', $1)`, [OLD]);

    expect(await svc().moveToChat(OLD, NEW)).toBe(true);
    expect(await svc().moveToChat(OLD, NEW)).toBe(true);

    expect(await chatOf('tg_bot_configs', `id = 'cur'`)).toEqual([NEW]);
    expect(await chatOf('tg_bot_messages', `true`)).toEqual([NEW]);
  });

  it('на новом id уже свой активный бот — не переезжает ничего (атомарно), ошибка наверх не всплывает', async () => {
    await client.query(`INSERT INTO tg_bot_configs VALUES ('cur', $1, 'active'), ('there', $2, 'active')`, [OLD, NEW]);
    await client.query(`INSERT INTO tg_bot_messages (config_id, tg_chat_id) VALUES ('cur', $1)`, [OLD]);

    await expect(svc().moveToChat(OLD, NEW)).resolves.toBe(false);

    expect(await chatOf('tg_bot_configs', `id = 'cur'`)).toEqual([OLD]);
    expect(await chatOf('tg_bot_messages', `true`)).toEqual([OLD]);
  });

  it('в старом чате нет работающего бота — история не трогается', async () => {
    await client.query(`INSERT INTO tg_bot_configs VALUES ('old', $1, 'archived')`, [OLD]);
    await client.query(`INSERT INTO tg_bot_messages (config_id, tg_chat_id) VALUES ('old', $1)`, [OLD]);

    expect(await svc().moveToChat(OLD, NEW)).toBe(false);

    expect(await chatOf('tg_bot_messages', `true`)).toEqual([OLD]);
  });

  it('служебное сообщение обогнало ход: конфиг уже на новом id — реплика, записанная ходом под старым, догоняет его', async () => {
    // Ход нашёл конфиг по старому id, служебное migrate_to_chat_id перевезло
    // его, а ход уже после этого записал реплику человека под старым id.
    await client.query(`INSERT INTO tg_bot_configs VALUES ('cur', $1, 'active')`, [NEW]);
    await client.query(`INSERT INTO tg_bot_messages (config_id, tg_chat_id) VALUES ('cur', $1)`, [OLD]);
    await client.query(`INSERT INTO tg_bot_video_jobs VALUES ('v-wait', $1, 77, 'pending')`, [OLD]);

    expect(await svc().moveToChat(OLD, NEW)).toBe(true);

    expect(await chatOf('tg_bot_messages', `true`)).toEqual([NEW]);
    expect(await chatOf('tg_bot_video_jobs', `job_id = 'v-wait'`)).toEqual([NEW]);
  });
});
