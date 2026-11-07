import {
  PrivacySettingsDataError,
  canUseProfileForRequester,
  canViewProfile,
  filterSearchCandidateIds,
  listSearchCandidateIds,
  readProfileAccess,
} from './profile-privacy';
import { createPrivacyPg, describePg } from './profile-privacy.pg-helper';

describePg('profile access and search candidates against an isolated PostgreSQL schema', () => {
  jest.setTimeout(20_000);

  let privacy: Awaited<ReturnType<typeof createPrivacyPg>>;

  beforeAll(async () => {
    privacy = await createPrivacyPg();
    await privacy.pool.query(`
      CREATE TABLE contact_requests (
        id serial PRIMARY KEY,
        requester_id integer NOT NULL,
        target_id integer NOT NULL,
        status varchar NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE peer_conversations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_a_id text NOT NULL,
        user_b_id text NOT NULL
      );
      CREATE TABLE user_blocks (
        blocker_id text NOT NULL,
        blocked_id text NOT NULL,
        PRIMARY KEY (blocker_id, blocked_id)
      )
    `);
  });

  beforeEach(async () => {
    await privacy.pool.query(`
      TRUNCATE user_blocks, peer_conversations, contact_requests, ai_profiles_consolidated
      RESTART IDENTITY;
      INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
      VALUES
        (1, 'u1', '{}'::jsonb),
        (2, 'u2', '{"discoverable":false}'::jsonb),
        (3, 'u3', NULL),
        (4, 'u4', '{"automaticProfiling":false}'::jsonb)
    `);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    if (privacy) await privacy.close();
  });

  it('keeps a paused self profile visible and usable by its owner', async () => {
    await expect(readProfileAccess(privacy.pg as any, 'u4', 'u4')).resolves.toEqual({
      exists: true,
      visible: true,
      automaticProfiling: false,
      approvedContact: false,
      peer: false,
    });
    await expect(canViewProfile(privacy.pg as any, 'u4', 'u4')).resolves.toBe(true);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u4', 'u4')).resolves.toBe(true);
  });

  it('hides a non-discoverable target from an unrelated requester', async () => {
    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u2')).resolves.toEqual({
      exists: true,
      visible: false,
      automaticProfiling: true,
      approvedContact: false,
      peer: false,
    });
    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
  });

  it('grants access through an approved contact in both directions', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{"discoverable":false}'::jsonb
       WHERE user_id = 'u1';
       INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES (1, 2, 'approved')`,
    );

    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(true);
    await expect(canViewProfile(privacy.pg as any, 'u2', 'u1')).resolves.toBe(true);
    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u2')).resolves.toMatchObject({
      approvedContact: true,
      peer: false,
    });
  });

  it('grants access through a peer conversation in both directions', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{"discoverable":false}'::jsonb
       WHERE user_id = 'u1';
       INSERT INTO peer_conversations (user_a_id, user_b_id) VALUES ('u1', 'u2')`,
    );

    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(true);
    await expect(canViewProfile(privacy.pg as any, 'u2', 'u1')).resolves.toBe(true);
    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u2')).resolves.toMatchObject({
      approvedContact: false,
      peer: true,
    });
  });

  it.each([
    ['requester blocks target', 'u1', 'u2'],
    ['target blocks requester', 'u2', 'u1'],
  ])('%s and revokes both approved-contact and peer access', async (_name, blocker, blocked) => {
    await privacy.pool.query(
      `INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES (1, 2, 'approved');
       INSERT INTO peer_conversations (user_a_id, user_b_id) VALUES ('u1', 'u2')`,
    );
    await privacy.pool.query(
      'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)',
      [blocker, blocked],
    );

    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u2')).resolves.toEqual({
      exists: true,
      visible: false,
      automaticProfiling: true,
      approvedContact: true,
      peer: true,
    });
    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
    await expect(canViewProfile(privacy.pg as any, 'u2', 'u1')).resolves.toBe(false);
  });

  it('leaves a paused target directly visible but unusable by another requester', async () => {
    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u4')).resolves.toEqual({
      exists: true,
      visible: true,
      automaticProfiling: false,
      approvedContact: false,
      peer: false,
    });
    await expect(canViewProfile(privacy.pg as any, 'u1', 'u4')).resolves.toBe(true);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u1', 'u4')).resolves.toBe(false);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u4', 'u4')).resolves.toBe(true);
  });

  it('returns false access for a missing target', async () => {
    await expect(readProfileAccess(privacy.pg as any, 'u1', 'missing')).resolves.toEqual({
      exists: false,
      visible: false,
      automaticProfiling: false,
      approvedContact: false,
      peer: false,
    });
    await expect(canViewProfile(privacy.pg as any, 'u1', 'missing')).resolves.toBe(false);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u1', 'missing')).resolves.toBe(false);
  });

  it('reads coherent batch access including hidden and paused counterparties', async () => {
    const readBatch = (require('./profile-privacy') as any).readProfileAccessBatch;

    const result = await readBatch(privacy.pg as any, 'u1', ['u2', 'u3', 'u4', 'missing']);

    expect(result.get('u2')).toEqual({
      exists: true,
      visible: false,
      automaticProfiling: true,
      approvedContact: false,
      peer: false,
    });
    expect(result.get('u3')).toMatchObject({ visible: true, automaticProfiling: true });
    expect(result.get('u4')).toMatchObject({ visible: true, automaticProfiling: false });
    expect(result.has('missing')).toBe(false);
  });

  it('does not grant access through a pending contact request', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{"discoverable":false}'::jsonb
       WHERE user_id = 'u1';
       INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES (1, 2, 'pending')`,
    );

    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
    await expect(canViewProfile(privacy.pg as any, 'u2', 'u1')).resolves.toBe(false);
  });

  it('allows a requester without a stored profile to view an open target', async () => {
    await expect(canViewProfile(privacy.pg as any, 'absent-requester', 'u3')).resolves.toBe(true);
  });

  it('fails closed for malformed single-target privacy settings', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{"discoverable":"yes"}'::jsonb
       WHERE user_id = 'u2'`,
    );

    await expect(readProfileAccess(privacy.pg as any, 'u1', 'u2')).rejects.toBeInstanceOf(
      PrivacySettingsDataError,
    );
    await expect(canViewProfile(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u1', 'u2')).resolves.toBe(false);
  });

  it('fails closed for single-target access when PostgreSQL fails', async () => {
    const broken = { query: jest.fn().mockRejectedValue(new Error('postgres unavailable')) };

    await expect(canViewProfile(broken as any, 'u1', 'u3')).resolves.toBe(false);
    await expect(canUseProfileForRequester(broken as any, 'u1', 'u3')).resolves.toBe(false);
  });

  it('lists only eligible unpaused candidates and excludes self, blocks and pending requests', async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
       VALUES
         (5, 'u5', '{"discoverable":false}'::jsonb),
         (6, 'u6', '{}'::jsonb),
         (7, 'u7', '{"discoverable":false}'::jsonb),
         (8, 'u8', '{}'::jsonb);
       INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES
         (1, 2, 'approved'),
         (1, 4, 'approved'),
         (1, 7, 'pending');
       INSERT INTO peer_conversations (user_a_id, user_b_id) VALUES ('u1', 'u5');
       INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('u6', 'u1')`,
    );

    const result = await listSearchCandidateIds(privacy.pg as any, 'u1');
    expect([...result].sort()).toEqual(['u2', 'u3', 'u5', 'u8']);
  });

  it('filters only the supplied eligible candidate subset', async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
       VALUES
         (5, 'u5', '{}'::jsonb),
         (6, 'u6', '{"discoverable":false}'::jsonb),
         (7, 'u7', '{}'::jsonb);
       INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES (2, 1, 'approved'), (1, 6, 'pending');
       INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ('u1', 'u5')`,
    );

    const result = await filterSearchCandidateIds(
      privacy.pg as any,
      'u1',
      ['u2', 'u3', 'u4', 'u5', 'u6'],
    );
    expect([...result].sort()).toEqual(['u2', 'u3']);
  });

  it('returns an empty filtered set without issuing SQL for empty input', async () => {
    const query = jest.spyOn(privacy.pg, 'query');

    await expect(filterSearchCandidateIds(privacy.pg as any, 'u1', [])).resolves.toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
  });

  it('skips malformed candidate settings while retaining valid candidates', async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
       VALUES (5, 'u5', '{"automaticProfiling":"false"}'::jsonb)`,
    );

    const listed = await listSearchCandidateIds(privacy.pg as any, 'u1');
    expect([...listed].sort()).toEqual(['u3']);
    const filtered = await filterSearchCandidateIds(privacy.pg as any, 'u1', ['u3', 'u5']);
    expect([...filtered].sort()).toEqual(['u3']);
  });

  it('keeps self access visible and usable when both stored privacy values are malformed', async () => {
    await privacy.pool.query(
      `UPDATE ai_profiles_consolidated
       SET profile_data = '{"automaticProfiling":"false","discoverable":42}'::jsonb
       WHERE user_id = 'u4'`,
    );

    await expect(readProfileAccess(privacy.pg as any, 'u4', 'u4')).resolves.toEqual({
      exists: true,
      visible: true,
      automaticProfiling: false,
      approvedContact: false,
      peer: false,
    });
    await expect(canViewProfile(privacy.pg as any, 'u4', 'u4')).resolves.toBe(true);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u4', 'u4')).resolves.toBe(true);
    await expect(canViewProfile(privacy.pg as any, 'u1', 'u4')).resolves.toBe(false);
    await expect(canUseProfileForRequester(privacy.pg as any, 'u1', 'u4')).resolves.toBe(false);
  });

  it('materializes relationship pairs instead of correlating contact EXISTS per candidate', async () => {
    const query = jest.spyOn(privacy.pg, 'query');

    await listSearchCandidateIds(privacy.pg as any, 'u1');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('approved_contact_pairs AS MATERIALIZED');
    expect(sql).toContain('peer_pairs AS MATERIALIZED');
    expect(sql).toContain('block_pairs AS MATERIALIZED');
    expect(sql).toContain('LEFT JOIN approved_contact_pairs');
    expect(sql).toContain('LEFT JOIN peer_pairs');
    expect(sql).toContain('LEFT JOIN block_pairs');
    expect(sql).not.toContain('EXISTS');
  });

  it('projects only privacy JSONB values and types instead of whole profile_data', async () => {
    const query = jest.spyOn(privacy.pg, 'query');

    await listSearchCandidateIds(privacy.pg as any, 'u1');

    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain("p.profile_data -> 'automaticProfiling'");
    expect(sql).toContain("p.profile_data -> 'discoverable'");
    expect(sql).toContain("jsonb_typeof(p.profile_data -> 'automaticProfiling')");
    expect(sql).toContain("jsonb_typeof(p.profile_data -> 'discoverable')");
    expect(sql).not.toContain('p.profile_data,');
  });

  it('preserves incoming and outgoing contact and peer relationships in batch search', async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
       VALUES
         (5, 'u5', '{"discoverable":false}'::jsonb),
         (6, 'u6', '{"discoverable":false}'::jsonb),
         (7, 'u7', '{"discoverable":false}'::jsonb),
         (8, 'u8', '{"discoverable":false}'::jsonb);
       INSERT INTO contact_requests (requester_id, target_id, status)
       VALUES (1, 5, 'approved'), (6, 1, 'approved');
       INSERT INTO peer_conversations (user_a_id, user_b_id)
       VALUES ('u1', 'u7'), ('u8', 'u1')`,
    );

    const result = await listSearchCandidateIds(privacy.pg as any, 'u1');
    expect([...result].sort()).toEqual(['u3', 'u5', 'u6', 'u7', 'u8']);
  });

  it('defaults missing privacy keys without fetching unrelated business JSON', async () => {
    await privacy.pool.query(
      `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
       VALUES (5, 'u5', '{"privateBusiness":"do not select"}'::jsonb)`,
    );

    const result = await listSearchCandidateIds(privacy.pg as any, 'u1');
    expect([...result].sort()).toEqual(['u3', 'u5']);
  });

  it.each(['automaticProfiling', 'discoverable'])(
    'excludes an explicit JSONB null %s while retaining valid candidates',
    async (key) => {
      await privacy.pool.query(
        `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
         VALUES (5, 'u5', $1::jsonb)`,
        [JSON.stringify({ [key]: null })],
      );

      const listed = await listSearchCandidateIds(privacy.pg as any, 'u1');
      expect([...listed].sort()).toEqual(['u3']);
      const filtered = await filterSearchCandidateIds(privacy.pg as any, 'u1', ['u3', 'u5']);
      expect([...filtered].sort()).toEqual(['u3']);
    },
  );

  it.each(['"not-an-object"', '[]'])(
    'excludes non-object profile_data %s while retaining valid candidates',
    async (profileData) => {
      await privacy.pool.query(
        `INSERT INTO ai_profiles_consolidated (id, user_id, profile_data)
         VALUES (5, 'u5', $1::jsonb)`,
        [profileData],
      );

      const result = await listSearchCandidateIds(privacy.pg as any, 'u1');
      expect([...result].sort()).toEqual(['u3']);
    },
  );

  it('propagates PostgreSQL failures from both candidate queries', async () => {
    const failure = new Error('postgres unavailable');
    const broken = { query: jest.fn().mockRejectedValue(failure) };

    await expect(listSearchCandidateIds(broken as any, 'u1')).rejects.toBe(failure);
    await expect(filterSearchCandidateIds(broken as any, 'u1', ['u3'])).rejects.toBe(failure);
    expect(broken.query).toHaveBeenCalledTimes(2);
  });
});
