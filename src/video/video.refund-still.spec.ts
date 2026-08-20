/**
 * Провалившееся видео возвращает и стоимость кадра-заготовки.
 *
 * text2video без картинки идёт цепочкой: сначала Nano Banana рисует кадр
 * (списание 'image'), потом Kling анимирует его. Возврат при провале Kling
 * отдавал только стоимость самого ролика — 20.08.2026 боевая проверка это и
 * показала: у Kling кончились деньги, ролика не случилось, а 5 000 токенов за
 * заготовку остались списанными. Человек просил видео, не получил ничего и
 * всё равно заплатил.
 *
 * Решение владельца — возвращать и заготовку. Отсюда два свойства:
 * возврат равен полной сумме (ролик + кадр), и повторный вызов ничего не
 * возвращает второй раз.
 */
import { VideoService } from './video.service';

type Row = Record<string, any>;

function makeFakePg(job: Row) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const jobs = new Map<string, Row>([[job.id, { ...job }]]);

  const client = {
    async query(sql: string, params: any[] = []) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      // Пометка «провалено» — идемпотентная: второй раз строк не вернёт.
      if (/UPDATE video_jobs SET status='failed'/i.test(sql)) {
        const row = jobs.get(params[1]);
        if (!row || row.status === 'failed') return { rows: [], rowCount: 0 };
        row.status = 'failed';
        return { rows: [{ image_tokens_spent: row.image_tokens_spent ?? 0 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };

  return {
    calls,
    pg: { async getClient() { return client; }, async query() { return { rows: [] }; } } as any,
  };
}

/** Возвраты, ушедшие через add_user_tokens. */
function refunds(calls: Array<{ sql: string; params: any[] }>) {
  return calls.filter((c) => /add_user_tokens/i.test(c.sql)).map((c) => Number(c.params[1]));
}

describe('VideoService.failAndRefund', () => {
  const job = { id: 'job-1', user_id: 'u1', status: 'processing', tokens_spent: 25000, image_tokens_spent: 5000 };

  const svcWith = (pg: any) => {
    const svc: any = new (VideoService as any)(pg);
    return svc;
  };

  it('возвращает и ролик, и кадр-заготовку одной суммой', async () => {
    const fake = makeFakePg(job);
    await svcWith(fake.pg).failAndRefund('job-1', 'u1', 25000, 'kling: no balance');

    expect(refunds(fake.calls)).toEqual([30000]);
  });

  it('без заготовки возвращает только стоимость ролика', async () => {
    const fake = makeFakePg({ ...job, image_tokens_spent: 0 });
    await svcWith(fake.pg).failAndRefund('job-1', 'u1', 25000, 'kling: no balance');

    expect(refunds(fake.calls)).toEqual([25000]);
  });

  it('повторный вызов не возвращает деньги второй раз', async () => {
    const fake = makeFakePg(job);
    const svc = svcWith(fake.pg);

    await svc.failAndRefund('job-1', 'u1', 25000, 'kling: no balance');
    await svc.failAndRefund('job-1', 'u1', 25000, 'kling: no balance');

    expect(refunds(fake.calls)).toEqual([30000]);
  });

  it('возврат идёт через процедуру, а не прямым UPDATE баланса', async () => {
    const fake = makeFakePg(job);
    await svcWith(fake.pg).failAndRefund('job-1', 'u1', 25000, 'kling: no balance');

    expect(fake.calls.some((c) => /tokens\s*=\s*tokens\s*\+/i.test(c.sql))).toBe(false);
    const credit = fake.calls.find((c) => /add_user_tokens/i.test(c.sql))!;
    expect(credit.sql).toMatch(/'refund'/);
  });
});
