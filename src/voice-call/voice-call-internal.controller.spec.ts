import { BadRequestException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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

  it('без секрета в окружении — 503, а не открытая ручка', async () => {
    const { ctl, jobs } = makeCtl();
    delete process.env.VOICE_CALLBACK_SECRET;
    await expect(ctl.ask(signBody(SECRET, raw), req(raw))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(jobs.ask).not.toHaveBeenCalled();
  });

  it('секрет, появившийся в окружении ПОСЛЕ загрузки модуля, работает', async () => {
    // ConfigModule.forRoot() наполняет process.env позже вычисления
    // module-level констант. Если бы секрет кешировался на импорте, ручка
    // была бы мертва в проде при заданном .env — это и случилось однажды.
    const { ctl } = makeCtl();
    delete process.env.VOICE_CALLBACK_SECRET;
    process.env.VOICE_CALLBACK_SECRET = 'appeared-later';
    const res = await ctl.ask(signBody('appeared-later', raw), req(raw));
    expect(res).toMatchObject({ status: 'asked' });
  });
});
