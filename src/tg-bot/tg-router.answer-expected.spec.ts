import { TgRouterService } from './tg-router.service';

/**
 * Отметка «ответ обязателен».
 *
 * persistUserMessage сохраняет КАЖДОЕ входящее сообщение, включая те, которые
 * бот игнорирует намеренно, поэтому детектор зависших чатов не может опираться
 * на «user-строка без assistant-строки». Отметку ставит сам бот в момент, когда
 * решение отвечать уже принято.
 */

function makeRouter() {
  const pg = { query: jest.fn(async (_sql: string, _params?: any[]) => ({ rows: [] })) };
  const svc = new TgRouterService(pg as any, null as any, null as any, null as any, null as any);
  return { svc, pg };
}

describe('TgRouterService.markAnswerExpected', () => {
  it('помечает конкретное user-сообщение чата', async () => {
    const { svc, pg } = makeRouter();

    await svc.markAnswerExpected(-100123, 4242);

    const [sql, params] = pg.query.mock.calls[0];
    expect(sql).toContain('answer_expected_at = now()');
    expect(params).toEqual([-100123, 4242]);
  });

  it('не трогает assistant-строки: иначе ответ бота сам себя пометил бы как ожидающий', async () => {
    const { svc, pg } = makeRouter();

    await svc.markAnswerExpected(-100123, 4242);

    expect(pg.query.mock.calls[0][0]).toContain("role = 'user'");
  });
});
