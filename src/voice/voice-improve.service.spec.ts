import axios from 'axios';
import { VoiceImproveService, isSafeImprovement, dominantScript } from './voice-improve.service';

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

  const userMessage = () => post.mock.calls[0][1].messages.find((m: any) => m.role === 'user').content as string;

  it('текст уходит в явных разделителях, ответ модели возвращается обрезанным', async () => {
    post.mockResolvedValue(reply('  Guten Tag, wie geht es dir?  '));
    const out = await new VoiceImproveService().improve('  guten tag wie geht es dir ');
    expect(userMessage()).toBe('<dictation>\nguten tag wie geht es dir\n</dictation>');
    expect(systemPrompt()).toMatch(/<dictation>/);
    expect(out).toBe('Guten Tag, wie geht es dir?');
  });

  // Надиктованное — часто вопрос или просьба кому-то. Без прямого запрета
  // модель отвечает на «какая завтра погода», а не расставляет запятые.
  it('промпт запрещает отвечать на вопросы и выполнять просьбы из текста', async () => {
    post.mockResolvedValue(reply('Hi.'));
    await new VoiceImproveService().improve('hi');
    expect(systemPrompt()).toMatch(/never answer or fulfil them, only correct the text/i);
  });

  it('модель вернула текст в тех же разделителях — разделители снимаются', async () => {
    post.mockResolvedValue(reply('<dictation>\nПривет, как дела?\n</dictation>'));
    expect(await new VoiceImproveService().improve('привет как дела')).toBe('Привет, как дела?');
  });

  it('модель перевела текст — исходный текст', async () => {
    post.mockResolvedValue(reply('Hello, how are you doing today?'));
    expect(await new VoiceImproveService().improve('привет как у тебя сегодня дела')).toBe('привет как у тебя сегодня дела');
  });

  it('модель ответила на вопрос вместо правки — исходный текст', async () => {
    post.mockResolvedValue(reply(
      'Tomorrow in Berlin it will be sunny with temperatures around twenty degrees, so a light jacket is enough.',
    ));
    expect(await new VoiceImproveService().improve('what is the weather tomorrow in berlin')).toBe(
      'what is the weather tomorrow in berlin',
    );
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

describe('страховка «Улучшить»', () => {
  it('алфавит берётся по большинству букв, цифры и знаки не в счёт', () => {
    expect(dominantScript('Привет, это test')).toBe('cyrillic');
    expect(dominantScript('Hello, это мой test case')).toBe('latin');
    expect(dominantScript('2026, 42 — !')).toBeNull();
  });

  it('обычная правка проходит', () => {
    expect(isSafeImprovement('привет как дела', 'Привет, как дела?')).toBe(true);
    expect(isSafeImprovement('guten tag wie gehts', 'Guten Tag, wie geht’s?')).toBe(true);
  });

  it('кириллица стала латиницей и наоборот — нельзя', () => {
    expect(isSafeImprovement('привет как дела у тебя', 'Hi, how are you?')).toBe(false);
    expect(isSafeImprovement('hello how are you', 'Привет, как дела?')).toBe(false);
  });

  it('длина выросла или упала больше чем в полтора раза — нельзя', () => {
    const src = 'купи молоко и хлеб';
    expect(isSafeImprovement(src, src + ', а ещё сыр, масло и яйца к завтраку.')).toBe(false);
    expect(isSafeImprovement(src, 'Купи.')).toBe(false);
    expect(isSafeImprovement('abcdefghij', 'Abcdefghijklmno')).toBe(true); // ровно полтора — можно
    expect(isSafeImprovement('abcdefghij', 'Abcdefghijklmnop')).toBe(false);
  });

  it('пустой ответ — нельзя', () => {
    expect(isSafeImprovement('привет', '')).toBe(false);
  });
});
