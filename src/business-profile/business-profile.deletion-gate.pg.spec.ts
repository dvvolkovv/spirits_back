import { BusinessProfileService } from './business-profile.service';
import { createPrivacyPg, describePg } from '../privacy/profile-privacy.pg-helper';

/**
 * K1 — бизнес-карточка не воскресает у удалённого аккаунта.
 *
 * core.immediate оставляет строку ai_profiles_consolidated как оболочку и
 * обнуляет profile_data до '{}'. automaticProfilingAllowed на пустом профиле
 * отвечает true, поэтому извлечение из хода, начатого до удаления, без гейта
 * по состоянию дописывало в оболочку profile_data.business. Гейт — в том же
 * UPDATE: AND EXISTS (user_id state='active').
 */
describePg('BusinessProfileService: гейт на активный аккаунт против PostgreSQL', () => {
  let privacy: Awaited<ReturnType<typeof createPrivacyPg>>;
  const USER = '79990000302';

  beforeAll(async () => {
    privacy = await createPrivacyPg();
    await privacy.pool.query(`CREATE TABLE user_id (internal_id text PRIMARY KEY, state text)`);
    await privacy.pool.query(`CREATE TABLE agents (id integer PRIMARY KEY, category text)`);
    await privacy.pool.query(`INSERT INTO agents (id, category) VALUES (10, 'business')`);
  });

  beforeEach(async () => {
    await privacy.pool.query('TRUNCATE ai_profiles_consolidated, user_id');
  });

  afterAll(async () => {
    if (privacy) await privacy.close();
  });

  async function seed(state: 'active' | 'deleted'): Promise<void> {
    await privacy.pool.query(`INSERT INTO user_id (internal_id, state) VALUES ($1, $2)`, [USER, state]);
    // Оболочка профиля после удаления — profile_data '{}'; у живого — тот же
    // пустой профиль, чтобы различалось только состояние аккаунта.
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, '{}'::jsonb)`,
      [USER],
    );
  }

  async function profileData(): Promise<any> {
    return (await privacy.pool.query(
      `SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1`,
      [USER],
    )).rows[0].profile_data;
  }

  function makeService(reply = '{"fields":{"what":"синтетическая пекарня","legal_form":"ip"}}') {
    const cli = { text: jest.fn(async () => reply) };
    return { svc: new BusinessProfileService(privacy.pg as any, cli as any), cli };
  }

  it('удалённый аккаунт: merge не пишет business в оболочку профиля', async () => {
    await seed('deleted');
    const { svc } = makeService();
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.merge(USER, { what: 'синтетическая пекарня' }, 'assistant');

    expect(await profileData()).toEqual({});
  });

  it('удалённый аккаунт: извлечение из хода не воскрешает карточку', async () => {
    await seed('deleted');
    const { svc, cli } = makeService();
    jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await svc.extractFromTurn(USER, '10', 'у меня своя пекарня, оформлен как ИП', 'понял');

    expect(cli.text).toHaveBeenCalledTimes(1);
    expect(await profileData()).toEqual({});
  });

  it('активный аккаунт: извлечение из хода пишет карточку как раньше', async () => {
    await seed('active');
    const { svc } = makeService();

    await svc.extractFromTurn(USER, '10', 'у меня своя пекарня, оформлен как ИП', 'понял');

    const data = await profileData();
    expect(data.business.what).toMatchObject({ value: 'синтетическая пекарня', source: 'assistant' });
    expect(data.business.legal_form).toMatchObject({ value: 'ip', source: 'assistant' });
  });

  it('активный аккаунт: ручная правка пользователя сохраняется', async () => {
    await seed('active');
    const { svc } = makeService();

    const saved = await svc.merge(USER, { team: 'двое' }, 'user');

    expect(saved.team).toMatchObject({ value: 'двое', source: 'user' });
    expect((await profileData()).business.team).toMatchObject({ value: 'двое', source: 'user' });
  });
});
