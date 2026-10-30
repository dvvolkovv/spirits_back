import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { GUEST_TRIAL_MIGRATIONS } from './guest-trial-store.service';
import { GuestSessionsService } from './guest-sessions.service';
import { hashGuestToken, newGuestToken } from './guest-token';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('пробы и сообщения против живого Postgres', () => {
  let pool: Pool;
  let svc: GuestSessionsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    for (const f of GUEST_TRIAL_MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    // events — для status(); в тестовой базе своей схемы проекта нет.
    await pool.query(`CREATE TABLE IF NOT EXISTS events (id bigserial PRIMARY KEY, ts timestamptz NOT NULL DEFAULT now(), user_id text, session_id text, name text NOT NULL, props jsonb NOT NULL DEFAULT '{}'::jsonb, source text)`);
    svc = new GuestSessionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE guest_trial_sessions CASCADE; TRUNCATE events'));
  afterAll(async () => { await pool.end(); });

  const create = (assistantId = 12) => {
    const token = newGuestToken();
    return svc.create({ tokenHash: hashGuestToken(token), assistantId, lang: 'ru', source: null, campaign: null }).then((row) => ({ row, token }));
  };

  it('создать и найти по хешу ключа; чужой хеш — пусто', async () => {
    const { row, token } = await create();
    expect(row.answers).toBe(0);
    const found = await svc.findLive(hashGuestToken(token));
    expect(found?.id).toBe(row.id);
    expect(found?.assistant_id).toBe(12);
    expect(await svc.findLive(hashGuestToken(newGuestToken()))).toBeNull();
  });

  it('пара «вопрос — ответ»: счёт, стоимость, порядок', async () => {
    const { row } = await create();
    const t0 = new Date(Date.now() - 5000);
    expect(await svc.recordExchange(row.id, 'Вопрос 1', 'Ответ 1', t0, 0.05)).toBe(1);
    expect(await svc.recordExchange(row.id, 'Вопрос 2', 'Ответ 2', new Date(), 0.07)).toBe(2);
    expect(await svc.messages(row.id)).toEqual([
      { sender_type: 'human', content: 'Вопрос 1' },
      { sender_type: 'ai', content: 'Ответ 1' },
      { sender_type: 'human', content: 'Вопрос 2' },
      { sender_type: 'ai', content: 'Ответ 2' },
    ]);
    const cost = await pool.query('SELECT cost_usd::float AS c FROM guest_trial_sessions WHERE id = $1', [row.id]);
    expect(cost.rows[0].c).toBeCloseTo(0.12, 4);
  });

  it('неперенесённая проба старше 7 дней не находится', async () => {
    const { row, token } = await create();
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [row.id]);
    expect(await svc.findLive(hashGuestToken(token))).toBeNull();
  });

  it('уборка: старые неперенесённые и перенесённые старше 90 дней — удаляются, свежие — нет; хеш переносящего гаснет через 7 дней после переноса', async () => {
    const oldOpen = (await create()).row;
    const fresh = (await create()).row;
    const oldClaimed = (await create()).row;
    const recentClaimed = (await create()).row;
    const hashExpiredClaim = (await create()).row;
    await pool.query(`UPDATE guest_trial_sessions SET last_message_at = now() - interval '8 days' WHERE id = $1`, [oldOpen.id]);
    await pool.query(`UPDATE guest_trial_sessions SET claimed_at = now() - interval '91 days', claimed_by_hash = 'h' WHERE id = $1`, [oldClaimed.id]);
    await pool.query(`UPDATE guest_trial_sessions SET claimed_at = now() - interval '1 day', claimed_by_hash = 'h', last_message_at = now() - interval '30 days' WHERE id = $1`, [recentClaimed.id]);
    // Перенесена 8 дней назад — старше окна хеша (7 дней), но моложе окна строки (90 дней):
    // строка должна остаться, а claimed_by_hash — обнулиться.
    await pool.query(`UPDATE guest_trial_sessions SET claimed_at = now() - interval '8 days', claimed_by_hash = 'h', last_message_at = now() - interval '30 days' WHERE id = $1`, [hashExpiredClaim.id]);
    expect(await svc.purge()).toBe(2);
    const left = await pool.query('SELECT id::text AS id, claimed_by_hash FROM guest_trial_sessions ORDER BY created_at');
    expect(left.rows.map((r: any) => r.id).sort()).toEqual([fresh.id, recentClaimed.id, hashExpiredClaim.id].sort());
    const byId = new Map(left.rows.map((r: any) => [r.id, r.claimed_by_hash]));
    expect(byId.get(recentClaimed.id)).toBe('h');
    expect(byId.get(hashExpiredClaim.id)).toBeNull();
  });

  it('статистика: пробы и переносы — по created_at/claimed_at пробы, ответы и стоимость — по событиям ответа', async () => {
    const { row } = await create();
    // Проба может отвечать до 7 дней после создания — ответ НЕ привязан к
    // created_at пробы. Сдвигаем created_at в прошлое: если бы answers_day/
    // cost_usd_day считались по created_at пробы (как раньше), тест бы не
    // прошёл — сегодняшний ответ «потерялся» бы в дне создания (3 дня назад).
    await pool.query(`UPDATE guest_trial_sessions SET created_at = now() - interval '3 days' WHERE id = $1`, [row.id]);
    await pool.query(
      `INSERT INTO events (name, ts, props) VALUES
         ('guest_trial_answer', now(), '{"cost_usd":0.1,"n":1}'::jsonb),
         ('guest_trial_answer', now() - interval '2 days', '{"cost_usd":0.2,"n":1}'::jsonb),
         ('guest_trial_wall', now(), '{}'::jsonb),
         ('guest_trial_view', now(), '{}'::jsonb),
         ('guest_trial_view', now(), '{}'::jsonb)`,
    );
    const s = await svc.status();
    expect(s).toMatchObject({
      trials_day: 0,
      trials_week: 1,
      claims_day: 0,
      answers_day: 1,
      answers_week: 2,
      guest_trial_view_day: 2,
      guest_trial_wall_day: 1,
      guest_trial_closed_day: 0,
    });
    expect(s.cost_usd_day).toBeCloseTo(0.1, 4);
    expect(s.cost_usd_week).toBeCloseTo(0.3, 4);
  });

  it('статистика: ключи событий guest_trial_view|wall|closed есть всегда, даже без единого события', async () => {
    const s = await svc.status();
    expect(s).toMatchObject({
      guest_trial_view_day: 0,
      guest_trial_view_week: 0,
      guest_trial_wall_day: 0,
      guest_trial_wall_week: 0,
      guest_trial_closed_day: 0,
      guest_trial_closed_week: 0,
    });
  });
});
