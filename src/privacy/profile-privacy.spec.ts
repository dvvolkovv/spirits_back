import { sanitizeProfilePatch } from '../profile/profile-patch';
import {
  PrivacyProfileNotFoundError,
  PrivacySettingsDataError,
  assertPrivacySettingsPatch,
  automaticProfilingAllowed,
  canReceiveNewProposal,
  getPrivacySettings,
  parsePrivacySettings,
  updatePrivacySettings,
} from './profile-privacy';

const DEFAULTS = { automaticProfiling: true, discoverable: true };

describe('parsePrivacySettings', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty object', {}],
  ])('defaults %s to true for both settings', (_label, input) => {
    expect(parsePrivacySettings(input)).toEqual(DEFAULTS);
  });

  it('defaults each missing key independently', () => {
    expect(parsePrivacySettings({ automaticProfiling: false })).toEqual({
      automaticProfiling: false,
      discoverable: true,
    });
    expect(parsePrivacySettings({ discoverable: false })).toEqual({
      automaticProfiling: true,
      discoverable: false,
    });
  });

  it('preserves explicit false values', () => {
    expect(parsePrivacySettings({ automaticProfiling: false, discoverable: false })).toEqual({
      automaticProfiling: false,
      discoverable: false,
    });
  });

  it.each([
    [{ automaticProfiling: 'false' }],
    [{ automaticProfiling: null }],
    [{ discoverable: 0 }],
    [{ discoverable: 'yes' }],
  ])('rejects a non-boolean stored value: %j', (input) => {
    expect(() => parsePrivacySettings(input)).toThrow(PrivacySettingsDataError);
  });

  it.each([false, 1, 'profile', [], [{ automaticProfiling: false }]])(
    'rejects a non-object or array stored profile: %j',
    (input) => {
      expect(() => parsePrivacySettings(input)).toThrow(PrivacySettingsDataError);
    },
  );
});

describe('assertPrivacySettingsPatch', () => {
  it.each([
    [{ automaticProfiling: true }],
    [{ automaticProfiling: false }],
    [{ discoverable: true }],
    [{ discoverable: false }],
    [{ automaticProfiling: false, discoverable: true }],
    [{ discoverable: false, automaticProfiling: true }],
  ])('accepts one or two boolean settings: %j', (patch) => {
    expect(() => assertPrivacySettingsPatch(patch)).not.toThrow();
  });

  it.each([
    {},
    { unknown: true },
    { automaticProfiling: false, unknown: true },
    { automaticProfiling: 'false' },
    { discoverable: null },
    null,
    undefined,
    [],
    [true],
    false,
    'automaticProfiling=false',
  ])('rejects an empty, unknown, or non-boolean patch: %j', (patch) => {
    expect(() => assertPrivacySettingsPatch(patch)).toThrow();
  });
});

describe('privacy storage helpers', () => {
  it('throws a dedicated error when the own profile is missing', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };

    await expect(getPrivacySettings(pg as any, 'absent')).rejects.toBeInstanceOf(
      PrivacyProfileNotFoundError,
    );
    await expect(updatePrivacySettings(pg as any, 'absent', { automaticProfiling: false })).rejects.toBeInstanceOf(
      PrivacyProfileNotFoundError,
    );
  });

  it('updates both fields with one SQL statement and boolean parameters', async () => {
    const pg = {
      query: jest.fn(async () => ({
        rows: [{ profile_data: { automaticProfiling: false, discoverable: true } }],
      })),
    };

    await expect(updatePrivacySettings(pg as any, 'u1', {
      discoverable: true,
      automaticProfiling: false,
    })).resolves.toEqual({ automaticProfiling: false, discoverable: true });

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain('UPDATE ai_profiles_consolidated');
    expect(sql.match(/jsonb_set\(/g)).toHaveLength(2);
    expect(params).toEqual(['u1', false, true]);
  });

  it('rejects an invalid update before touching storage', async () => {
    const pg = { query: jest.fn() };

    await expect(updatePrivacySettings(pg as any, 'u1', {})).rejects.toThrow();
    expect(pg.query).not.toHaveBeenCalled();
  });
});

describe('fail-closed privacy wrappers', () => {
  it('return the stored values when storage is healthy', async () => {
    const pg = {
      query: jest.fn(async () => ({
        rows: [{ profile_data: { automaticProfiling: true, discoverable: false } }],
      })),
    };

    await expect(automaticProfilingAllowed(pg as any, 'u1')).resolves.toBe(true);
    await expect(canReceiveNewProposal(pg as any, 'u1')).resolves.toBe(false);
  });

  it('return false on infrastructure errors', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('database unavailable'); }) };

    await expect(automaticProfilingAllowed(pg as any, 'u1')).resolves.toBe(false);
    await expect(canReceiveNewProposal(pg as any, 'u1')).resolves.toBe(false);
  });

  it('return false for a missing profile', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };

    await expect(automaticProfilingAllowed(pg as any, 'u1')).resolves.toBe(false);
    await expect(canReceiveNewProposal(pg as any, 'u1')).resolves.toBe(false);
  });

  it('return false for malformed stored data', async () => {
    const pg = {
      query: jest.fn(async () => ({
        rows: [{ profile_data: { automaticProfiling: 'yes', discoverable: true } }],
      })),
    };

    await expect(automaticProfilingAllowed(pg as any, 'u1')).resolves.toBe(false);
    await expect(canReceiveNewProposal(pg as any, 'u1')).resolves.toBe(false);
  });
});

describe('generic profile-update isolation', () => {
  it('continues dropping both dedicated privacy keys', () => {
    const result = sanitizeProfilePatch({
      name: 'Анна',
      automaticProfiling: false,
      discoverable: false,
    });

    expect(result.patch).toEqual({ name: 'Анна' });
    expect(result.dropped).toEqual(['automaticProfiling', 'discoverable']);
  });
});
