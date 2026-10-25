import { STAGE_LEASE_MINUTES, StageFatalError, claimStage, stageFailed } from './short-jobs';

function pg(rows: any[] = []) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: 1 };
    }),
  };
}

const video = (attempts: number) => ({ id: 'v1', status: 'directing', attempts }) as any;

describe('claimStage', () => {
  it('берёт свободный по аренде ролик и считает попытку', async () => {
    const p = pg([{ id: 'v1', status: 'directing', attempts: 1, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't' }]);
    const got = await claimStage(p, 'directing');
    expect(got?.id).toBe('v1');
    expect(p.calls[0].sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(p.calls[0].sql).toMatch(/attempts = attempts \+ 1/);
    expect(p.calls[0].params).toEqual(['directing', STAGE_LEASE_MINUTES]);
  });

  it('нечего брать — null', async () => {
    expect(await claimStage(pg([]), 'writing')).toBeNull();
  });
});

describe('stageFailed', () => {
  it('первая неудача — повтор через минуту, вторая — через десять', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'режиссёр', new Error('релей молчит'))).toBe('retry');
    expect(p.calls[0].params).toEqual(['v1', 'directing', 60, 'режиссёр: релей молчит']);
    await stageFailed(p, video(2), 'режиссёр', new Error('релей молчит'));
    expect(p.calls[1].params[2]).toBe(600);
  });

  it('третья неудача — failed с этапом, сообщение владельцу ещё не ушло', async () => {
    const p = pg();
    expect(await stageFailed(p, video(3), 'режиссёр', new Error('релей молчит'))).toBe('failed');
    expect(p.calls[0].sql).toMatch(/status = 'failed', failed_from = \$2/);
    expect(p.calls[0].sql).toMatch(/failure_notified = false/);
    expect(p.calls[0].params).toEqual(['v1', 'directing', 'режиссёр: релей молчит']);
  });

  it('StageFatalError — сразу failed, без повторов', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'сценарист', new StageFatalError('правила не прошли'))).toBe('failed');
  });
});
