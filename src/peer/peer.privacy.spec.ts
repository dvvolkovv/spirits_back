import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { join } from 'path';
import { canReceiveNewProposal } from '../privacy/profile-privacy';
import { LIMITS } from './peer.dto';
import { PeerService } from './peer.service';

jest.mock('../privacy/profile-privacy', () => ({
  canReceiveNewProposal: jest.fn(),
}));

const canReceive = canReceiveNewProposal as jest.MockedFunction<typeof canReceiveNewProposal>;
const FROM = 'requester-id';
const TO = 'target-id';
const dto = { toUserId: TO, introMessage: 'hello' };

function makeAllowedService(options: {
  targetExists?: boolean;
  blocked?: boolean;
  conversationId?: string;
  pendingId?: string;
  reversePendingId?: string;
  pendingCount?: number;
  rateCount?: number;
} = {}) {
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('SELECT 1 FROM ai_profiles_consolidated WHERE user_id')) {
        return { rows: options.targetExists === false ? [] : [{ exists: 1 }] };
      }
      if (sql.includes('FROM user_blocks')) {
        return { rows: options.blocked ? [{ blocked: 1 }] : [] };
      }
      if (sql.includes('SELECT id FROM peer_conversations')) {
        return { rows: options.conversationId ? [{ id: options.conversationId }] : [] };
      }
      if (sql.includes('SELECT id FROM chat_requests')) {
        if (params[0] === FROM && params[1] === TO) {
          return { rows: options.pendingId ? [{ id: options.pendingId }] : [] };
        }
        if (params[0] === TO && params[1] === FROM) {
          return { rows: options.reversePendingId ? [{ id: options.reversePendingId }] : [] };
        }
      }
      if (sql.includes('SELECT count(*)::int AS n FROM chat_requests')) {
        if (sql.includes('created_at')) return { rows: [{ n: options.rateCount ?? 0 }] };
        return { rows: [{ n: options.pendingCount ?? 0 }] };
      }
      if (sql.includes('INSERT INTO chat_requests')) {
        return { rows: [{ id: 'new-request' }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }),
  };
  return { pg, service: new PeerService(pg as any) };
}

async function captureError(promise: Promise<unknown>): Promise<any> {
  return promise.then(() => null, (error) => error);
}

async function expectProfileNotAvailable(promise: Promise<unknown>): Promise<void> {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(NotFoundException);
  expect((error as NotFoundException).getStatus()).toBe(404);
  expect((error as NotFoundException).getResponse()).toEqual({ code: 'PROFILE_NOT_AVAILABLE' });
}

function expectNoInsert(pg: { query: jest.Mock }): void {
  expect(pg.query.mock.calls.some((call) => call[0].includes('INSERT INTO chat_requests'))).toBe(false);
}

describe('PeerService.sendRequest privacy', () => {
  beforeEach(() => {
    canReceive.mockReset().mockResolvedValue(true);
  });

  it.each([
    { label: 'hidden', targetExists: true },
    { label: 'missing', targetExists: false },
  ])('returns PROFILE_NOT_AVAILABLE for a $label target before target lookup or other SQL', async ({ targetExists }) => {
    canReceive.mockResolvedValue(false);
    const { service, pg } = makeAllowedService({ targetExists });

    await expectProfileNotAvailable(service.sendRequest(FROM, dto));

    expect(canReceive).toHaveBeenCalledWith(pg, TO);
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('still applies the existing block rule when proposals are allowed', async () => {
    const { service, pg } = makeAllowedService({ blocked: true });

    const error = await captureError(service.sendRequest(FROM, dto));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toBe('blocked');
    expect(canReceive).toHaveBeenCalledWith(pg, TO);
    expectNoInsert(pg);
  });

  it('still returns an existing conversation conflict when proposals are allowed', async () => {
    const { service, pg } = makeAllowedService({ conversationId: 'conversation-1' });

    const error = await captureError(service.sendRequest(FROM, dto));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      error: 'conversation_exists',
      conversationId: 'conversation-1',
    });
    expectNoInsert(pg);
  });

  it('still returns an existing pending request conflict when proposals are allowed', async () => {
    const { service, pg } = makeAllowedService({ pendingId: 'request-1' });

    const error = await captureError(service.sendRequest(FROM, dto));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      error: 'request_already_pending',
      requestId: 'request-1',
    });
    expectNoInsert(pg);
  });

  it('still auto-accepts a reverse pending request when proposals are allowed', async () => {
    const { service } = makeAllowedService({ reversePendingId: 'reverse-1' });
    const accept = jest.spyOn(service, 'acceptRequest').mockResolvedValue({
      conversationId: 'conversation-1',
      status: 'accepted',
    });

    const result = await service.sendRequest(FROM, dto);

    expect(accept).toHaveBeenCalledWith(FROM, 'reverse-1');
    expect(result).toMatchObject({ id: 'reverse-1', conversationId: 'conversation-1' });
  });

  it('still enforces the outgoing pending limit when proposals are allowed', async () => {
    const { service, pg } = makeAllowedService({ pendingCount: LIMITS.MAX_PENDING_OUTGOING });

    const error = await captureError(service.sendRequest(FROM, dto));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toContain('too many pending requests');
    expectNoInsert(pg);
  });

  it('still enforces the rate window when proposals are allowed', async () => {
    const { service, pg } = makeAllowedService({ rateCount: LIMITS.RATE_MAX_PER_WINDOW });

    const error = await captureError(service.sendRequest(FROM, dto));

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(error.message).toContain('rate limited');
    expect(pg.query).toHaveBeenCalledWith(
      expect.stringContaining('created_at > now()'),
      [FROM, String(LIMITS.RATE_WINDOW_SEC)],
    );
    expectNoInsert(pg);
  });
});

describe('PeerController requester identity', () => {
  it('uses JwtGuard userId everywhere and never reads the absent phone claim', () => {
    const source = readFileSync(join(__dirname, 'peer.controller.ts'), 'utf8');

    expect(source).not.toMatch(/\bu\.phone\b/);
    expect(source).toMatch(/\bu\.userId\b/);
  });
});
