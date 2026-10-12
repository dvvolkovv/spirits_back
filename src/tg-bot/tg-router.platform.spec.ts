import { TgRouterService } from './tg-router.service';
import { platformSections, telegramPlatformGuide } from '../chat/platform-guide';

/**
 * Блок «Linkeon» в промпте Telegram-бота.
 *
 * Веб-ассистенты с 12.10.2026 знают разделы кабинета (chat/platform-guide.ts),
 * а Telegram собирает промпт сам, и туда блок не доходил: на «что это за бот»,
 * «где сделать то, чего здесь нет» ассистенту было нечем ответить. Подписи — на
 * языке интерфейса владельца: по нему он видит кабинет. Только штатным
 * ассистентам: у бота с ассистентом пользователя может быть свой бренд.
 */

function makeRouter(language: string | null | Error) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/profile_data->>'language'/.test(sql)) {
        if (language instanceof Error) throw language;
        return { rows: language ? [{ language }] : [] };
      }
      return { rows: [] };
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(async (_prompt: string, _opts: any) => ({ text: 'ответ', costUsd: 0.01 })),
  };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, claudeCli as any);
  jest.spyOn(svc as any, 'resolveSystemPrompt').mockResolvedValue({ name: 'Роман', systemPrompt: 'Ты Роман.' });
  jest.spyOn(svc as any, 'loadHistory').mockResolvedValue([{ role: 'user', content: 'что это за бот?' }]);
  return { svc, claudeCli };
}

const systemFrom = (c: any) => String(c.textWithCost.mock.calls[0][1].system || '');
const preset: any = { id: 1, tg_chat_id: '-100123', owner_user_id: 'u-1', preset_agent_id: '12' };
const custom: any = { id: 2, tg_chat_id: '-100123', owner_user_id: 'u-1', custom_agent_id: 'c-1' };

describe('Telegram: блок «Linkeon» в промпте', () => {
  it('штатный ассистент получает блок с разделами кабинета', async () => {
    const { svc, claudeCli } = makeRouter('ru');
    await svc.generateReply(preset, 'Дмитрий');

    expect(systemFrom(claudeCli)).toContain(telegramPlatformGuide('ru'));
  });

  it('подписи — на языке интерфейса владельца', async () => {
    const { svc, claudeCli } = makeRouter('en');
    await svc.generateReply(preset, 'Dmitry');

    const system = systemFrom(claudeCli);
    expect(system).toContain(platformSections('en'));
    expect(system).not.toContain('«Студия»');
  });

  it('боту с ассистентом пользователя блок не добавляется', async () => {
    const { svc, claudeCli } = makeRouter('ru');
    await svc.generateReply(custom, 'Дмитрий');

    expect(systemFrom(claudeCli)).not.toContain('--- LINKEON ---');
  });

  it('язык не прочитался — русские подписи, ход не падает', async () => {
    const { svc, claudeCli } = makeRouter(new Error('db down'));
    await svc.generateReply(preset, 'Дмитрий');

    expect(systemFrom(claudeCli)).toContain(telegramPlatformGuide('ru'));
  });
});

describe('telegramPlatformGuide', () => {
  const g = (lang: string) => telegramPlatformGuide(lang).replace(/\s+/g, ' ');

  it('называет кабинет и даёт тот же перечень разделов', () => {
    expect(g('ru')).toMatch(/my\.linkeon\.io/);
    expect(telegramPlatformGuide('ru')).toContain(platformSections('ru'));
  });

  it('говорит, что в веб-чате больше инструментов и что тут их нет', () => {
    expect(g('ru')).toMatch(/В веб-чате Linkeon у ассистентов больше инструментов/);
  });

  it('свой такой бот — в «Студия» → «Telegram-боты», подписями языка', () => {
    expect(g('ru')).toContain('«Студия» → «Telegram-боты»');
    expect(g('en')).toContain('«Studio» → «Telegram bots»');
  });

  it('озвучку в Telegram не отнимает: голосовые ответы у бота есть', () => {
    const webOnly = /больше инструментов[^.]*\./.exec(g('ru'))?.[0] || '';
    expect(webOnly).not.toMatch(/озвуч/);
  });
});
