import { SupportService } from './support.service';
import { platformSections } from '../chat/platform-guide';

/// Что ИИ-поддержка знает о платформе.
///
/// Раньше — одна строка «нетворкинг, генерация изображений и видео (Kling),
/// реферальная программа»: ни Студии, ни звонка, ни календарей. Теперь тот же
/// перечень разделов, что у ассистентов (chat/platform-guide.ts), подписями на
/// языке пользователя.
function prompt(profile: any): string {
  const service = new SupportService({ query: async () => ({ rows: [] }) } as any);
  return (service as any).buildSystemPrompt(profile, undefined);
}

describe('ИИ-поддержка знает разделы платформы', () => {
  it('перечень разделов тот же, что у ассистентов', () => {
    expect(prompt({ language: 'ru' })).toContain(platformSections('ru'));
  });

  it('подписи на языке пользователя', () => {
    const p = prompt({ language: 'en' });
    expect(p).toContain(platformSections('en'));
    expect(p).toContain('«Studio»');
  });

  it('без устаревшего «видео (Kling)»', () => {
    expect(prompt({ language: 'ru' })).not.toMatch(/\(Kling\)/);
  });

  it('не отправляет в поддержку из самой поддержки', () => {
    expect(prompt({ language: 'ru' })).not.toMatch(/предложи «Связаться с поддержкой»/);
  });
});
