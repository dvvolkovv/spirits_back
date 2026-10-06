import { SpeechController } from './speech.controller';

const res = () => {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  return r;
};

const make = (result: any) => {
  const speech = { listen: jest.fn(async () => result) };
  const ctl = new SpeechController(speech as any, {} as any, {} as any);
  return { ctl, speech };
};

describe('POST /webhook/speech/listen', () => {
  it.each([
    [{ ok: true, parts: ['u'], chars: 1, tokensSpent: 1000, cached: false, voice: 'zahar', provider: 'yandex' }, 200],
    [{ ok: false, error: 'empty_text' }, 400],
    [{ ok: false, error: 'text_too_long', maxChars: 10000 }, 400],
    [{ ok: false, error: 'insufficient_tokens', balance: 0, required: 1000 }, 402],
    [{ ok: false, error: 'rate_limited', retryAfterSec: 60 }, 429],
    [{ ok: false, error: 'tts_failed' }, 502],
  ])('%j → %i', async (result, status) => {
    const { ctl } = make(result);
    const r = res();
    await ctl.listen({ userId: 'u1' }, { text: 'Привет' }, r);
    expect(r.status).toHaveBeenCalledWith(status);
    expect(r.json).toHaveBeenCalledWith(result);
  });

  it('текст и ассистент — из тела, пользователь — только из токена', async () => {
    const { ctl, speech } = make({ ok: false, error: 'empty_text' });
    await ctl.listen({ userId: 'u1' }, { text: 'Привет', assistant: 'Маша', userId: 'чужой' }, res());
    expect(speech.listen).toHaveBeenCalledWith('u1', { text: 'Привет', assistant: 'Маша' });
  });

  it('не-строки из тела до сервиса не доходят', async () => {
    const { ctl, speech } = make({ ok: false, error: 'empty_text' });
    await ctl.listen({ userId: 'u1' }, { text: { evil: 1 }, assistant: 42 }, res());
    expect(speech.listen).toHaveBeenCalledWith('u1', { text: '', assistant: undefined });
  });
});
