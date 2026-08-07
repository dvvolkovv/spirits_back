import { ChatToolsService } from './chat-tools';

function makeTools(speechResult: any) {
  const speech = { synthesize: jest.fn(async () => speechResult) };
  const svc = new ChatToolsService(
    {} as any, {} as any, { query: jest.fn(async () => ({ rows: [] })) } as any,
    {} as any, {} as any, {} as any, speech as any,
  );
  return { svc, speech };
}

describe('generate_speech', () => {
  it('успех прокидывает clipId и kind=audio', async () => {
    const { svc } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'https://minio/audio/x.mp3',
      durationSec: 3.2, chars: 48, voice: 'zahar', provider: 'yandex',
      tokensSpent: 1000, cached: false,
    });

    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });
    expect(r.ok).toBe(true);
    expect(r.kind).toBe('audio');
    expect(r.clipId).toBe('c1');
    expect(r.tokensSpent).toBe(1000);
  });

  it('audioUrl наружу НЕ отдаётся — иначе модель вставит голый URL MinIO в ответ', async () => {
    const { svc } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'https://minio.test/linkeon-assets/audio/abc.mp3',
      durationSec: 3.2, chars: 48, voice: 'zahar', provider: 'yandex',
      tokensSpent: 1000, cached: false,
    });

    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });

    // Результат инструмента уходит в контекст модели. Инструкция «не придумывай
    // ссылку» не мешает ей вставить ссылку, которую ей же и дали.
    expect(r).not.toHaveProperty('audioUrl');
    expect(JSON.stringify(r)).not.toContain('minio');
    expect(JSON.stringify(r)).not.toContain('.mp3');
  });

  it('состав полей результата зафиксирован — ничего лишнего в контекст модели', async () => {
    const { svc } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'https://minio.test/a.mp3',
      durationSec: 3.2, chars: 48, voice: 'zahar', provider: 'yandex',
      tokensSpent: 1000, cached: false,
    });

    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });
    expect(Object.keys(r).sort()).toEqual(
      ['cached', 'chars', 'clipId', 'durationSec', 'kind', 'ok', 'tokensSpent', 'voice'].sort(),
    );
  });

  it('нехватка токенов прокидывается как есть', async () => {
    const { svc } = makeTools({ ok: false, error: 'insufficient_tokens', balance: 10, required: 1000 });
    const r: any = await svc.executeTool('u1', 'generate_speech', { text: 'Привет' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('insufficient_tokens');
    expect(r.required).toBe(1000);
  });

  it('voice прокидывается в сервис', async () => {
    const { svc, speech } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'u', durationSec: 1, chars: 6,
      voice: 'jane', provider: 'yandex', tokensSpent: 1000, cached: false,
    });
    await svc.executeTool('u1', 'generate_speech', { text: 'Привет', voice: 'jane' });
    expect(speech.synthesize).toHaveBeenCalledWith('u1', { text: 'Привет', voice: 'jane' });
  });

  it('assistantId из аргументов игнорируется — ассистент берётся из БД', async () => {
    const { svc, speech } = makeTools({
      ok: true, clipId: 'c1', audioUrl: 'u', durationSec: 1, chars: 6,
      voice: 'zahar', provider: 'yandex', tokensSpent: 1000, cached: false,
    });
    await svc.executeTool('u1', 'generate_speech', { text: 'Привет', assistantId: '999' });
    expect(speech.synthesize).toHaveBeenCalledWith('u1', { text: 'Привет', voice: undefined });
  });
});
