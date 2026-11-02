import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Шлагбаум нуля в streamChat (общая точка входа, ДО разбора на путь релея
 * или Машу, chat.service.ts ~1164–1181): balance <= 0 — ответ-заглушка на
 * языке пользователя, событие end несёт reason: 'no_tokens', и ни релей
 * (streamUniversalAgent → axios.post), ни локальный CLI Маши не вызываются
 * вовсе — гейт возвращает раньше, чем код решает, какой это агент.
 *
 * Минимальный харнес: resolveAgent подменён напрямую (jest.spyOn), как в
 * chat.service.masha-*.spec.ts — поднимать весь streamChat через настоящий
 * SQL таблицы agents незачем, гейт по балансу решается раньше любого из них.
 */
function makeService() {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 0 }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    undefined,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 7, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'assistant',
  });
  return { svc };
}

function makeRes() {
  const writes: any[] = [];
  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { writes.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
  };
  return { res, writes };
}

// Не «привет»/«hello»/«hi» — иначе isGreetingMsg пропускает гейт вовсе
// (первое приветствие не спрашивает баланс), и сценарий «ноль» не наступит.
const RU_MESSAGE = 'что у меня с балансом';
const EN_MESSAGE = 'tell me about my balance please';

describe('ChatService.streamChat — шлагбаум нуля (balance <= 0)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('событие end несёт reason: no_tokens', async () => {
    const { svc } = makeService();
    const { res, writes } = makeRes();
    await svc.streamChat('u1', RU_MESSAGE, '7', 'u1_7', '', res);
    const end = writes.find((w) => w.type === 'end');
    expect(end).toBeDefined();
    expect(end.reason).toBe('no_tokens');
  });

  it('текст — на языке запроса (requestLang), не всегда по-русски', async () => {
    const { svc } = makeService();
    const { res, writes } = makeRes();
    await svc.streamChat('u1', EN_MESSAGE, '7', 'u1_7', '', res, undefined, false, 'en');
    const end = writes.find((w) => w.type === 'end');
    expect(end.content).toContain('Out of tokens');
    expect(end.content).not.toMatch(/[а-яё]/i);
  });

  it('магазинная сборка (storeBuild) — нейтральный текст без «токенов»/«баланса» и без ссылки', async () => {
    const { svc } = makeService();
    const { res, writes } = makeRes();
    await svc.streamChat(
      'u1', RU_MESSAGE, '7', 'u1_7', '', res,
      undefined, false, undefined, undefined, true /* storeBuild */,
    );
    const end = writes.find((w) => w.type === 'end');
    expect(end.content).not.toMatch(/токен|баланс/i);
    expect(end.content).not.toContain('http');
  });

  it('релей не вызывается — гейт возвращает раньше, чем код решает путь агента', async () => {
    const { svc } = makeService();
    const { res } = makeRes();
    await svc.streamChat('u1', RU_MESSAGE, '7', 'u1_7', '', res);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
