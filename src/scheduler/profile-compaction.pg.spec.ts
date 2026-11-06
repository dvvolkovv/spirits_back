import { ProfileCompactionService } from './profile-compaction.service';
import { createPrivacyPg, describePg } from '../privacy/profile-privacy.pg-helper';

describePg('ProfileCompactionService nightly privacy prefilter against PostgreSQL', () => {
  let privacy: Awaited<ReturnType<typeof createPrivacyPg>>;

  beforeAll(async () => {
    privacy = await createPrivacyPg();
    await privacy.pool.query(`
      CREATE TABLE custom_chat_history (
        id serial PRIMARY KEY,
        session_id text NOT NULL,
        sender_type text NOT NULL,
        content text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  beforeEach(async () => {
    await privacy.pool.query('TRUNCATE custom_chat_history, ai_profiles_consolidated');
  });

  afterAll(async () => {
    if (privacy) await privacy.close();
  });

  it('selects only boolean true and missing automaticProfiling values', async () => {
    const profiles: Array<[string, unknown]> = [
      ['allowed-true', { automaticProfiling: true }],
      ['allowed-missing', { unrelated: 'kept' }],
      ['disabled-false', { automaticProfiling: false }],
      ['disabled-string', { automaticProfiling: 'true' }],
      ['disabled-json-null', { automaticProfiling: null }],
      ['disabled-object', { automaticProfiling: { value: true } }],
    ];
    for (const [userId, profileData] of profiles) {
      await privacy.pool.query(
        'INSERT INTO ai_profiles_consolidated (user_id, profile_data) VALUES ($1, $2::jsonb)',
        [userId, JSON.stringify(profileData)],
      );
      await privacy.pool.query(
        `INSERT INTO custom_chat_history (session_id, sender_type, content, created_at)
         VALUES ($1, 'human', 'recent private message', now() - interval '1 hour')`,
        [`${userId}_12`],
      );
    }

    const svc = new ProfileCompactionService(privacy.pg as any, {} as any);
    const compactUser = jest.spyOn(svc, 'compactUser').mockResolvedValue({ recorded: true });

    await svc.runDailyCompaction();

    expect(compactUser.mock.calls.map(([userId]) => userId).sort()).toEqual([
      'allowed-missing',
      'allowed-true',
    ]);
  });
});
