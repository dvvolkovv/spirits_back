import { SupportService } from './support.service';
import { linksRule, platformSections } from '../chat/platform-guide';

// Для теста учёта вызовов справки — нужен SupportService с events-моком; не
// используем service()/prompt() ниже, те не передают EventsService совсем.
function serviceWithEvents() {
  const events = { track: jest.fn() };
  const svc = new SupportService({ query: async () => ({ rows: [] }) } as any, undefined, undefined, undefined, events as any);
  return { svc, events };
}

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

  // Ответы поддержки кабинет показывает простым текстом и делает ссылкой
  // только сам адрес (SupportView, linkify): markdown остался бы скобками.
  it('ссылки на разделы — полным адресом, без markdown', () => {
    const p = prompt({ language: 'ru' });
    expect(p).toContain(linksRule('plain'));
    expect(p).not.toContain(linksRule('markdown'));
    expect(p).toContain('https://my.linkeon.io/profile?open=zoom');
  });
});

describe('ИИ-поддержка и справка', () => {
  const service = () => new SupportService({ query: async () => ({ rows: [] }) } as any);

  it('на вопрос «как сделать/сколько стоит/как устроено» — сначала статья справки', () => {
    const p = prompt({ language: 'ru' });
    expect(p).toMatch(/как сделать.*сколько стоит.*как устроено.*сначала возьми статью инструментом linkeon_help/);
  });

  it('на сбой — сначала get_recent_jobs и check_service_health, не справка', () => {
    const p = prompt({ language: 'ru' });
    expect(p).toMatch(/при сбое или упавшей генерации.*сначала.*get_recent_jobs.*check_service_health/i);
    // старая формулировка звала linkeon_help первым даже на «не работает» — сужено
    expect(p).not.toMatch(/что делать, если не работает.*сначала возьми статью инструментом linkeon_help/);
  });

  it('сборка из стора: перечень разделов без партнёрской программы', () => {
    const p = (service() as any).buildSystemPrompt({ language: 'ru' }, undefined, { storeBuild: true });
    expect(p).toContain(platformSections('ru', { store: true }));
    expect(p).not.toContain('«Партнёры»');
  });

  // Сборка из стора открывает ссылку во внешнем браузере, а в кабинете —
  // баланс, покупка и «Скачать APK» (Apple 3.1.1; довод — у platformSections).
  it('сборка из стора: ни адресов кабинета, ни правила ссылок', () => {
    for (const language of ['ru', 'en', 'zh']) {
      const p = (service() as any).buildSystemPrompt({ language }, undefined, { storeBuild: true });
      expect(p).not.toContain('https://my.linkeon.io/');
      expect(p).not.toContain(linksRule('plain'));
      expect(p).not.toContain(linksRule('markdown'));
    }
    // Вне стора — как было: правило ссылок на месте.
    expect((service() as any).buildSystemPrompt({ language: 'ru' }, undefined, {})).toContain(linksRule('plain'));
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

  // По образцу products-mcp.controller.ts: статистика, кто и о чём спрашивает
  // справку, нужна независимо от того, звонит ли её TG-бот, продукты или
  // сама ИИ-поддержка, — иначе этот канал не виден в учёте вовсе.
  it('вызов справки из поддержки пишет статистику linkeon_help_call', async () => {
    const { svc, events } = serviceWithEvents();
    const defs = (svc as any).supportToolDefs('t-1', 'u-test', { lang: 'en', client: 'telegram' });
    const help = defs.find((d: any) => d.name === 'linkeon_help');
    await help.handler({ topics: ['products'] }, {});
    expect(events.track).toHaveBeenCalledWith('linkeon_help_call', {
      userId: 'u-test',
      props: { channel: 'support', client: 'telegram', lang: 'en', scope: 'full', agent: 'support', topics: ['products'], index: false },
    });
  });

  it('прежние инструменты на месте', () => {
    const names = (service() as any).supportToolDefs('t-1', 'u-test').map((d: any) => d.name);
    for (const n of ['get_user_context', 'get_recent_jobs', 'check_service_health', 'refund_tokens', 'rerun_failed_job', 'escalate_to_owner']) {
      expect(names).toContain(n);
    }
  });
});
