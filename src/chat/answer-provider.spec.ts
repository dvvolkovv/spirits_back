import { cliProviderOption, readDoneProvider, relayProviderFields, resolveAnswerProvider } from './answer-provider';

describe('resolveAnswerProvider', () => {
  const svc = (provider: 'claude' | 'qwen' | 'kimi', choice: 'user' | 'global' = 'user') =>
    ({ route: jest.fn(async () => ({ provider, choice })) });

  it('маршрут из сервиса: личный выбор', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('qwen') as any)).toEqual({ provider: 'qwen', choice: 'user' });
  });
  it('маршрут из сервиса: рубильник', async () => {
    expect(await resolveAnswerProvider(false, 'u1', svc('kimi', 'global') as any)).toEqual({ provider: 'kimi', choice: 'global' });
  });
  it('проба — всегда claude, choice null, настройку не читает', async () => {
    const s = svc('qwen');
    expect(await resolveAnswerProvider(true, 'u1', s as any)).toEqual({ provider: 'claude', choice: null });
    expect(s.route).not.toHaveBeenCalled();
  });
  it('нет сервиса — claude, choice null', async () => {
    expect(await resolveAnswerProvider(false, 'u1', undefined)).toEqual({ provider: 'claude', choice: null });
  });
  it('нет userId — маршрут для пустого id (рубильник)', async () => {
    const s = svc('qwen', 'global');
    expect(await resolveAnswerProvider(false, '', s as any)).toEqual({ provider: 'qwen', choice: 'global' });
    expect(s.route).toHaveBeenCalledWith('');
  });
});

describe('relayProviderFields', () => {
  it('проба — noFallback', () => expect(relayProviderFields(true, 'qwen')).toEqual({ noFallback: '1' }));
  it('qwen — provider', () => expect(relayProviderFields(false, 'qwen')).toEqual({ provider: 'qwen' }));
  it('claude — ничего', () => expect(relayProviderFields(false, 'claude')).toEqual({}));
  it('kimi — provider', () => expect(relayProviderFields(false, 'kimi')).toEqual({ provider: 'kimi' }));
  it('проба при выборе Kimi — только noFallback', () => expect(relayProviderFields(true, 'kimi')).toEqual({ noFallback: '1' }));
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
  it('kimi', () => {
    expect(readDoneProvider({ type: 'done', provider: 'kimi', fallback: false })).toEqual({ provider: 'kimi', fallback: false });
  });
});

describe('cliProviderOption', () => {
  it('личный Claude — явно claude (рубильник не применится)', () =>
    expect(cliProviderOption({ provider: 'claude', choice: 'user' })).toEqual({ provider: 'claude' }));
  it('личный kimi', () => expect(cliProviderOption({ provider: 'kimi', choice: 'user' })).toEqual({ provider: 'kimi' }));
  it('рубильник — без поля (ClaudeCliService применит его сам)', () =>
    expect(cliProviderOption({ provider: 'qwen', choice: 'global' })).toEqual({}));
  it('проба — без поля', () => expect(cliProviderOption({ provider: 'claude', choice: null })).toEqual({}));
});
