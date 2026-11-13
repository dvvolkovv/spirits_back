import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { AlertBotLifecycle } from './alert-bot.lifecycle';
import { RepairStore } from './alert-bot.repair-store';
import { AlertBotStore } from './alert-bot.store';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;
const SCHEMA = `alert_bot_lifecycle_spec_${process.pid}`;

maybe('startup миграции AlertBot против PostgreSQL', () => {
  const env = { ...process.env };
  let admin: Pool;
  let pool: Pool;
  let store: AlertBotStore;
  let repairStore: RepairStore;
  let lifecycle: AlertBotLifecycle;

  beforeAll(async () => {
    delete process.env.ALERT_BOT_WEBHOOK_URL;
    delete process.env.ALERT_BOT_WEBHOOK_SECRET;
    admin = new Pool({ connectionString: PG, max: 1 });
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${SCHEMA}`);
    pool = new Pool({ connectionString: PG, max: 4, options: `-c search_path=${SCHEMA}` });
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', '001_alert_bot.sql'), 'utf8'));
    const pg = { query: pool.query.bind(pool), getClient: () => pool.connect() } as any;
    store = new AlertBotStore(pg);
    repairStore = new RepairStore(pg);
    lifecycle = new (AlertBotLifecycle as any)(
      store,
      { start: jest.fn(), stop: jest.fn() },
      { registerWebhook: jest.fn(), sendMessage: jest.fn() },
      { idle: jest.fn() },
      { retryFailedUpdates: jest.fn(), stopAdmission: jest.fn() },
      { registerPreCloseHook: jest.fn() },
    );
    (lifecycle as any).repairStore = repairStore;
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await admin?.end();
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  it('применяет 002 сразу после 001 и разрешает read-only createTurn с replyText', async () => {
    const events: string[] = [];
    const baseMigrate = store.migrate.bind(store);
    const repairMigrate = repairStore.migrate.bind(repairStore);
    jest.spyOn(store, 'migrate').mockImplementation(async () => {
      events.push('001');
      return baseMigrate();
    });
    jest.spyOn(repairStore, 'migrate').mockImplementation(async () => {
      events.push('002');
      return repairMigrate();
    });

    await lifecycle.onModuleInit();
    const turnId = await store.createTurn({
      updateId: 93001,
      chatId: 'startup',
      tgUserId: '200',
      adminUserId: 'admin-startup',
      questionMessageId: 10,
      question: 'Что происходит?',
      replyText: 'Диагноз до repair',
      privateChat: true,
    });

    expect(events).toEqual(['001', '002']);
    expect(turnId).toEqual(expect.any(String));
    expect((await pool.query('SELECT reply_text FROM alert_bot_turns WHERE id = $1', [turnId])).rows[0])
      .toEqual({ reply_text: 'Диагноз до repair' });
    await expect(repairStore.migrate()).resolves.toBeUndefined();
  });
});
