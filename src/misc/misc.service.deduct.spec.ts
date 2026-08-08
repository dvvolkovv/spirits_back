import { MiscService } from './misc.service';

/**
 * Списание токенов не должно уводить баланс в минус.
 *
 * Прямой `tokens = tokens - $1` этого не гарантировал: проверка баланса у
 * вызывающих — отдельный запрос, между ним и списанием идут секунды генерации,
 * и параллельные вызовы читают один и тот же достаточный баланс. На 2026-08-08
 * один пользователь оказался на −7 363, причём в token_transactions по нему
 * было ноль строк — прямой UPDATE их не пишет, и понять, за что списали, было
 * нельзя.
 *
 * Тесты проверяют не текст запроса, а два свойства: списание идёт через
 * процедуру (она блокирует строку, режет по остатку и пишет транзакцию), а
 * если процедуры нет — запрос обязан содержать пол.
 */

interface Call { sql: string; params: any[] }

function makeService(opts: { procResult?: any; procThrows?: boolean } = {}) {
  const calls: Call[] = [];
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      if (/consume_user_tokens/.test(sql)) {
        if (opts.procThrows) throw new Error('function does not exist');
        return { rows: [{ res: opts.procResult ?? { success: true, tokens_used: params[1] } }] };
      }
      return { rows: [] };
    }),
  };
  const svc = new MiscService(null as any, pg as any, null as any, null as any);
  return { svc, calls };
}

const procCall = (calls: Call[]) => calls.find((c) => /consume_user_tokens/.test(c.sql));
const updateCall = (calls: Call[]) => calls.find((c) => /UPDATE ai_profiles_consolidated/.test(c.sql));

describe('MiscService.deductTokens', () => {
  it('списывает через процедуру, а не прямым UPDATE', async () => {
    const { svc, calls } = makeService();
    await svc.deductTokens('u1', 5000, 'image');

    expect(procCall(calls)).toBeDefined();
    expect(procCall(calls)!.params).toEqual(['u1', 5000, 'image']);
    expect(updateCall(calls)).toBeUndefined();
  });

  it('возвращает фактически списанное, когда баланса не хватило', async () => {
    // Процедура режет по остатку: просили 5000, на счету было 1200.
    const { svc } = makeService({ procResult: { success: true, tokens_used: 1200 } });
    const used = await svc.deductTokens('u1', 5000);

    expect(used).toBe(1200);
  });

  it('разбирает ответ процедуры и в виде строки JSON', async () => {
    // Драйвер может отдать json как текст — числа из него всё равно нужны.
    const { svc } = makeService({ procResult: JSON.stringify({ tokens_used: 700 }) });
    expect(await svc.deductTokens('u1', 5000)).toBe(700);
  });

  it('если процедуры нет — запасной UPDATE обязан быть с полом', async () => {
    const { svc, calls } = makeService({ procThrows: true });
    await svc.deductTokens('u1', 5000);

    const upd = updateCall(calls);
    expect(upd).toBeDefined();
    expect(upd!.sql).toMatch(/GREATEST\(0, tokens - \$1\)/);
    // Именно этого варианта быть не должно — он и уводил в минус.
    expect(upd!.sql).not.toMatch(/SET tokens = tokens - \$1/);
  });

  it('нулевая и отрицательная сумма не трогают баланс', async () => {
    const { svc, calls } = makeService();
    expect(await svc.deductTokens('u1', 0)).toBe(0);
    expect(await svc.deductTokens('u1', -100)).toBe(0);

    expect(calls).toHaveLength(0);
  });
});
