/**
 * Лента сессий раздела «Звонки»: по строке на звонок или встречу.
 *
 * Что здесь закреплено:
 *  - лента и её total считаются по тому же условию, что таблица: разойдясь,
 *    они показали бы «показано 50 из 131», когда над таблицей 140;
 *  - расшифровка в ленту не едет: она тяжёлая и нужна по клику;
 *  - списание разложено так же, как в таблице: разговор + консультации;
 *  - сорвавшаяся встреча помечена сбоем, а не молчанием.
 */
import { AdminService } from './admin.service';

const FEED_Q = /ORDER BY c\.started_at DESC, c\.id DESC/i;
const TOTAL_Q = /COUNT\(\*\)::int AS total/i;

/** Внешнее условие запроса — то, что после WHERE у voice_calls c. */
const outerWhere = (sql: string) =>
  sql.match(/FROM voice_calls c(?: LEFT JOIN agents a ON a\.id = c\.agent_id)? WHERE (.*?)(?: GROUP BY | ORDER BY | LIMIT |$)/)?.[1];

/** Фейковый pg: лента отдаёт rows, счётчик — total; запоминает SQL и параметры. */
function makePg(rows: any[], total: number) {
  const calls: Array<[string, any[] | undefined]> = [];
  return {
    calls,
    async query(sql: string, params?: any[]) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      calls.push([flat, params]);
      if (FEED_Q.test(flat)) return { rows };
      if (TOTAL_Q.test(flat)) return { rows: [{ total }] };
      return { rows: [] };
    },
  };
}

const service = (pg: any) => new (AdminService as any)(pg);

const ZOOM_OK = {
  id: 'c-1', user_id: '79236230446', provider: 'zoom', agent_name: 'Роман',
  started_at: '2026-09-16T09:46:31Z', duration_sec: 117, status: 'completed',
  model: 'gpt-realtime-2.1', summary: 'Обсуждали погоду',
  transcript: [
    { ts: 1, role: 'assistant', text: 'Здравствуйте' },
    { ts: 2, role: 'user', text: 'Какая погода?' },
    { ts: 3, role: 'user', text: 'В Москве' },
    { ts: 4, role: 'user', text: 'Спасибо' },
  ],
  tokens_charged: 6241, tokens_consult: '1100', consults: 2,
};

const TELEMOST_FAILED = {
  id: 'c-2', user_id: '79030169187', provider: 'telemost', agent_name: 'Роман',
  started_at: '2026-09-22T10:00:00Z', duration_sec: null, status: 'failed', model: null,
  summary: 'Звонок не состоялся: бот Attendee: fatal_error (could_not_join_meeting)',
  transcript: null, tokens_charged: 0, tokens_consult: '0', consults: 0,
};

describe('AdminService.getCallSessions', () => {
  it('сессия несёт площадку, ассистента и списание по частям', async () => {
    const res = await service(makePg([ZOOM_OK], 1)).getCallSessions({ kind: 'all' });

    expect(res.sessions[0]).toMatchObject({
      id: 'c-1', provider: 'zoom', agent_name: 'Роман',
      tokens_call: 6241, tokens_consult: 1100, tokens_total: 7341, consults: 2,
      user_turns: 3, flags: [],
    });
  });

  it('расшифровка в ленту не едет', async () => {
    const res = await service(makePg([ZOOM_OK], 1)).getCallSessions({});
    expect(res.sessions[0]).not.toHaveProperty('transcript');
  });

  it('сорвавшаяся встреча помечена сбоем', async () => {
    const res = await service(makePg([TELEMOST_FAILED], 1)).getCallSessions({ kind: 'meeting' });
    expect(res.sessions[0].flags).toEqual(['failed']);
  });

  it('лента и её total считаются по одному условию', async () => {
    const pg = makePg([ZOOM_OK], 131);
    const res = await service(pg).getCallSessions({ kind: 'meeting', provider: 'zoom', includeTest: true });

    const feed = pg.calls.find(([s]) => FEED_Q.test(s))!;
    const total = pg.calls.find(([s]) => TOTAL_Q.test(s))!;
    expect(outerWhere(feed[0])).toMatch(/c\.provider <> 'linkeon'/);
    expect(outerWhere(feed[0])).toBe(outerWhere(total[0]));
    expect(feed[1]).toEqual(total[1]);
    expect(feed[1]).toEqual([30, 'zoom']);
    expect(res.total).toBe(131);
  });

  it('тестовые аккаунты исключены, пока их не попросили', async () => {
    const pg = makePg([], 0);
    await service(pg).getCallSessions({});
    expect(pg.calls[0][0]).toMatch(/c\.user_id <> ALL/);

    const pg2 = makePg([], 0);
    const res = await service(pg2).getCallSessions({ includeTest: true });
    expect(pg2.calls[0][0]).not.toMatch(/c\.user_id <> ALL/);
    expect(res.include_test).toBe(true);
  });

  it('лимит: по умолчанию 50, прижат к 1…500, нечисло даёт 50', async () => {
    const limitOf = async (limit?: number) => {
      const pg = makePg([], 0);
      const res = await service(pg).getCallSessions({ limit });
      const feed = pg.calls.find(([s]) => FEED_Q.test(s))!;
      return { echoed: res.limit, sql: feed[0].match(/LIMIT (\d+)/)?.[1] };
    };
    expect(await limitOf(undefined)).toEqual({ echoed: 50, sql: '50' });
    expect(await limitOf(0)).toEqual({ echoed: 1, sql: '1' });
    expect(await limitOf(9999)).toEqual({ echoed: 500, sql: '500' });
    expect(await limitOf(NaN)).toEqual({ echoed: 50, sql: '50' });
  });

  it('ассистент подтянут из agents, консультации — по call_id', async () => {
    const pg = makePg([], 0);
    await service(pg).getCallSessions({});
    const feed = pg.calls.find(([s]) => FEED_Q.test(s))!;
    expect(feed[0]).toMatch(/LEFT JOIN agents a ON a\.id = c\.agent_id/);
    expect(feed[0]).toMatch(/call_id = c\.id/);
  });
});
