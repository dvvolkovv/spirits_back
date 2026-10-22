import { ChatService } from './chat.service';
import { SEAT_TOKENS_PER_USD } from '../common/billing-rates';
import { sendTelegramAlert } from '../common/telegram-alert';

jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

const mockedAlert = sendTelegramAlert as jest.Mock;

/**
 * Ход Маши (agent.id === 3) идёт не через релей, а локальным claude CLI, и
 * списывается в своей ветке streamChat: `outputTokens = ceil(costUsd × курс)`,
 * затем в setImmediate — история и addTokenTask. В двух других точках списания
 * веб-чата (обычный ход, persistUploadTurn) сразу за списанием стоят «Дорогой
 * ход» и сторож роста стоимости — а здесь не стояло ни того, ни другого.
 *
 * Решение владельца 15.10.2026 (спека 2026-10-14-cost-growth-alert, дополнение
 * «путь Маши»): оба — сразу после успешного addTokenTask, расклад
 * `cost=$… (локальный CLI)`, токены — списанные, стоимость — costUsd.
 *
 * Ожидания выводятся из курса SEAT_TOKENS_PER_USD, а не зашиты числами: смена
 * курса не должна красить тест, ничего не сказав о проводке.
 */

const USER = 'u-masha';
const BALANCE = 100_000;
const forUsd = (usd: number) => Math.ceil(usd * SEAT_TOKENS_PER_USD);
const usdFor = (tokens: number) => tokens / SEAT_TOKENS_PER_USD;

type Calls = { sql: string; params: any[] }[];

function makeService(o: {
  cli?: () => Promise<{ text: string; costUsd: number }>;
  /** Запрос остатка в алерте бросает синхронно — после того, как списание записано. */
  balanceThrowsAfterBilling?: boolean;
  neo4j?: any;
} = {}) {
  const calls: Calls = [];
  let billed = false;
  const pg = {
    // Не async: так можно бросить синхронно, мимо .catch внутри алерта.
    query: jest.fn((sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/INSERT INTO token_consumption_tasks/.test(sql)) billed = true;
      if (sql.includes('SELECT tokens FROM ai_profiles_consolidated')) {
        if (billed && o.balanceThrowsAfterBilling) throw new Error('pool is closed');
        return Promise.resolve({ rows: [{ tokens: BALANCE }] });
      }
      if (sql.includes('FROM agents a')) {
        return Promise.resolve({
          rows: [{ name: 'Роман', display_name: 'Роман', description: 'бизнес', system_prompt: '' }],
        });
      }
      return Promise.resolve({ rows: [] });
    }),
  };
  const claudeCli = {
    textWithCost: jest.fn(o.cli ?? (async () => ({ text: 'Давай разберём это вместе.', costUsd: 0.5 }))),
  };
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  const svc = new ChatService(
    pg as any,
    (o.neo4j ?? undefined) as any,
    {} as any, // tools
    claudeCli as any,
    language as any,
    balanceCtx as any,
  );
  jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
    id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
  });
  // История — не предмет этих проверок. Списание (addTokenTask) настоящее:
  // сторож обязан получить ровно то число, что легло в token_consumption_tasks.
  jest.spyOn(svc as any, 'saveChatHistory').mockResolvedValue(undefined);
  // Сторож — последний @Optional-параметр конструктора; подставляем после сборки.
  const costGrowth = { recordTurn: jest.fn(async (..._args: any[]) => {}) };
  (svc as any).costGrowth = costGrowth;
  return { svc, calls, costGrowth, claudeCli };
}

async function runMasha(svc: ChatService) {
  const res: any = {
    status: jest.fn(() => res),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    json: jest.fn(),
  };
  await svc.streamChat(USER, 'Мне тревожно перед встречей', '3', `${USER}_3`, 'Имя: Тест', res);
  // Списание и всё за ним — в setImmediate; даём хвосту добежать.
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

const billingRow = (calls: Calls) => calls.find((c) => /INSERT INTO token_consumption_tasks/.test(c.sql));
const billedTokens = (calls: Calls) => {
  const [, , , inputTokens, outputTokens] = billingRow(calls)!.params;
  return Number(inputTokens) + Number(outputTokens);
};
const expensiveAlerts = () => mockedAlert.mock.calls.filter((c) => String(c[0]).includes('Дорогой ход'));

describe('Маша (локальный CLI): «Дорогой ход» и сторож роста стоимости', () => {
  const OLD_SECRET = process.env.JWT_SECRET;
  const OLD_DS = process.env.DEEPSEEK_API_KEY;
  beforeAll(() => {
    // Токен инструмента продуктов подписывается этим секретом.
    process.env.JWT_SECRET = 'test-secret-for-product-tool';
    // Иначе первый ход мог бы уйти приветствием в DeepSeek, мимо CLI.
    delete process.env.DEEPSEEK_API_KEY;
  });
  afterAll(() => {
    process.env.JWT_SECRET = OLD_SECRET;
    if (OLD_DS === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = OLD_DS;
  });
  afterEach(() => {
    jest.clearAllMocks();
    // Неизрасходованный mockImplementationOnce не должен перетечь в соседний тест.
    mockedAlert.mockReset().mockImplementation(async () => {});
  });

  it('обычный ход: в сторож уходит пара с именем Маши и ровно списанное', async () => {
    const { svc, calls, costGrowth, claudeCli } = makeService();

    await runMasha(svc);

    expect(claudeCli.textWithCost).toHaveBeenCalledTimes(1);
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [pair, turn, ctx] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(pair).toEqual({ kind: 'chat', userId: USER, assistantId: '3', assistantName: 'Маша' });
    expect(turn.tokens).toBe(forUsd(0.5));
    // Ровно то, что ушло в списание: сторож смотрит на то же число, что видит юзер.
    expect(turn.tokens).toBe(billedTokens(calls));
    expect(turn.usd).toBeCloseTo(0.5, 6);
    expect(turn.note).toContain('локальный CLI');
    expect(turn.note).toContain('cost=$0.5000');
    // Баланс — геттер: в базу за ним ходят, только когда алерт сработал.
    expect(await ctx.balance()).toBe(BALANCE);
    // Ход ниже порога «Дорогого хода» не будит.
    expect(forUsd(0.5)).toBeLessThan(30_000);
    expect(expensiveAlerts()).toHaveLength(0);
  });

  it('ход на 30 тыс. списанных токенов будит «Дорогим ходом» с раскладом локального CLI', async () => {
    const usd = usdFor(30_000);
    const { svc, calls, costGrowth } = makeService({
      cli: async () => ({ text: 'Длинный разбор.', costUsd: usd }),
    });

    await runMasha(svc);

    expect(billedTokens(calls)).toBeGreaterThanOrEqual(30_000);
    expect(expensiveAlerts()).toHaveLength(1);
    const text = String(expensiveAlerts()[0][0]);
    expect(text).toContain(USER);
    expect(text).toContain('ассистент 3');
    expect(text).toContain('локальный CLI');
    expect(text).toContain(`списано ${billedTokens(calls).toLocaleString('ru')} токенов`);
    // И сторож получает тот же ход.
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
  });

  it('CLI упал: списано 0 — алерта нет, сторож получает ход с нулём и пропускает его сам', async () => {
    // Ветка Маши при сбое CLI отвечает заглушкой и всё равно пишет строку
    // списания — с нулями (так было и до этой правки). Сторож вызывается за ней
    // с tokens=0: CostGrowthService.recordTurn такой ход отбрасывает первой
    // строкой (`!(turn.tokens > 0)`), см. спеку, дополнение 15.10.
    const { svc, calls, costGrowth } = makeService({
      cli: async () => { throw new Error('claude CLI exited with code 1: boom'); },
    });

    await runMasha(svc);

    expect(billingRow(calls)).toBeDefined();
    expect(billedTokens(calls)).toBe(0);
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    const [, turn] = costGrowth.recordTurn.mock.calls[0] as any[];
    expect(turn.tokens).toBe(0);
    expect(turn.usd).toBe(0);
    expect(expensiveAlerts()).toHaveLength(0);
  });

  it('Telegram не ответил — сторож и обучение профиля после хода всё равно отработали', async () => {
    mockedAlert.mockImplementationOnce(async () => { throw new Error('ETIMEDOUT'); });
    const neo4j = { consolidateFromChat: jest.fn(async () => {}) };
    const { svc, costGrowth } = makeService({
      cli: async () => ({ text: 'Длинный разбор.', costUsd: usdFor(40_000) }),
      neo4j,
    });

    await runMasha(svc);

    expect(expensiveAlerts()).toHaveLength(1);
    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    expect(neo4j.consolidateFromChat).toHaveBeenCalledTimes(1);
  });

  it('алерт сам упал (остаток не прочитать) — хвост хода не теряется', async () => {
    // Хвост хода Маши — один try/catch: исключение из алерта пропустило бы
    // сторож, обучение профиля, задачи и бизнес-карточку. Алерт — сбоку от
    // хода и не имеет права его обрывать.
    const neo4j = { consolidateFromChat: jest.fn(async () => {}) };
    const { svc, costGrowth } = makeService({
      cli: async () => ({ text: 'Длинный разбор.', costUsd: usdFor(40_000) }),
      balanceThrowsAfterBilling: true,
      neo4j,
    });

    await runMasha(svc);

    expect(costGrowth.recordTurn).toHaveBeenCalledTimes(1);
    expect(neo4j.consolidateFromChat).toHaveBeenCalledTimes(1);
  });
});
