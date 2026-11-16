jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));
import { SupportService } from './support.service';

/// Системное сообщение о начислении в переписке тикета: слово «токен»
/// согласовано с числом.
///
/// Повод — возврат по тикету 16.11.2026: человек прочёл «Начислено 6 444
/// токенов». Шаблон ставил «токенов» после любого числа. Сообщение пишут два
/// пути — возврат ИИ-поддержки (refund_tokens) и возврат рукой владельца, —
/// проверяются оба.

const TICKET = 't-notice';
const USER = 'u-notice';
const OWNER = 'u-owner';

function makeWorld() {
  const messages: string[] = [];
  let balance = 0;

  const run = (sql: string, params: any[] = []) => {
    if (/FROM support_tickets WHERE id/.test(sql)) {
      return { rows: [{ user_id: USER }], rowCount: 1 };
    }
    if (/FROM ai_profiles_consolidated WHERE user_id = \$1 FOR UPDATE/.test(sql)) {
      return { rows: [{ '?column?': 1 }], rowCount: 1 };
    }
    if (/add_user_tokens/.test(sql)) {
      balance += Number(params[1]);
      return { rows: [{ res: { new_balance: balance } }], rowCount: 1 };
    }
    if (/INSERT INTO support_messages/.test(sql)) {
      messages.push(params[3]);
      return { rows: [{ id: `m${messages.length}` }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => run(sql, params)),
    getClient: jest.fn(async () => ({
      query: jest.fn(async (sql: string, params: any[] = []) => run(sql, params)),
      release: jest.fn(),
    })),
  };
  const svc = new SupportService(pg as any, {} as any, {} as any, {} as any, {} as any, {} as any);
  return { svc, messages };
}

// Разряды toLocaleString разделяет неразрывным пробелом — отсюда «.» в «6.444».
// Точка после слова не даёт «токена» совпасть с началом «токенов».
const CASES: Array<[number, RegExp]> = [
  [1, /Начислено 1 токен\./],
  [21, /Начислено 21 токен\./],
  [2, /Начислено 2 токена\./],
  [6_444, /Начислено 6.444 токена\./],
  [11, /Начислено 11 токенов\./],
  [112, /Начислено 112 токенов\./],
  [5_000, /Начислено 5.000 токенов\./],
];

describe('сообщение о начислении: слово согласовано с числом', () => {
  it.each(CASES)('возврат ИИ-поддержки, %p', async (amount, expected) => {
    const w = makeWorld();

    const out = await (w.svc as any).performRefund(TICKET, USER, { amount, reason: 'тест' });

    expect(out).toEqual(expect.objectContaining({ ok: true, amount }));
    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toMatch(expected);
  });

  it.each(CASES)('возврат рукой владельца, %p', async (amount, expected) => {
    const w = makeWorld();

    await w.svc.ownerRefund(TICKET, OWNER, amount, 'тест');

    expect(w.messages).toHaveLength(1);
    expect(w.messages[0]).toMatch(expected);
  });
});
