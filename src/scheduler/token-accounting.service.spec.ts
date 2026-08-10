import { TokenAccountingService } from './token-accounting.service';

/**
 * Списание должно объяснять себя.
 *
 * Процедура consume_user_tokens принимает description и metadata с самого
 * начала (001_core_schema.sql), и платежи ими пользуются: покупка ложится в
 * историю как «Пополнение: premium» с payment_id. А чат-путь звал процедуру
 * двумя аргументами, поэтому ВСЕ consumed-строки лежали с description = NULL.
 *
 * Чем это плохо, видно на разборе 2026-08-10: у пользователя за один ход ушло
 * 862 673 токена, и в истории эта строка ничем не отличалась от соседней на
 * 3 170 — оба списания выглядели как голое отрицательное число. Ответ «за что»
 * пришлось собирать из pm2-логов и транскриптов релея.
 *
 * Имя ассистента и длительность хода известны в момент списания. Этого хватает,
 * чтобы человек отличил долгую работу от обычной реплики, не поднимая логи.
 */
describe('TokenAccountingService: списание объясняет себя', () => {
  interface Call { sql: string; params: any[] }

  function harness(task: Record<string, any>) {
    const calls: Call[] = [];
    const pg = {
      query: jest.fn(async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        if (/FROM token_consumption_tasks/.test(sql)) return { rows: [task] };
        return { rows: [] };
      }),
    };
    const svc = new TokenAccountingService(pg as any, null as any);
    return { calls, run: () => (svc as any).processTokenTasks() };
  }

  const consumeCall = (calls: Call[]) => calls.find((c) => /consume_user_tokens/.test(c.sql));

  /** Ход из разбора 2026-08-10: 24 минуты работы юриста, $239.63 расхода. */
  const longTurn = {
    id: 't-long',
    user_id: '79088644408',
    input_tokens: 0,
    output_tokens: 862673,
    tokens_to_consume: '862673',
    agent_id: 10,
    agent_name: 'Алексей',
    metadata: { costUsd: 239.6311, source: 'usage', durationMs: 1_431_000, replyChars: 26709 },
  };

  it('называет ассистента, за которого списали', async () => {
    const h = harness(longTurn);
    await h.run();

    expect(consumeCall(h.calls)!.params[2]).toContain('Алексей');
  });

  it('показывает длительность хода — по ней видно, что работа была долгой', async () => {
    const h = harness(longTurn);
    await h.run();

    expect(consumeCall(h.calls)!.params[2]).toContain('24 мин');
  });

  it('короткую реплику длительностью не подписывает', async () => {
    // Иначе «0 мин» будет висеть у каждой второй строки и обесценит признак.
    const h = harness({ ...longTurn, metadata: { costUsd: 0.2, durationMs: 12_000 } });
    await h.run();

    expect(consumeCall(h.calls)!.params[2]).toContain('Алексей');
    expect(consumeCall(h.calls)!.params[2]).not.toContain('мин');
  });

  it('переносит в транзакцию себестоимость хода', async () => {
    const h = harness(longTurn);
    await h.run();

    expect(JSON.parse(consumeCall(h.calls)!.params[3])).toMatchObject({
      costUsd: 239.6311,
      source: 'usage',
    });
  });

  it('без метаданных и без имени ассистента описание всё равно не пустое', async () => {
    // Старые строки в очереди и SMM-путь метаданных не пишут. Пустой
    // description вернул бы ровно ту дыру, ради которой всё затевалось.
    const h = harness({
      id: 't-bare', user_id: 'u1', input_tokens: 0, output_tokens: 100,
      tokens_to_consume: '100', agent_id: null, agent_name: null, metadata: null,
    });
    await h.run();

    expect(consumeCall(h.calls)!.params[2]).toBeTruthy();
    expect(consumeCall(h.calls)!.params[3]).toBeNull();
  });

  it('сумма списания не зависит от появления описания', async () => {
    // Описание — приписка к строке, а не новый вход в расчёт.
    const h = harness(longTurn);
    await h.run();

    expect(consumeCall(h.calls)!.params.slice(0, 2)).toEqual(['79088644408', 862673]);
  });
});
