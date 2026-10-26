import {
  MAX_STAGE_ATTEMPTS,
  STAGE_LEASE_MINUTES,
  StageFatalError,
  claimStage,
  stageFailed,
  withStageDeadline,
} from './short-jobs';

function pg(rows: any[] = [], rowCount = 1) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount };
    }),
  };
}

const video = (attempts: number) => ({ id: 'v1', status: 'directing', attempts }) as any;

describe('claimStage', () => {
  it('берёт свободный по аренде ролик и считает попытку', async () => {
    const p = pg([{ id: 'v1', status: 'directing', attempts: 1, rubric: 'assistant', angle: 'calm', source: 'manual', topic_key: 't' }]);
    const got = await claimStage(p, 'directing');
    expect(got?.id).toBe('v1');
    const claim = p.calls[1];
    expect(claim.sql).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(claim.sql).toMatch(/attempts = attempts \+ 1/);
    expect(claim.sql).toMatch(/attempts < \$3/);
    expect(claim.params).toEqual(['directing', STAGE_LEASE_MINUTES, MAX_STAGE_ATTEMPTS]);
  });

  it('нечего брать — null', async () => {
    expect(await claimStage(pg([]), 'writing')).toBeNull();
  });

  it('до захвата зависшая последняя попытка уходит в failed с подписью этапа', async () => {
    const p = pg([]);
    await claimStage(p, 'writing');
    expect(p.calls).toHaveLength(2);
    const [stuck, claim] = p.calls;
    expect(stuck.sql).toMatch(/status = 'failed', failed_from = status/);
    expect(stuck.sql).toMatch(/failure_notified = false/);
    expect(stuck.sql).toMatch(/attempts >= \$2/);
    expect(stuck.sql).toMatch(/lease_until < now\(\)/);
    expect(stuck.params).toEqual([
      'writing',
      MAX_STAGE_ATTEMPTS,
      'сценарист: этап не завершился за аренду — процесс упал или релей завис',
    ]);
    expect(claim.sql).toMatch(/FOR UPDATE SKIP LOCKED/);

    const d = pg([]);
    await claimStage(d, 'directing');
    expect(d.calls[0].params[2]).toBe('режиссёр: этап не завершился за аренду — процесс упал или релей завис');
  });
});

describe('stageFailed', () => {
  it('первая неудача — повтор через минуту, вторая — через десять; запись привязана к номеру захвата', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'режиссёр', new Error('релей молчит'))).toBe('retry');
    expect(p.calls[0].sql).toMatch(/AND attempts = \$5/);
    expect(p.calls[0].params).toEqual(['v1', 'directing', 60, 'режиссёр: релей молчит', 1]);
    await stageFailed(p, video(2), 'режиссёр', new Error('релей молчит'));
    expect(p.calls[1].params[2]).toBe(600);
    expect(p.calls[1].params[4]).toBe(2);
  });

  it('третья неудача — failed с этапом, сообщение владельцу ещё не ушло', async () => {
    const p = pg();
    expect(await stageFailed(p, video(3), 'режиссёр', new Error('релей молчит'))).toBe('failed');
    expect(p.calls[0].sql).toMatch(/status = 'failed', failed_from = \$2/);
    expect(p.calls[0].sql).toMatch(/failure_notified = false/);
    expect(p.calls[0].sql).toMatch(/AND attempts = \$4/);
    expect(p.calls[0].params).toEqual(['v1', 'directing', 'режиссёр: релей молчит', 3]);
  });

  it('StageFatalError — сразу failed, без повторов', async () => {
    const p = pg();
    expect(await stageFailed(p, video(1), 'сценарист', new StageFatalError('правила не прошли'))).toBe('failed');
  });

  it('ролик ушёл с этапа или его забрал другой процесс — gone, больше ничего не пишется', async () => {
    const retry = pg([], 0);
    expect(await stageFailed(retry, video(1), 'режиссёр', new Error('поздно'))).toBe('gone');
    expect(retry.calls).toHaveLength(1);
    const last = pg([], 0);
    expect(await stageFailed(last, video(3), 'режиссёр', new Error('поздно'))).toBe('gone');
    expect(last.calls).toHaveLength(1);
  });

  it('подпись этапа, уже стоящая в ошибке, не дублируется', async () => {
    const p = pg();
    await stageFailed(p, video(1), 'режиссёр', new StageFatalError('режиссёр: нет ассистента'));
    expect(p.calls[0].params[2]).toBe('режиссёр: нет ассистента');
  });

  it('ошибка обрезается до 1000 символов, а не единиц UTF-16', async () => {
    const p = pg();
    await stageFailed(p, video(1), 'сценарист', new Error('😀'.repeat(1500)));
    const saved: string = p.calls[0].params[3];
    expect(Array.from(saved)).toHaveLength(1000);
    expect(saved.endsWith('😀')).toBe(true);
  });
});

describe('withStageDeadline', () => {
  it('успел — его результат', async () => {
    await expect(withStageDeadline(async () => 'готово', 50)).resolves.toBe('готово');
  });

  it('не успел — отказ с текстом про срок', async () => {
    await expect(withStageDeadline(() => new Promise<never>(() => {}), 20)).rejects.toThrow(/этап не уложился в 20 мс/);
  });

  it('поздний отказ исходного вызова после срока не становится необработанным', async () => {
    // Необработанный отказ jest-circus засчитал бы ошибкой этого теста.
    let fail: (e: Error) => void;
    const late = new Promise<never>((_, reject) => {
      fail = reject;
    });
    await expect(withStageDeadline(() => late, 20)).rejects.toThrow(/не уложился/);
    fail(new Error('релей ответил ошибкой после срока'));
    await new Promise((r) => setTimeout(r, 50));
  });
});
