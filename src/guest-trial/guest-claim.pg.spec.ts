import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { clockRedis } from '../auth/fake-redis.forspec';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { GuestClaimService } from './guest-claim.service';
import { guestCarryKey } from './guest-carry';
import { hashGuestToken, newGuestToken } from './guest-token';
import { MASHA_AGENT_ID } from './guest-trial.types';

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
    // recordExchange пишет human.created_at = переданный humanAt, а ai.created_at —
    // настоящий now() сервера (guest-sessions.service.ts). В цикле по нескольким
    // парам это укладывается в миллисекунды реального времени: все ai оказываются
    // почти в одной точке «сейчас», а все human — в прошлом по смещению, независимо
    // от его величины. При 2+ парах порядок по created_at слипается в
    // [human1, human2, …, ai1, ai2, …] вместо чередования — не флаки, а гарантированный
    // эффект устройства recordExchange. claim() намеренно переносит эти метки как есть
    // (комментарий «исходное время сообщений» в guest-claim.service.ts), поэтому правим
    // не его, а стенд: расставляем created_at по истинному порядку вставки (id).
    if (pairs > 0) {
      await pool.query(
        `WITH ranked AS (
           SELECT id, row_number() OVER (ORDER BY id) AS rn
             FROM guest_trial_messages WHERE session_id = $1::uuid
         )
         UPDATE guest_trial_messages m
            SET created_at = $2::timestamptz + (ranked.rn::text || ' seconds')::interval
           FROM ranked WHERE m.id = ranked.id`,
        [row.id, new Date(Date.now() - 100 * 1000)],
      );
    }
    const stamps = pairs > 0
      ? (await pool.query('SELECT created_at FROM guest_trial_messages WHERE session_id = $1::uuid ORDER BY id', [row.id])).rows.map((x: any) => x.created_at)
      : [];
    return { token, row, stamps };
  }
  const history = (sid: string) =>
    pool.query('SELECT sender_type, content, agent FROM custom_chat_history WHERE session_id = $1 ORDER BY created_at, id', [sid]).then((r) => r.rows);
  const createdAts = (sid: string) =>
    pool.query('SELECT created_at FROM custom_chat_history WHERE session_id = $1 ORDER BY created_at, id', [sid]).then((r) => r.rows.map((x) => x.created_at));

  it('новый аккаунт: пары в истории по порядку, гостевые сообщения стёрты, приписка для релея', async () => {
    const { token, row, stamps } = await trial(12, 2);
    const r = await svc.claim('u-new', token);
    expect(r).toEqual({ status: 200, body: { assistantId: '12', moved: 4 } });
    expect(await history('u-new_12')).toEqual([
      { sender_type: 'human', content: 'Вопрос 1', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 1', agent: 12 },
      { sender_type: 'human', content: 'Вопрос 2', agent: 12 },
      { sender_type: 'ai', content: 'Ответ 2', agent: 12 },
    ]);
    // Перенесённые строки несут исходное время сообщений пробы, не момент переноса.
    expect(await createdAts('u-new_12')).toEqual(stamps);
    expect(await sessions.messages(row.id)).toEqual([]);
    // Приписка — даже новому аккаунту: claim() не видит сессий релея, только
    // custom_chat_history. Если этот аккаунт уже вёл сессию с ассистентом 12
    // на релее, она возобновится по --resume без пробы, если не оставить приписку.
    expect(redis.peek(guestCarryKey('u-new', '12'))).toContain('Человек: Вопрос 1');
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(neo4j.consolidateFromChat).toHaveBeenCalledWith('u-new', '12', 'Вопрос 1', 'Ответ 1', '');
    expect(neo4j.consolidateFromChat).toHaveBeenCalledWith('u-new', '12', 'Вопрос 2', 'Ответ 2', 'Ответ 1');
    expect(events.track).toHaveBeenCalledWith('guest_trial_claimed', {
      userId: 'u-new',
      source: null,
      props: { assistant_id: '12', answers: 2, existing: false, trial: row.id },
    });
  });

  it('новый аккаунт у Маши — приписки всё равно нет (она не зависит от hadHistory)', async () => {
    const { token } = await trial(MASHA_AGENT_ID, 1);
    const r = await svc.claim('u-new-masha', token);
    expect(r.status).toBe(200);
    expect(redis.peek(guestCarryKey('u-new-masha', String(MASHA_AGENT_ID)))).toBeNull();
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

  it('одновременные переносы тем же — история не двоится, перенёс только один', async () => {
    const { token } = await trial(12, 2);
    const results = await Promise.all([svc.claim('u1', token), svc.claim('u1', token), svc.claim('u1', token)]);
    expect(results.map((r) => r.body.moved).sort((a, b) => Number(a) - Number(b))).toEqual([0, 0, 4]);
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

  /**
   * Ревью A8: если ROLLBACK сам прошёл нормально, соединение возвращается в
   * пул обычным release() (release(false)) — это именно тот случай. Сбой
   * ловится ДО commit, в середине транзакции: ни запись в custom_chat_history,
   * ни claimed_at/claimed_by_hash, ни удаление сообщений пробы не должны
   * уцелеть.
   *
   * Важно: подменяем ТОЛЬКО свою обёртку-прокси, а не client.query на самом
   * объекте из pool.connect() — node-postgres переиспользует объекты клиентов
   * между вызовами connect()/release(), и порча метода прямо на нём пережила
   * бы этот тест и ударила бы по следующему, который её не ждёт (приводило к
   * зависанию прогона — ROLLBACK/release у чужого claim() молча не проходили).
   * realClient здесь всегда отдаётся release() без изменений.
   */
  it('сбой посреди переноса — вся транзакция откатывается, данные пробы на месте', async () => {
    const { token, row } = await trial(12, 1);
    const realClient = await pool.connect();
    let released = false;
    const proxyClient = {
      query: (sql: any, params?: any[]) => {
        const text = typeof sql === 'string' ? sql : '';
        if (text.includes('DELETE FROM guest_trial_messages')) return Promise.reject(new Error('boom: имитация сбоя'));
        return realClient.query(sql, params);
      },
      release: (err?: any) => {
        released = true;
        return realClient.release(err);
      },
    };
    const flakyPg = {
      query: (s: string, p?: any[]) => pool.query(s, p),
      getClient: async () => proxyClient,
    };
    const flakySvc = new GuestClaimService(flakyPg as any, redis as any, neo4j as any, events as any);
    try {
      await expect(flakySvc.claim('u-broken', token)).rejects.toThrow('boom');
      expect(await sessions.messages(row.id)).toHaveLength(2);
      expect(await history('u-broken_12')).toEqual([]);
      const check = await pool.query('SELECT claimed_at FROM guest_trial_sessions WHERE id = $1', [row.id]);
      expect(check.rows[0].claimed_at).toBeNull();
      // Соединение обязано вернуться в пул сразу внутри claim() — иначе
      // красный тест тихо повиснет, а не упадёт (см. комментарий выше теста).
      expect(released).toBe(true);
    } finally {
      // Страховка прогона, а не замена утверждения выше: если claim() когда-
      // нибудь перестанет сам освобождать соединение, тест всё равно не
      // оставит его висеть в пуле (иначе получили бы ровно то же зависание,
      // которое уже один раз случилось на этом тесте).
      if (!released) realClient.release(true);
    }
  });

  it('разбор профиля — не больше пяти последних пар', async () => {
    const { token } = await trial(12, 6);
    await svc.claim('u-many', token);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(neo4j.consolidateFromChat).toHaveBeenCalledTimes(5);
    expect(neo4j.consolidateFromChat).not.toHaveBeenCalledWith('u-many', '12', 'Вопрос 1', 'Ответ 1', expect.anything());
    expect(neo4j.consolidateFromChat).toHaveBeenNthCalledWith(1, 'u-many', '12', 'Вопрос 2', 'Ответ 2', '');
  });

  it('сбой разбора одной пары не останавливает перенос следующей', async () => {
    const { token } = await trial(12, 2);
    neo4j.consolidateFromChat.mockRejectedValueOnce(new Error('boom'));
    await svc.claim('u-partial-fail', token);
    await new Promise((res) => setImmediate(res));
    await new Promise((res) => setImmediate(res));
    expect(neo4j.consolidateFromChat).toHaveBeenCalledTimes(2);
    expect(neo4j.consolidateFromChat).toHaveBeenNthCalledWith(2, 'u-partial-fail', '12', 'Вопрос 2', 'Ответ 2', 'Ответ 1');
  });
});
