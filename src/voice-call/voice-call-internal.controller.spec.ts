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
    const calls = {
      load: jest.fn(async () => ({ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'active' })),
      isActive: jest.fn((c: { status: string }) => c.status === 'dialing' || c.status === 'active'),
      complete: jest.fn(),
      fail: jest.fn(),
    };
    const docs = { create: jest.fn(() => ({ status: 'accepted', docId: 'd1', title: 'Письмо' })) };
    return { ctl: new VoiceCallInternalController(jobs as any, calls as any, docs as any), jobs, calls, docs };
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

  it('вопрос по завершённому звонку отклоняется, к Claude не идём', async () => {
    const { ctl, jobs, calls } = makeCtl();
    calls.load = jest.fn(async () => ({ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'completed' })) as any;
    const res = await ctl.ask(signBody(SECRET, raw), req(raw));
    expect(res).toMatchObject({ status: 'rejected' });
    expect(jobs.ask).not.toHaveBeenCalled();
  });

  describe('/document', () => {
    const docBody = { callId: 'call-1', title: 'Письмо', instructions: 'коротко' };
    const docRaw = JSON.stringify(docBody);

    it('ручка документов тоже закрыта подписью', async () => {
      const { ctl, docs } = makeCtl();
      await expect(ctl.document('' as any, req(docRaw))).rejects.toBeInstanceOf(UnauthorizedException);
      expect(docs.create).not.toHaveBeenCalled();
    });

    it('с верной подписью документ ставится в работу', async () => {
      const { ctl, docs } = makeCtl();
      const res = await ctl.document(signBody(SECRET, docRaw), req(docRaw));
      expect(res).toMatchObject({ status: 'accepted' });
      expect(docs.create).toHaveBeenCalledWith('call-1', 'room-1', 'u1', 'Письмо', 'коротко');
    });

    it('документ по завершённому звонку не сочиняем', async () => {
      const { ctl, docs, calls } = makeCtl();
      calls.load = jest.fn(async () => ({ id: 'call-1', user_id: 'u1', room_name: 'room-1', status: 'completed' })) as any;
      const res = await ctl.document(signBody(SECRET, docRaw), req(docRaw));
      expect(res).toMatchObject({ status: 'rejected' });
      expect(docs.create).not.toHaveBeenCalled();
    });
  });
});
