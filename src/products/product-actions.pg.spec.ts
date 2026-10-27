import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { MIGRATIONS } from './products.service';
import { ProductActionsService } from './product-actions.service';

const PG = process.env.PROVISIONING_PG_URL;
const maybe = PG ? describe : describe.skip;

maybe('журнал действий против живого Postgres', () => {
  let pool: Pool;
  let svc: ProductActionsService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 8 });
    for (const f of MIGRATIONS) await pool.query(fs.readFileSync(path.join(__dirname, 'migrations', f), 'utf8'));
    svc = new ProductActionsService({ query: (s: string, p?: any[]) => pool.query(s, p) } as any);
  });
  beforeEach(() => pool.query('TRUNCATE product_actions RESTART IDENTITY CASCADE'));
  afterAll(async () => { await pool.query('TRUNCATE product_actions RESTART IDENTITY CASCADE'); await pool.end(); });

  it('одновременные нажатия — взять в работу удаётся ровно одному', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    const got = await Promise.all([1, 2, 3, 4].map(() => svc.claim('u1', id, 'chat')));
    expect(got.filter(Boolean)).toHaveLength(1);
  });

  it('чужой пользователь не видит и не берёт', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    expect(await svc.get('u2', id)).toBeNull();
    expect(await svc.claim('u2', id, 'chat')).toBeNull();
  });

  it('просроченное не берётся', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: null, payload: {} });
    await pool.query(`UPDATE product_actions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await svc.claim('u1', id, 'chat')).toBeNull();
  });

  it('карточка прикрепляется к ходу один раз: по метке или по окну хода', async () => {
    const since = new Date(Date.now() - 1000);
    const a = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: '11111111-2222-4333-8444-555555555555', payload: {} });
    const b = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'web', turn: '99999999-2222-4333-8444-555555555555', payload: {} });
    const first = await svc.takeForTurn('u1', '11111111-2222-4333-8444-555555555555', since);
    expect(first.map((x) => x.id).sort()).toEqual([a.id, b.id].sort()); // b — по окну хода
    expect(await svc.takeForTurn('u1', '11111111-2222-4333-8444-555555555555', since)).toEqual([]);
  });

  it('фильтр канала: веб-ход не хватает карточку telegram, свой канал — хватает', async () => {
    const since = new Date(Date.now() - 1000);
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'delete', channel: 'telegram', turn: null, payload: {} });
    expect(await svc.takeForTurn('u1', 'nonce-x', since, 'web')).toEqual([]);
    const got = await svc.takeForTurn('u1', 'nonce-x', since, 'telegram');
    expect(got.map((x) => x.id)).toEqual([id]);
  });

  it('release возвращает в ожидание с ошибкой, finish закрывает', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'create_bot', channel: 'web', turn: null, payload: {} });
    await svc.claim('u1', id, 'chat');
    await svc.release(id, { error: 'Telegram не принял токен' });
    expect((await svc.get('u1', id))!.status).toBe('pending');
    await svc.claim('u1', id, 'chat');
    await svc.finish(id, 'done', { productId: null });
    expect((await svc.get('u1', id))!.status).toBe('done');
    expect(await svc.cancel('u1', id)).toBe(false);
  });

  it('release с дополнением payload дописывает поля поверх прежних, без него payload не трогает', async () => {
    const { id } = await svc.open({ userId: 'u1', productId: null, kind: 'keys', channel: 'web', turn: null, payload: { name: 'Бот', keyNames: ['A', 'B'] } });
    await svc.claim('u1', id, 'chat');
    await svc.release(id, { error: 'x', reason: 'bad_input' });
    expect((await pool.query('SELECT payload FROM product_actions WHERE id = $1', [id])).rows[0].payload).toEqual({ name: 'Бот', keyNames: ['A', 'B'] });
    await svc.claim('u1', id, 'chat');
    await svc.release(id, { error: 'x', reason: 'bad_shape' }, { keyNames: ['A'] });
    expect((await pool.query('SELECT payload FROM product_actions WHERE id = $1', [id])).rows[0].payload).toEqual({ name: 'Бот', keyNames: ['A'] });
    expect((await svc.get('u1', id))!.status).toBe('pending');
  });
});
