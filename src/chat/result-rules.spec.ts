import { ChatService } from './chat.service';
import { WORK_RULES } from './work-rules';
import { resultRules } from './result-rules';

/** Стабильная часть промпта релея — то, что уходит в --system-prompt. */
async function stablePrefix(storeBuild: boolean): Promise<string> {
  const pg = {
    query: jest.fn(async (sql: string) => /SELECT profile_data FROM ai_profiles_consolidated/.test(sql)
      ? { rows: [{ profile_data: { automaticProfiling: true } }] }
      : { rows: [] }),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(pg as any, null as any, null as any, null as any, language as any, undefined as any);
  return (svc as any).buildRelayStablePrefix({
    agentId: '12', agentName: 'Роман', agentDescription: '', agentSystemPrompt: 'Ты ассистент.',
    userId: 'u1', userLanguage: 'ru', profileText: 'ПРОФИЛЬ-МАРКЕР', storeBuild,
  });
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1;
const WEB = resultRules();
const STORE = resultRules({ store: true });

describe('resultRules — правила сдачи результата', () => {
  it('пять правил под своим заголовком', () => {
    for (const r of [WEB, STORE]) {
      expect(r.startsWith('--- Правила результата ---\n')).toBe(true);
      for (const n of ['1. ', '2. ', '3. ', '4. ', '5. ']) expect(r).toContain(`\n${n}`);
    }
  });

  it('то, что просили: сверить тип результата, двусмысленное — один вопрос до начала', () => {
    expect(WEB).toContain('сверь тип результата с просьбой');
    expect(WEB).toContain('один короткий вопрос до начала');
  });

  it('проверка перед «готово»: pdfinfo, qpdf --check, pdftoppm; две попытки — сказать прямо', () => {
    expect(WEB).toContain('pdfinfo');
    expect(WEB).toContain('qpdf --check');
    expect(WEB).toContain('pdftoppm');
    expect(WEB).toContain('Две попытки не помогли');
  });

  it('итог хода: без заметок для себя, последний абзац — итог, повтор просьбы — показать готовое', () => {
    expect(WEB).toContain('Не пиши заметок для себя');
    expect(WEB).toContain('Последний абзац ответа — итог');
    expect(WEB).toContain('покажи, где он');
  });

  it('платные действия в вебе: цена до серии, отказ по балансу — с выходом', () => {
    expect(WEB).toContain('назови цену и спроси');
    expect(WEB).toContain('по блоку о балансе');
    expect(WEB).toContain('своими средствами');
  });

  it('магазинная сборка: выход и вопрос есть, денег нет (Apple 3.1.1)', () => {
    expect(STORE).toContain('предложи, что можно сделать иначе');
    expect(STORE).toContain('спроси, как продолжить');
    expect(STORE).not.toMatch(/токен|баланс|пополн|стоимост|цен[аеуы]|https?:\/\//i);
  });

  it('большие файлы и ссылки: 100 МБ, ffmpeg, облачные диски по белому списку, без base64 в HTML', () => {
    for (const r of [WEB, STORE]) {
      expect(r).toContain('до 100 МБ');
      expect(r).toContain('ffmpeg');
      expect(r).toContain('белому списку');
      expect(r).toContain('не обещай скачать');
      expect(r).toContain('base64');
    }
  });

  it('бюджет блока — 6 КБ в обоих вариантах', () => {
    expect(Buffer.byteLength(WEB, 'utf8')).toBeLessThanOrEqual(6144);
    expect(Buffer.byteLength(STORE, 'utf8')).toBeLessThanOrEqual(6144);
  });
});

describe('resultRules в стабильной части промпта релея', () => {
  it('ровно один раз, сразу за WORK_RULES и до профиля', async () => {
    const prefix = await stablePrefix(false);
    expect(count(prefix, WEB)).toBe(1);
    expect(prefix.indexOf(WEB)).toBe(prefix.indexOf(WORK_RULES) + WORK_RULES.length + 2);
    expect(prefix.indexOf(WEB)).toBeLessThan(prefix.indexOf('ПРОФИЛЬ-МАРКЕР'));
  });

  it('магазинной сборке — магазинный вариант, веб-варианта нет', async () => {
    const prefix = await stablePrefix(true);
    expect(count(prefix, STORE)).toBe(1);
    expect(prefix).not.toContain(WEB);
  });
});
