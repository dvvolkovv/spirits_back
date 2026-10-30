import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { clockRedis } from '../auth/fake-redis.forspec';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestClaimService } from './guest-claim.service';
import { guestCarryKey } from './guest-carry';
import { hashGuestToken, newGuestToken } from './guest-token';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('перенос пробы в аккаунт против живого Postgres', () => {
  let pool: Pool;
  let sessions: GuestSessionsService;
  let redis: ReturnType<typeof clockRedis>;
  let neo4j: { consolidateFromChat: jest.Mock };
  let events: { track: jest.Mock };
  let svc: GuestClaimService;
  const pgShim = () => ({
    query: (s: string, p?: any[]) => pool.query(s, p),
    getClient: () => pool.connect(),
  });

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of GUEST_TRIAL_MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // Схема custom_chat_history — как на проде (\d custom_chat_history, 30.10.2026).
    await pool.query(`CREATE TABLE IF NOT EXISTS custom_chat_history (
      id serial PRIMARY KEY,
      session_id text NOT NULL,
      sender_type varchar(10) NOT NULL CHECK (sender_type IN ('ai', 'human')),
      agent integer,
      content text NOT NULL,
      created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
      message_type varchar(20) NOT NULL DEFAULT 'text' CHECK (message_type IN ('text', 'image')),
      tokens_used integer DEFAULT 0)`);
    sessions = new GuestSessionsService(pgShim() as any);
  });
  beforeEach(async () => {
    await pool.query('TRUNCATE guest_trial_sessions CASCADE; TRUNCATE custom_chat_history');
    redis = clockRedis();
    neo4j = { consolidateFromChat: jest.fn(async () => {}) };
    events = { track: jest.fn() };
    svc = new GuestClaimService(pgShim() as any, redis as any, neo4j as any, events as any);
  });
  afterAll(async () => { await pool.end(); });

  async function trial(assistantId: number, pairs: number) {
    const token = newGuestToken();
    const row = await sessions.create({ tokenHash: hashGuestToken(token), assistantId, lang: 'ru', source: null, campaign: null });
    for (let i = 1; i <= pairs; i++) await sessions.recordExchange(row.id, `Вопрос ${i}`, `Ответ ${i}`, new Date(Date.now() - (10 - i) * 1000), 0.01);
    return { token, row };
  }
  const history = (sid: string) =>
    pool.query('SELECT sender_type, content, agent FROM custom_chat_history WHERE session_id = $1 ORDER BY created_at, id', [sid]).then((r) => r.rows);

  it('новый аккаунт: пары в истории по порядку, гостевые сообщения стёрты, приписки нет', async () => {
    const { token, row } = await trial(12, 2);
    const r = await svc.claim('u-new', token);
    expect(r).toEqual({ status: 200, body: { assistantId: '12', moved: 4 } });
    expect(await history('u-new_12')).toEqual([
      { sender_type: 'human', content: 'Вопрос 1', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 1', agent: 12 },
      { sender_type: 'human', content: 'Вопрос 2', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 2', agent: 12 },
    ]);
    expect(await sessions.messages(row.id)).toEqual([]);
    expect(redis.peek(guestCarryKey('u-new', '12'))).toBeNull();
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(neo4j.consolidateFromChat).toHaveBeenCalledWith('u-new', '12', 'Вопрос 1', 'Ответ 1');
    expect(events.track).toHaveBeenCalledWith('guest_trial_claimed', { userId: 'u-new', props: { assistant_id: '12', answers: 2, existing: false } });
  });

  it('повтор тем же — moved 0, другим — 409', async () => {
    const { token } = await trial(12, 1);
    await svc.claim('u1', token);
    expect(await svc.claim('u1', token)).toEqual({ status: 200, body: { assistantId: '12', moved: 0 } });
    expect((await svc.claim('u2', token)).status).toBe(409);
    expect(await history('u1_12')).toHaveLength(2);
  });

  // Дополнение контролёра (ревью A3): «уже перенесена» определяется по claimed_at,
  // а не по claimed_by_hash — тот обнуляется уборкой через 7 дней после переноса
  // (Задача A6). После обнуления хеша повтор тем же человеком не должен молча
  // получить 200: сверить его больше не с чем, поэтому любой повтор — 409.
  it('хеш переносившего обнулён уборкой — повтор тем же человеком тоже 409', async () => {
    const { token } = await trial(12, 1);
    await svc.claim('u1', token);
    await pool.query(`UPDATE guest_trial_sessions SET claimed_by_hash = NULL WHERE token_hash = $1`, [hashGuestToken(token)]);
    expect((await svc.claim('u1', token)).status).toBe(409);
  });

  it('одновременные переносы тем же — история не двоится', async () => {
    const { token } = await trial(12, 2);
    await Promise.all([svc.claim('u1', token), svc.claim('u1', token), svc.claim('u1', token)]);
    expect(await history('u1_12')).toHaveLength(4);
  });

  it('просроченная, пустая и незнакомая — 404', async () => {
    const old = await trial(12, 1);
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [old.row.id]);
    expect((await svc.claim('u1', old.token)).status).toBe(404);
    const empty = await trial(12, 0);
    expect((await svc.claim('u1', empty.token)).status).toBe(404);
    expect((await svc.claim('u1', newGuestToken())).status).toBe(404);
    expect((await svc.claim('u1', 'короткий')).status).toBe(404);
  });

  it('аккаунт с прошлым разговором у ассистента — приписка для релея; у Маши — нет', async () => {
    await pool.query(`INSERT INTO custom_chat_history (session_id, sender_type, agent, content) VALUES ('u-old_12', 'human', 12, 'давнее'), ('u-old_3', 'human', 3, 'давнее')`);
    const roman = await trial(12, 1);
    expect((await svc.claim('u-old', roman.token)).status).toBe(200);
    expect(redis.peek(guestCarryKey('u-old', '12'))).toContain('Человек: Вопрос 1');
    const masha = await trial(3, 1);
    expect((await svc.claim('u-old', masha.token)).status).toBe(200);
    expect(redis.peek(guestCarryKey('u-old', '3'))).toBeNull();
  });
});
