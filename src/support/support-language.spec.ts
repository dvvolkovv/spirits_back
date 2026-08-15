import { SupportService } from './support.service';

/// Язык ответа ИИ-поддержки.
///
/// В системном промпте было зашито «отвечай по-русски», и человек, писавший
/// в поддержку по-английски, получал русский ответ. Поймано владельцем при
/// записи видео для Apple.
///
/// Промпт строится приватным методом — дёргаем его напрямую: городить вокруг
/// него публичную обёртку ради теста значит менять код под тест, а не
/// проверять код.
function prompt(service: SupportService, profile: any): string {
  return (service as any).buildSystemPrompt(profile, undefined);
}

describe('ИИ-поддержка отвечает на языке пользователя', () => {
  const service = new SupportService({ query: async () => ({ rows: [] }) } as any);

  it('английский профиль — требование ответить по-английски', () => {
    const p = prompt(service, { language: 'en' });
    expect(p).toContain('Reply in English.');
    expect(p).not.toMatch(/Отвечай кратко, по делу, по-русски/);
  });

  it('немецкий профиль', () => {
    expect(prompt(service, { language: 'de' })).toContain('Antworte auf Deutsch.');
  });

  it('русский остаётся русским', () => {
    expect(prompt(service, { language: 'ru' })).toContain('Отвечай по-русски.');
  });

  it('язык не задан — русский, а не пустая директива', () => {
    const p = prompt(service, {});
    expect(p).toContain('Отвечай по-русски.');
  });

  it('директива стоит в промпте целиком, а не обрывком', () => {
    const p = prompt(service, { language: 'fr' });
    expect(p).toContain('--- ЯЗЫК ОБЩЕНИЯ ---');
    expect(p).toContain('Réponds en français.');
  });
});
