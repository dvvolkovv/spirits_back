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

describe('ИИ-поддержка и справка', () => {
  const service = () => new SupportService({ query: async () => ({ rows: [] }) } as any);

  it('на вопрос о платформе — сначала статья справки', () => {
    expect(prompt({ language: 'ru' })).toMatch(/сначала возьми статью инструментом linkeon_help/);
  });

  it('сборка из стора: перечень разделов без партнёрской программы', () => {
    const p = (service() as any).buildSystemPrompt({ language: 'ru' }, undefined, { storeBuild: true });
    expect(p).toContain(platformSections('ru', { store: true }));
    expect(p).not.toContain('«Партнёры»');
  });

  it('у поддержки есть инструмент linkeon_help, и он отвечает на языке пользователя', async () => {
    const defs = (service() as any).supportToolDefs('t-1', 'u-test', { lang: 'en', client: 'web' });
    const help = defs.find((d: any) => d.name === 'linkeon_help');
    expect(help).toBeDefined();
    const out = await help.handler({ topics: ['products'] }, {});
    const result = JSON.parse(out.content[0].text);
    expect(result.ok).toBe(true);
    expect(result.articles[0].text).toContain('«Studio»');
  });

  it('прежние инструменты на месте', () => {
    const names = (service() as any).supportToolDefs('t-1', 'u-test').map((d: any) => d.name);
    for (const n of ['get_user_context', 'get_recent_jobs', 'check_service_health', 'refund_tokens', 'rerun_failed_job', 'escalate_to_owner']) {
      expect(names).toContain(n);
    }
  });
});
