jest.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: jest.fn() }));
jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
  readProfileAccess: jest.fn(),
  filterSearchCandidateIds: jest.fn(),
  listSearchCandidateIds: jest.fn(),
}));

import { MiscService } from './misc.service';
import { automaticProfilingAllowed, readProfileAccess } from '../privacy/profile-privacy';

const accessMock = jest.mocked(readProfileAccess);
const profilingMock = jest.mocked(automaticProfilingAllowed);
const pairFixture = { overallScore: 1, perCategory: {} };
const noData = 'Не удалось сравнить профили — нет данных с персональными описаниями (gloss/embedding).';
const noTargets = 'Не указаны пользователи для анализа.';
const streamItem = (content: string) => JSON.stringify({ type: 'item', content }) + '\n';
const allowedAccess = {
  exists: true,
  visible: true,
  automaticProfiling: true,
  approvedContact: false,
  peer: false,
};

function response() {
  return {
    statusCode: 200,
    body: null as any,
    writes: [] as string[],
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
    json(body: any) { this.body = body; return this; },
    write(chunk: string) { this.writes.push(chunk); return true; },
    end() { return this; },
  } as any;
}

let service: any;
let comparePairByEmbeddings: jest.Mock;
let streamLLM: jest.Mock;
let pg: { query: jest.Mock };

beforeEach(() => {
  accessMock.mockReset();
  profilingMock.mockReset().mockResolvedValue(true);
  pg = { query: jest.fn(async () => ({ rows: [] })) };
  service = new MiscService(
    {} as any,
    pg as any,
    {} as any,
    { resolveUserLanguage: jest.fn(async () => 'ru') } as any,
  );
  comparePairByEmbeddings = jest.fn().mockResolvedValue(pairFixture);
  streamLLM = jest.fn(async (_systemPrompt: string, _userMessage: string, res: any) => {
    res.write(JSON.stringify({ type: 'item', content: 'PRIVATE' }) + '\n');
  });
  service.comparePairByEmbeddings = comparePairByEmbeddings;
  service.streamLLM = streamLLM;
});

describe('MiscService.analyzeCompatibility privacy', () => {
  it.each([
    ['missing', { ...allowedAccess, exists: false, visible: false }],
    ['hidden', { ...allowedAccess, visible: false }],
  ])('returns 404 for %s targets before streaming or graph reads', async (_label, access) => {
    accessMock.mockResolvedValue(access);
    const res = response();

    await service.analyzeCompatibility('requester', ['target'], res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
    expect(res.headers).toEqual({});
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
  });

  it('returns 422 if target disabled profiling', async () => {
    accessMock.mockResolvedValue({ ...allowedAccess, automaticProfiling: false });
    const res = response();

    await service.analyzeCompatibility('requester', ['target'], res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ code: 'PROFILE_DATA_UNAVAILABLE' });
    expect(res.headers).toEqual({});
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
  });

  it('returns 422 if requester disabled profiling', async () => {
    accessMock.mockResolvedValue(allowedAccess);
    profilingMock.mockResolvedValue(false);
    const res = response();

    await service.analyzeCompatibility('requester', ['target'], res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ code: 'PROFILE_DATA_UNAVAILABLE' });
    expect(res.headers).toEqual({});
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
  });

  it('does not call LLM if access is revoked during graph comparison', async () => {
    accessMock
      .mockResolvedValueOnce(allowedAccess)
      .mockResolvedValueOnce({ ...allowedAccess, visible: false });
    const res = response();

    await service.analyzeCompatibility('requester', ['target'], res);

    expect(comparePairByEmbeddings).toHaveBeenCalledWith('requester', 'target');
    expect(streamLLM).not.toHaveBeenCalled();
    expect(res.writes.join('')).not.toContain('PRIVATE');
  });

  it('rechecks every target after graph comparisons when a later target revokes access', async () => {
    accessMock
      .mockResolvedValueOnce(allowedAccess)
      .mockResolvedValueOnce(allowedAccess)
      .mockResolvedValueOnce(allowedAccess)
      .mockResolvedValueOnce({ ...allowedAccess, visible: false });
    const res = response();

    await service.analyzeCompatibility('requester', ['target1', 'target2'], res);

    expect(accessMock.mock.calls).toEqual([
      [pg, 'requester', 'target1'],
      [pg, 'requester', 'target2'],
      [pg, 'requester', 'target1'],
      [pg, 'requester', 'target2'],
    ]);
    expect(comparePairByEmbeddings.mock.calls).toEqual([
      ['requester', 'target1'],
      ['requester', 'target2'],
    ]);
    expect(profilingMock).toHaveBeenCalledTimes(3);
    expect(streamLLM).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.writes).toEqual([streamItem(noData)]);
    expect(res.writes.join('')).not.toContain('PRIVATE');
    expect(res.writes.join('')).not.toContain('target1');
    expect(res.writes.join('')).not.toContain('target2');
  });

  it('skips access checks and self comparison, then returns noData without streaming', async () => {
    const res = response();

    await service.analyzeCompatibility('requester', ['requester'], res);

    expect(accessMock).not.toHaveBeenCalled();
    expect(profilingMock).not.toHaveBeenCalled();
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
    expect(res.writes).toEqual([streamItem(noData)]);
  });

  it('keeps the noTargets stream response without access, graph, or LLM calls', async () => {
    const res = response();

    await service.analyzeCompatibility('requester', [], res);

    expect(accessMock).not.toHaveBeenCalled();
    expect(profilingMock).not.toHaveBeenCalled();
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers).toEqual({
      'Content-Type': 'text/plain; charset=utf-8',
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    expect(res.writes).toEqual([streamItem(noTargets)]);
  });

  it('maps an unresolved surrogate ID to the same 404', async () => {
    const res = response();

    await service.analyzeCompatibility('requester', ['7'], res);

    expect(pg.query).toHaveBeenCalledWith(
      'SELECT user_id FROM ai_profiles_consolidated WHERE id = $1',
      [7],
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
    expect(res.headers).toEqual({});
    expect(accessMock).not.toHaveBeenCalled();
    expect(comparePairByEmbeddings).not.toHaveBeenCalled();
    expect(streamLLM).not.toHaveBeenCalled();
  });

  it('keeps the existing stream path for an allowed profile', async () => {
    accessMock.mockResolvedValue(allowedAccess);
    const res = response();

    await service.analyzeCompatibility('requester', ['target'], res);

    expect(accessMock).toHaveBeenCalledWith(pg, 'requester', 'target');
    expect(profilingMock).toHaveBeenCalledWith(pg, 'requester');
    expect(comparePairByEmbeddings).toHaveBeenCalledWith('requester', 'target');
    expect(streamLLM).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(200);
    expect(res.writes.join('')).toContain('PRIVATE');
  });
});
