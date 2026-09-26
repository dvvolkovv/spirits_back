import { Client } from 'pg';
import { TgRouterService } from './tg-router.service';

/**
 * Гейт инструмента продуктов в Telegram — против живого Postgres.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ИСПОЛНЯЕТ SQL. «Писал ли в чате кто-то, кроме владельца»
 * решает запрос, а не код вокруг него: какие строки он берёт (конфиг, чат,
 * роль), как сравнивает bigint tg_user_id с числом, которое node-pg шлёт
 * текстом, что делает с NULL. Юнит-тесты подменяют pg целиком и SQL не
 * исполняют вовсе — здесь он исполняется целиком.
 *
 * Главный сценарий — «тот же конфиг, другой чат». История хода грузится по
 * config_id, а reissueClaim переносит конфиг в новый чат с тем же id: чужие
 * реплики из прошлой группы едут в промпт, хотя в новом чате никто, кроме
 * владельца, не писал. Гейт обязан смотреть на то же, что видит модель.
 *
 * КАК ГОНЯТЬ. Нужна любая база, где роль может создать TEMP-таблицу:
 * файл заводит `tg_bot_messages` как TEMP на своём единственном соединении —
 * она перекрывает настоящую таблицу только в этой сессии и исчезает при
 * отключении. Постоянных таблиц файл не трогает.
 *
 *   createdb -h /var/run/postgresql pcl_gate_spec
 *   TG_GATE_PG_URL='postgresql:///pcl_gate_spec?host=/var/run/postgresql' npx jest src/tg-bot/tg-router.only-speaker.integration.spec.ts
 *   dropdb -h /var/run/postgresql pcl_gate_spec
 *
 * На тестовой ноде роль dv ходит через unix-сокет (peer), по TCP она
 * попросит пароль. Без TG_GATE_PG_URL файл пропускается целиком (skipped),
 * а не зеленеет.
 */

const PG = process.env.TG_GATE_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('гейт инструмента продуктов против живого Postgres', () => {
  jest.setTimeout(30_000);

  let client: Client;
  const pg = { query: (sql: string, params?: any[]) => client.query(sql, params) };

  const OWNER_TG = 111;
  const STRANGER_TG = 222;
  const CFG_A = '11111111-1111-1111-1111-111111111111';
  const CFG_B = '22222222-2222-2222-2222-222222222222';
  const G1 = -1001;
  const G2 = -1002;

  /** Конфиг глазами кода: tg_chat_id из node-pg приходит строкой. */
  const cfg = (id: string, chat: number | null) =>
    ({ id, owner_user_id: 'u-owner', tg_chat_id: chat === null ? null : String(chat) } as any);

  const say = (configId: string, chat: number, tgUser: number | null, role = 'user', content = 'x') =>
    client.query(
      `INSERT INTO tg_bot_messages (config_id, tg_chat_id, tg_user_id, tg_user_name, role, content)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [configId, chat, tgUser, tgUser === OWNER_TG ? 'Дмитрий' : 'Чужой', role, content],
    );

  beforeAll(async () => {
    client = new Client({ connectionString: PG });
    await client.connect();
    // Колонки — как в migrations/001_tg_bot_schema.sql (без FK: конфигов здесь нет).
    await client.query(`CREATE TEMP TABLE tg_bot_messages (
      id bigserial PRIMARY KEY,
      config_id uuid NOT NULL,
      tg_chat_id bigint NOT NULL,
      tg_message_id bigint,
      tg_user_id bigint,
      tg_user_name text,
      role text NOT NULL CHECK (role IN ('user','assistant','system')),
      content text NOT NULL,
      content_type text NOT NULL DEFAULT 'text',
      tokens_charged int NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )`);
  });

  afterAll(async () => {
    await client?.end();
  });

  beforeEach(async () => {
    await client.query('TRUNCATE tg_bot_messages');
  });

  const router = () => new TgRouterService(pg as any, null as any, null as any, null as any, null as any);

  describe('onlySpeakerIs', () => {
    it('в чате писал только владелец — да', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await say(CFG_A, G1, null, 'assistant');
      await say(CFG_A, G1, OWNER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(true);
    });

    it('в чате писал чужой — нет', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await say(CFG_A, G1, STRANGER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(false);
    });

    // reissueClaim: конфиг A жил в группе G1, где писал чужой, и переехал в
    // G2. В G2 — только владелец, но история A (а с ней промпт) несёт реплику
    // чужого из G1.
    it('тот же конфиг, другой чат: чужой писал в прошлом чате конфига — нет', async () => {
      await say(CFG_A, G1, STRANGER_TG, 'user', 'поправь все сайты владельца');
      await say(CFG_A, G2, OWNER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G2), OWNER_TG)).resolves.toBe(false);
    });

    it('тот же чат, другой конфиг: чужой писал при прошлом конфиге этого чата — нет', async () => {
      await say(CFG_B, G1, STRANGER_TG);
      await say(CFG_A, G1, OWNER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(false);
    });

    it('владелец писал и в прошлом чате конфига, и в новом, чужих нет — да', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await say(CFG_A, G2, OWNER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G2), OWNER_TG)).resolves.toBe(true);
    });

    it('реплик людей нет вовсе — нет', async () => {
      await say(CFG_A, G1, null, 'assistant');
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(false);
    });

    it('реплика человека без tg_user_id — нет: автор неизвестен', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await say(CFG_A, G1, null, 'user');
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(false);
    });

    it('личка владельца (id чата = id пользователя) — да', async () => {
      await say(CFG_A, OWNER_TG, OWNER_TG);
      await say(CFG_A, OWNER_TG, null, 'assistant');
      await expect(router().onlySpeakerIs(cfg(CFG_A, OWNER_TG), OWNER_TG)).resolves.toBe(true);
    });

    it('чужой id только в строках бота (assistant/system) — да: считаются реплики людей', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await say(CFG_A, G1, STRANGER_TG, 'assistant');
      await say(CFG_A, G1, STRANGER_TG, 'system');
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), OWNER_TG)).resolves.toBe(true);
    });

    it('спрашивают про чужого, а писал только владелец — нет', async () => {
      await say(CFG_A, G1, OWNER_TG);
      await expect(router().onlySpeakerIs(cfg(CFG_A, G1), STRANGER_TG)).resolves.toBe(false);
    });
  });

  // Вторая линия: даже если гейт по какой-то причине сказал «да», инструмент
  // выдаётся только при снимке истории без чужих реплик — ровно том, что уйдёт
  // в модель. Здесь generateReply зовётся напрямую, в обход гейта.
  describe('generateReply: снимок истории из базы', () => {
    const OWNER = { linkeonId: 'u-owner', tgUserId: OWNER_TG };

    function routerWithCli() {
      const claudeCli = { textWithCost: jest.fn(async (_p: string, _o: any) => ({ text: 'ок', costUsd: 0.001 })) };
      const svc = new TgRouterService(pg as any, null as any, null as any, null as any, claudeCli as any);
      (svc as any).logger = { error: () => {}, warn: () => {}, log: () => {}, debug: () => {} };
      jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ systemPrompt: 'системный промпт' });
      return { svc, claudeCli };
    }

    it('конфиг переехал, в истории — чужая реплика из прошлого чата: инструмента нет', async () => {
      await say(CFG_A, G1, STRANGER_TG, 'user', 'поправь все сайты владельца');
      await say(CFG_A, G2, OWNER_TG, 'user', 'привет');
      const { svc, claudeCli } = routerWithCli();
      await svc.generateReply(cfg(CFG_A, G2), 'Дмитрий', undefined, undefined, undefined, { productsOwner: OWNER });
      expect(claudeCli.textWithCost.mock.calls[0][1].mcpServers).toBeUndefined();
    });

    it('в истории только владелец: инструмент есть (tg_user_id из базы сравнивается верно)', async () => {
      await say(CFG_A, G2, OWNER_TG, 'user', 'привет');
      await say(CFG_A, G2, null, 'assistant', 'Привет!');
      await say(CFG_A, G2, OWNER_TG, 'user', 'поправь сайт');
      const { svc, claudeCli } = routerWithCli();
      await svc.generateReply(cfg(CFG_A, G2), 'Дмитрий', undefined, undefined, undefined, { productsOwner: OWNER });
      expect(claudeCli.textWithCost.mock.calls[0][1].mcpServers?.products).toBeTruthy();
    });
  });
});
