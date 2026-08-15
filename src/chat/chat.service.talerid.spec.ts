import { ChatService } from './chat.service';

/**
 * Task 1 (agent-direct): the TalerID fields handed to the file-agent. We test the
 * pure decision — connected → {token, mcpUrl}; not connected / no service / mint
 * error → null — without spinning up the whole streamUniversalAgent path. Only
 * `talerIdOauth` and `logger` are touched, so the other constructor deps are nulls.
 */
function makeService(oauth: any): ChatService {
  // Positional args mirror the constructor; only the last (talerIdOauth) matters here.
  return new ChatService(
    null as any, // pg
    null as any, // neo4j
    null as any, // kling
    null as any, // tools
    null as any, // smmProducerTools
    null as any, // claudeAgent
    null as any, // claudeCli
    null as any, // language — добавлен в конструктор позже, из-за чего все
                 // последующие аргументы съезжали и oauth попадал в слот events
    undefined,   // balanceCtx — тоже добавлен позже; taleridAgentFields его не трогает
    undefined,   // tasksService
    undefined,   // events
    oauth,       // talerIdOauth
  );
}

describe('ChatService.taleridAgentFields', () => {
  const OLD_ENV = process.env.TALERID_BASE_URL;
  afterEach(() => {
    if (OLD_ENV === undefined) delete process.env.TALERID_BASE_URL;
    else process.env.TALERID_BASE_URL = OLD_ENV;
  });

  it('connected → returns the token and the MCP url derived from TALERID_BASE_URL', async () => {
    process.env.TALERID_BASE_URL = 'https://api.talerid.io';
    const oauth = { getBackendAccessToken: jest.fn().mockResolvedValue('access-xyz') };
    const svc = makeService(oauth);

    const r = await svc.taleridAgentFields('user-1');

    expect(oauth.getBackendAccessToken).toHaveBeenCalledWith('user-1');
    expect(r).toEqual({ token: 'access-xyz', mcpUrl: 'https://api.talerid.io/mcp' });
  });

  it('strips a trailing slash on the base url before appending /mcp', async () => {
    process.env.TALERID_BASE_URL = 'https://staging.id.taler.tirol/';
    const svc = makeService({ getBackendAccessToken: jest.fn().mockResolvedValue('t') });
    const r = await svc.taleridAgentFields('user-1');
    expect(r?.mcpUrl).toBe('https://staging.id.taler.tirol/mcp');
  });

  it('defaults to staging when TALERID_BASE_URL is unset', async () => {
    delete process.env.TALERID_BASE_URL;
    const svc = makeService({ getBackendAccessToken: jest.fn().mockResolvedValue('t') });
    const r = await svc.taleridAgentFields('user-1');
    expect(r?.mcpUrl).toBe('https://staging.id.taler.tirol/mcp');
  });

  it('not connected (null token) → returns null (no fields appended downstream)', async () => {
    const svc = makeService({ getBackendAccessToken: jest.fn().mockResolvedValue(null) });
    const r = await svc.taleridAgentFields('user-1');
    expect(r).toBeNull();
  });

  it('no TalerID service injected → returns null without touching env', async () => {
    const svc = makeService(undefined);
    const r = await svc.taleridAgentFields('user-1');
    expect(r).toBeNull();
  });

  it('mint throws → degrades to null (agent runs without TalerID tools)', async () => {
    const oauth = { getBackendAccessToken: jest.fn().mockRejectedValue(new Error('refresh boom')) };
    const svc = makeService(oauth);
    const r = await svc.taleridAgentFields('user-1');
    expect(r).toBeNull();
  });
});
