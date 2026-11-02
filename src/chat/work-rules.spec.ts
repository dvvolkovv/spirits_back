import { ChatService } from './chat.service';
import { WORK_RULES } from './work-rules';

/** Стабильная часть промпта релея — то, что уходит в --system-prompt. */
async function stablePrefix(agentId: string, agentName = 'Роман'): Promise<string> {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  return (svc as any).buildRelayStablePrefix({
    agentId,
    agentName,
    agentDescription: '',
    agentSystemPrompt: 'Ты ассистент.',
    userId: 'u1',
    userLanguage: 'ru',
  });
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('WORK_RULES — правила длинной работы с файлами', () => {
  it('рабочий список — файлом с первой порции, без откладывания', () => {
    expect(WORK_RULES).toContain('РАБОЧИЕ СПИСКИ');
    expect(WORK_RULES).toContain('с первой же порции');
    expect(WORK_RULES).toContain('не откладывай файл');
  });

  it('утверждённое — числами в файл, пересборка от утверждённой версии, сверка перед отправкой', () => {
    expect(WORK_RULES).toContain('УТВЕРЖДЁННОЕ НЕИЗМЕННО');
    expect(WORK_RULES).toContain('точными числами');
    expect(WORK_RULES).toContain('от утверждённой версии');
    expect(WORK_RULES).toContain('Перед отправкой измерь');
  });

  it('слои — правка исходника в его структуре, проверка после правки', () => {
    expect(WORK_RULES).toContain('СЛОИ И СТРУКТУРА');
    expect(WORK_RULES).toContain('не пересобирай из картинки');
  });

  it('длинная работа — промежуточное сохраняется файлами по ходу', () => {
    expect(WORK_RULES).toContain('ДЛИННАЯ РАБОТА');
    expect(WORK_RULES).toContain('продолжит с них');
  });

  it('картинка из сети — сама картинка, а не одни ссылки; перевод надписей только по просьбе', () => {
    expect(WORK_RULES).toContain('КАРТИНКА ИЗ СЕТИ');
    expect(WORK_RULES).toContain('не отвечай одними ссылками');
    expect(WORK_RULES).toContain('только если человек просит');
  });

  it('короткий: системный промпт релея уходит одним аргументом CLI (предел 128 КБ)', () => {
    expect(Buffer.byteLength(WORK_RULES, 'utf8')).toBeLessThanOrEqual(4096);
  });
});

describe('WORK_RULES в стабильной части промпта релея', () => {
  it('штатному ассистенту — ровно один раз', async () => {
    const prefix = await stablePrefix('12');
    expect(count(prefix, WORK_RULES)).toBe(1);
  });

  it('пользовательскому ассистенту — тоже, ровно один раз', async () => {
    const prefix = await stablePrefix('custom:6f1c2b9e-0000-4000-8000-000000000000', 'Мой помощник');
    expect(count(prefix, WORK_RULES)).toBe(1);
  });

  it('стоит до профиля: профиль меняется, правила — нет (кэш релея)', async () => {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
    const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
    const prefix: string = await (svc as any).buildRelayStablePrefix({
      agentId: '12', agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты ассистент.',
      userId: 'u1', userLanguage: 'ru', profileText: 'ПРОФИЛЬ-МАРКЕР',
    });
    expect(prefix.indexOf(WORK_RULES)).toBeGreaterThan(-1);
    expect(prefix.indexOf(WORK_RULES)).toBeLessThan(prefix.indexOf('ПРОФИЛЬ-МАРКЕР'));
  });
});
