const mockCreate = jest.fn();

jest.mock('openai', () => {
  const ctor = jest.fn().mockImplementation(() => ({
    audio: { speech: { create: mockCreate } },
  }));
  return { __esModule: true, default: ctor };
});

import { TtsService } from './tts.service';

describe('TtsService.synthesize', () => {
  const OLD_KEY = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'test-key';
    mockCreate.mockReset();
  });

  afterAll(() => {
    if (OLD_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = OLD_KEY;
  });

  it('returns a non-empty Buffer + cost > 0 for a short Russian phrase', async () => {
    const fakeBytes = new Uint8Array([1, 2, 3, 4, 5]);
    mockCreate.mockResolvedValue({
      arrayBuffer: async () => fakeBytes.buffer,
    });

    const svc = new TtsService();
    const { audio, cost } = await svc.synthesize('Готово');

    expect(Buffer.isBuffer(audio)).toBe(true);
    expect(audio.length).toBeGreaterThan(0);
    expect(audio).toEqual(Buffer.from(fakeBytes));
    expect(cost).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'tts-1',
      voice: 'alloy',
      input: 'Готово',
      response_format: 'opus',
    });
  });

  it('respects the format argument (mp3) and passes it to OpenAI', async () => {
    mockCreate.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([9, 9]).buffer });

    const svc = new TtsService();
    const { audio, cost } = await svc.synthesize('Привет', 'mp3');

    expect(audio.length).toBeGreaterThan(0);
    expect(cost).toBeGreaterThan(0);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ response_format: 'mp3' }),
    );
  });

  it('throws a clear error when OPENAI_API_KEY is missing', async () => {
    delete process.env.OPENAI_API_KEY;
    const svc = new TtsService();
    await expect(svc.synthesize('Готово')).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
