import { VoiceCallService } from './voice-call.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;

function makeService(rows: any[] = []) {
  const pg = { query: jest.fn(async () => ({ rows })) };
  const svc = new VoiceCallService(pg as any, {} as any, {} as any);
  return { svc, pg };
}

describe('VoiceCallService profileTurns privacy gates', () => {
  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
  });

  it('returns no turns and keeps the cursor without reading transcripts when disabled', async () => {
    automaticProfilingAllowedMock.mockResolvedValue(false);
    const { svc, pg } = makeService([
      { id: 'private-call', transcript: [{ role: 'user', text: 'private', ts: 124 }] },
    ]);

    await expect(svc.profileTurns('u1', 123)).resolves.toEqual({ turns: [], cursor: 123 });

    expect(pg.query).not.toHaveBeenCalled();
  });

  it('discards queried transcripts and keeps the cursor when consent is revoked after entry', async () => {
    automaticProfilingAllowedMock.mockResolvedValueOnce(true).mockResolvedValue(false);
    const { svc, pg } = makeService([
      { id: 'private-call', transcript: [{ role: 'user', text: 'private', ts: 124 }] },
    ]);

    await expect(svc.profileTurns('u1', 123)).resolves.toEqual({ turns: [], cursor: 123 });

    expect(pg.query).toHaveBeenCalledTimes(1);
    expect(automaticProfilingAllowedMock).toHaveBeenCalledTimes(2);
  });
});
