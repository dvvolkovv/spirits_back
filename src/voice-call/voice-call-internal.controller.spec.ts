import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { VoiceCallInternalController } from './voice-call-internal.controller';
import { signBody } from './hmac';

describe('VoiceCallInternalController: доступ', () => {
  const SECRET = 'secret-for-tests';
  const body = { callId: 'call-1', specialist: 'Алексей', question: 'вопрос' };
  const raw = JSON.stringify(body);
  const req = (text: string) => ({ body: Buffer.from(text, 'utf8') }) as any;

  function makeCtl() {
    const jobs = { ask: jest.fn(async () => ({ status: 'asked', jobId: 'j1', specialist: 'Алексей' })) };
    const calls = { load: jest.fn(async () => ({ id: 'call-1', user_id: 'u1', room_name: 'room-1' })), complete: jest.fn(), fail: jest.fn() };
    return { ctl: new VoiceCallInternalController(jobs as any, calls as any), jobs, calls };
  }

  beforeEach(() => { process.env.VOICE_CALLBACK_SECRET = SECRET; });

  it('без подписи — 401', async () => {
    const { ctl, jobs } = makeCtl();
    await expect(ctl.ask('' as any, req(raw))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jobs.ask).not.toHaveBeenCalled();
  });

  it('с чужой подписью — 401', async () => {
    const { ctl, jobs } = makeCtl();
    await expect(ctl.ask(signBody('wrong', raw), req(raw))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(jobs.ask).not.toHaveBeenCalled();
  });

  it('подпись верная, но тело подменено — 401', async () => {
    const { ctl } = makeCtl();
    const tampered = raw.replace('вопрос', 'другой вопрос');
    await expect(ctl.ask(signBody(SECRET, raw), req(tampered))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('верная подпись над кривым JSON — 400, а не 500', async () => {
    const { ctl } = makeCtl();
    const broken = '{не json';
    await expect(ctl.ask(signBody(SECRET, broken), req(broken))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('с верной подписью — проходит', async () => {
    const { ctl, jobs } = makeCtl();
    const res = await ctl.ask(signBody(SECRET, raw), req(raw));
    expect(res).toMatchObject({ status: 'asked' });
    expect(jobs.ask).toHaveBeenCalledWith('call-1', 'room-1', 'u1', 'Алексей', 'вопрос');
  });
});
