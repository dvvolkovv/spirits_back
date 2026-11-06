import { BusinessProfileService } from './business-profile.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';
import { shouldSkipBusinessExtraction } from './extract-prefilter';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

jest.mock('./extract-prefilter', () => ({
  shouldSkipBusinessExtraction: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;
const shouldSkipBusinessExtractionMock = shouldSkipBusinessExtraction as jest.MockedFunction<
  typeof shouldSkipBusinessExtraction
>;

function makeService(opts: { claudeReply?: string; profile?: any } = {}) {
  const state: any = { business: opts.profile || {} };
  const pg = {
    query: jest.fn(async (sql: string, params: any[]): Promise<any> => {
      if (/FROM agents/i.test(sql)) {
        return { rows: [{ category: 'business' }] };
      }
      if (/SELECT profile_data FROM ai_profiles_consolidated/i.test(sql)) {
        return { rows: [{ profile_data: { business: state.business } }] };
      }
      if (/UPDATE ai_profiles_consolidated/i.test(sql)) {
        state.business = JSON.parse(params[0]);
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  } as any;
  const cli = {
    text: jest.fn(async () => opts.claudeReply ?? '{"fields":{}}'),
  } as any;

  return { svc: new BusinessProfileService(pg, cli), pg, cli, state };
}

describe('BusinessProfileService automatic profiling privacy gates', () => {
  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
    shouldSkipBusinessExtractionMock.mockReset().mockReturnValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('stops disabled extraction before prefilter, database reads, and Claude', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, pg, cli } = makeService({ claudeReply: '{"fields":{"legal_form":"ip"}}' });

    await svc.extractFromTurn('u', '10', 'I run a business', 'Tell me more');

    expect(shouldSkipBusinessExtractionMock).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
    expect(cli.text).not.toHaveBeenCalled();
  });

  it('discards extraction when consent is revoked after Claude responds', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, pg, cli, state } = makeService({
      claudeReply: '{"fields":{"legal_form":"ip"}}',
    });
    const merge = jest.spyOn(svc, 'merge');

    await svc.extractFromTurn('u', '10', 'I run an IP business', 'Understood');

    expect(cli.text).toHaveBeenCalledTimes(1);
    expect(automaticProfilingAllowedMock).toHaveBeenCalledTimes(2);
    expect(merge).not.toHaveBeenCalled();
    expect(pg.query.mock.calls.filter(([sql]: [string]) => /UPDATE ai_profiles_consolidated/i.test(sql))).toHaveLength(0);
    expect(state.business).toEqual({});
  });

  it('returns an empty prompt before reading business data when disabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, pg } = makeService({
      profile: { what: { value: 'Private studio', source: 'user', updated_at: 'x' } },
    });

    await expect(svc.renderForPrompt('u', 'business')).resolves.toBe('');
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('suppresses business data when consent is revoked during the profile read', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, pg } = makeService({
      profile: { what: { value: 'Private studio', source: 'user', updated_at: 'x' } },
    });

    await expect(svc.renderForPrompt('u', 'business')).resolves.toBe('');
    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(automaticProfilingAllowedMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed on a PostgreSQL privacy lookup error', async () => {
    const actual = jest.requireActual('../privacy/profile-privacy') as typeof import('../privacy/profile-privacy');
    automaticProfilingAllowedMock.mockImplementation(actual.automaticProfilingAllowed);
    const { svc, pg, cli } = makeService({ claudeReply: '{"fields":{"legal_form":"ip"}}' });
    pg.query.mockRejectedValue(new Error('PostgreSQL unavailable'));

    await expect(svc.extractFromTurn('u', '10', 'I run a business', 'Understood')).resolves.toBeUndefined();

    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toContain('profile_data');
    expect(shouldSkipBusinessExtractionMock).not.toHaveBeenCalled();
    expect(cli.text).not.toHaveBeenCalled();
  });

  it('allows an explicit user merge without consulting the privacy policy', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, state } = makeService();

    const result = await svc.merge('u', { legal_form: 'ip' }, 'user');

    expect(result.legal_form?.value).toBe('ip');
    expect(result.legal_form?.source).toBe('user');
    expect(state.business.legal_form.value).toBe('ip');
    expect(automaticProfilingAllowedMock).not.toHaveBeenCalled();
  });
});
