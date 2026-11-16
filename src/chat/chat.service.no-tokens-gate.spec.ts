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
const PAST_GATE = 'ход прошёл мимо шлагбаума нуля';

function makeService(tokens = 0) {
  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens }] };
      return { rows: [] };
    }),
  };
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
  // Блок баланса для промпта собирается сразу за шлагбаумом: дошёл ход до
  // него — шлагбаум ход пропустил, и тест падает с понятной причиной.
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => { throw new Error(PAST_GATE); }) };
  const svc = new ChatService(
    pg as any, null as any, null as any, null as any, language as any,
    balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 7, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'assistant',
  });
  return { svc, balanceCtx };
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

// Обычные реплики; приветствия в пустом чате на нуле — отдельный блок ниже.
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

/**
 * Приветствие в пустом чате (тикет 8cf1c5ae). Прежде первое сообщение со словом
 * из правила isGreetingMsg (/привет|расскажи про себя|hello|hi$/i) проходило
 * шлагбаум без проверки баланса: на нуле модель отвечала полностью, а списание
 * упиралось в ноль. «Чистый лист» даёт пустой чат сколько угодно раз — выходили
 * бесплатные ходы. Автоприветствие старых вкладок отвечает сторож
 * legacy-greeting.ts раньше шлагбаума, так что обход больше никому не нужен.
 */
describe('ChatService.streamChat — приветствие в пустом чате и шлагбаум нуля', () => {
  beforeEach(() => jest.clearAllMocks());

  it.each([
    'привет, составь мне бизнес-план на год',
    'Расскажи про себя и напиши эссе',
    'Hello! Write me a long essay',
    'write me a poem, hi',
  ])('«%s» на нуле → no_tokens, релей не вызывается', async (message) => {
    const { svc } = makeService(0);
    const { res, writes } = makeRes();
    await svc.streamChat('u1', message, '7', 'u1_7', '', res);
    const end = writes.find((w) => w.type === 'end');
    expect(end?.reason).toBe('no_tokens');
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('при положительном балансе приветствие проходит, и блок баланса получает isGreeting', async () => {
    const { svc, balanceCtx } = makeService(5000);
    const { res } = makeRes();
    await svc.streamChat('u1', 'привет', '7', 'u1_7', '', res).catch(() => {});
    expect(balanceCtx.buildContextForPrompt).toHaveBeenCalledWith(
      'u1', 5000, expect.objectContaining({ isGreeting: true }),
    );
  });
});
