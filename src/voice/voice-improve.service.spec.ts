import axios from 'axios';
import { VoiceImproveService } from './voice-improve.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

/// Диктовка слушает на языке профиля, значит «Улучшить» получает и английский,
/// и немецкий текст. Промпт «ты корректируешь русский текст» тянул модель
/// перевести его на русский — а перевод здесь хуже любой опечатки.
describe('VoiceImproveService', () => {
  const OLD = { openai: process.env.OPENAI_API_KEY, router: process.env.OPENROUTER_API_KEY };
  beforeEach(() => {
    post.mockReset();
    process.env.OPENAI_API_KEY = 'test-key';
    delete process.env.OPENROUTER_API_KEY;
  });
  afterAll(() => {
    if (OLD.openai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = OLD.openai;
    if (OLD.router === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = OLD.router;
  });

  const reply = (content: string) => ({ data: { choices: [{ message: { content } }] } });
  const systemPrompt = () => post.mock.calls[0][1].messages.find((m: any) => m.role === 'system').content as string;

  it('промпт не привязан к русскому и прямо запрещает перевод', async () => {
    post.mockResolvedValue(reply('Hello, world.'));
    await new VoiceImproveService().improve('hello world');
    const p = systemPrompt();
    expect(p).not.toMatch(/русск|russian/i);
    expect(p).toMatch(/never translate/i);
    expect(p).toMatch(/same language/i);
    expect(p).toMatch(/meaning/i);
  });

  it('текст пользователя уходит как есть, ответ модели возвращается обрезанным', async () => {
    post.mockResolvedValue(reply('  Guten Tag, wie geht es dir?  '));
    const out = await new VoiceImproveService().improve('  guten tag wie geht es dir ');
    expect(post.mock.calls[0][1].messages.find((m: any) => m.role === 'user').content).toBe('guten tag wie geht es dir');
    expect(out).toBe('Guten Tag, wie geht es dir?');
  });

  it('сбой модели — исходный текст', async () => {
    post.mockRejectedValue(new Error('timeout'));
    expect(await new VoiceImproveService().improve('bonjour')).toBe('bonjour');
  });

  it('нет ключей — исходный текст, без запроса наружу', async () => {
    delete process.env.OPENAI_API_KEY;
    expect(await new VoiceImproveService().improve('hola')).toBe('hola');
    expect(post).not.toHaveBeenCalled();
  });
});
