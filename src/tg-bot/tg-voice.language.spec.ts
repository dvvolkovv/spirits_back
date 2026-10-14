import { TgVoiceService } from './tg-voice.service';

/**
 * На каком языке Whisper слушает голосовое.
 *
 * Был жёсткий `language: 'ru'`: немецкое голосовое в группе немецкоязычного
 * владельца распознавалось как русская речь — кривой транслитерацией, и бот
 * отвечал на то, чего не говорили. Теперь язык — подсказка от вызывающего (язык
 * владельца бота). Без подсказки Whisper определяет язык сам.
 */

function makeVoice() {
  const grammy = {
    getFile: jest.fn(async () => ({ file_path: 'voice/file_1.oga' })),
    downloadFile: jest.fn(async () => Buffer.from('ogg-bytes')),
  };
  const create = jest.fn(async (_req: any) => ({ text: '  Hallo zusammen  ' }));
  const svc = new TgVoiceService(grammy as any);
  (svc as any)._openai = { audio: { transcriptions: { create } } };
  return { svc, create };
}

describe('TgVoiceService.transcribe: язык распознавания', () => {
  it('подсказка языка уходит в Whisper как есть', async () => {
    const { svc, create } = makeVoice();
    const text = await svc.transcribe('VOICE-1', 'de');
    expect(text).toBe('Hallo zusammen');
    expect(create.mock.calls[0][0].language).toBe('de');
    expect(create.mock.calls[0][0].model).toBe('whisper-1');
  });

  it('русская подсказка — как раньше', async () => {
    const { svc, create } = makeVoice();
    await svc.transcribe('VOICE-1', 'ru');
    expect(create.mock.calls[0][0].language).toBe('ru');
  });

  it('без подсказки языка нет вовсе — Whisper определяет сам, а не «ru» по умолчанию', async () => {
    const { svc, create } = makeVoice();
    await svc.transcribe('VOICE-1');
    expect('language' in create.mock.calls[0][0]).toBe(false);
  });
});
