import axios from 'axios';
import { Neo4jService } from './neo4j.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;

describe('Neo4jService automatic profiling privacy gates', () => {
  const savedOpenAIKey = process.env.OPENAI_API_KEY;
  const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;

  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
  });

  afterEach(() => {
    if (savedOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAIKey;
    if (savedOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedOpenRouterKey;
    jest.restoreAllMocks();
  });

  function makeService(cliAnswer: string | null = '{}') {
    const pg = {
      query: jest.fn(async (_sql: string, _params?: any[]): Promise<any> => ({
        rows: [{ content: 'PREV' }],
      })),
    };
    const cli = {
      text: jest.fn(async (_prompt: string, _opts?: any): Promise<string | null> => cliAnswer),
    };
    const run = jest.fn(async (_cypher: string, _params?: any): Promise<any> => ({ records: [] }));
    const session = { run, close: jest.fn(async () => undefined) };
    const getSession = jest.fn(() => session);
    const svc = new Neo4jService(pg as any, cli as any);
    (svc as any).driver = {};
    (svc as any).getSession = getSession;
    return { svc, pg, cli, run, session, getSession };
  }

  it('stops disabled collection before history, LLM, and graph access', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, pg, cli, run, getSession } = makeService('{"interests":["chess"]}');

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT');

    expect(pg.query).not.toHaveBeenCalled();
    expect(cli.text).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('discards extracted values when consent is revoked after the LLM response', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, cli, run } = makeService('{"interests":["chess"]}');

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT', '');

    expect(cli.text).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps completed entity writes but stops the next write group after revocation', async () => {
    automaticProfilingAllowedMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { svc, run } = makeService('{"interests":["chess"],"values":["honesty"]}');

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT', '');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('Interest');
    expect(run.mock.calls[0][0]).not.toContain('consolidation_count');
  });

  it('does not update consolidation_count when consent is revoked during its read', async () => {
    automaticProfilingAllowedMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { svc, run } = makeService('{}');

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT', '');

    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toContain('RETURN p.consolidation_count');
  });

  it('does not start an embedding update when consent is revoked after the count write', async () => {
    automaticProfilingAllowedMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const { svc, run } = makeService('{}');
    const embedding = jest.spyOn(svc, 'updateProfileEmbedding').mockResolvedValue();

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT', '');

    expect(run).toHaveBeenCalledTimes(2);
    expect(embedding).not.toHaveBeenCalled();
  });

  it('returns an empty prompt description before opening a session when disabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, run, getSession } = makeService();

    await expect(svc.getProfileDescription('u')).resolves.toBe('');
    expect(getSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('suppresses a graph description when consent is revoked after the read', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, run } = makeService();
    const values: Record<string, any> = {
      name: 'Alice',
      family_name: 'Private',
      interests: [{ name: 'secret interest', confidence: 5 }],
      desires: [],
      beliefs: [],
      intents: [],
      values: [],
      skills: [],
    };
    run.mockResolvedValue({ records: [{ get: (key: string) => values[key] }] });

    await expect(svc.getProfileDescription('u')).resolves.toBe('');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('checks embedding collection independently before description or OpenAI access', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
    const { svc, run, getSession } = makeService();
    const description = jest.spyOn(svc, 'getProfileDescription').mockResolvedValue('A sufficiently long profile description');

    await svc.updateProfileEmbedding('u');

    expect(description).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('discards an OpenAI embedding when consent is revoked after its response', async () => {
    process.env.OPENAI_API_KEY = 'test-openai-key';
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const post = jest.spyOn(axios, 'post').mockResolvedValue({
      data: { data: [{ embedding: [0.1, 0.2, 0.3] }] },
    });
    const { svc, run } = makeService();
    jest.spyOn(svc, 'getProfileDescription').mockResolvedValue('A sufficiently long profile description');

    await svc.updateProfileEmbedding('u');

    expect(post).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
  });

  it('fails closed on a PostgreSQL privacy lookup error', async () => {
    const actual = jest.requireActual('../privacy/profile-privacy') as typeof import('../privacy/profile-privacy');
    automaticProfilingAllowedMock.mockImplementation(actual.automaticProfilingAllowed);
    const { svc, pg, cli, run, getSession } = makeService('{"interests":["chess"]}');
    pg.query.mockRejectedValue(new Error('PostgreSQL unavailable'));

    await svc.consolidateFromChat('u', 'a', 'USER', 'ASSISTANT');

    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(pg.query.mock.calls[0][0]).toContain('profile_data');
    expect(cli.text).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
