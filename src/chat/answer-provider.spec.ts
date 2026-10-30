import { readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';

describe('resolveAnswerProvider', () => {
  const svc = (p: 'claude' | 'qwen') => ({ get: jest.fn(async () => p) });

  it('выбор пользователя', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('qwen') as any)).toBe('qwen');
  });
  it('проба — всегда claude, настройку не читает', async () => {
    const s = svc('qwen');
    expect(await resolveAnswerProvider(true, 'u1', s as any)).toBe('claude');
    expect(s.get).not.toHaveBeenCalled();
  });
  it('нет сервиса или userId — claude', async () => {
    expect(await resolveAnswerProvider(false, 'u1', undefined)).toBe('claude');
    expect(await resolveAnswerProvider(false, '', svc('qwen') as any)).toBe('claude');
  });
});

describe('relayProviderFields', () => {
  it('проба — noFallback', () => expect(relayProviderFields(true, 'qwen')).toEqual({ noFallback: '1' }));
  it('qwen — provider', () => expect(relayProviderFields(false, 'qwen')).toEqual({ provider: 'qwen' }));
  it('claude — ничего', () => expect(relayProviderFields(false, 'claude')).toEqual({}));
});

describe('readDoneProvider', () => {
  it('новый релей', () => {
    expect(readDoneProvider({ type: 'done', provider: 'qwen', fallback: true })).toEqual({ provider: 'qwen', fallback: true });
  });
  it('старый релей — пусто', () => {
    expect(readDoneProvider({ type: 'done' })).toEqual({ provider: undefined, fallback: false });
  });
  it('мусор — пусто', () => {
    expect(readDoneProvider({ type: 'done', provider: 'gpt', fallback: 'yes' })).toEqual({ provider: undefined, fallback: false });
  });
});
