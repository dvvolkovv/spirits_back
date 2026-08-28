import { VoiceCallController } from './voice-call.controller';

describe('VoiceCallController.start', () => {
  function make() {
    const calls = {
      start: jest.fn().mockResolvedValue({ callId: 'c1', roomName: 'voice_c1', token: 't', wsUrl: 'ws://x' }),
    } as any;
    return { ctrl: new VoiceCallController(calls), calls };
  }

  it('any logged-in user (not just admin) can start a call → delegates to the service', async () => {
    const { ctrl, calls } = make();
    const res = await ctrl.start({ userId: 'u1', isAdmin: false });
    expect(calls.start).toHaveBeenCalledWith('u1');
    expect(res).toMatchObject({ callId: 'c1', token: 't' });
  });

  it('admin also works (no regression)', async () => {
    const { ctrl, calls } = make();
    await ctrl.start({ userId: 'admin1', isAdmin: true });
    expect(calls.start).toHaveBeenCalledWith('admin1');
  });
});
