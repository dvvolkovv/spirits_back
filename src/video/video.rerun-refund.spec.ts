/**
 * Упавшая задача-перезапуск не возвращает свою стоимость второй раз.
 *
 * Перезапуск из поддержки (SupportService.performRerun) возвращает списание
 * новой задачи сразу, с metadata.new_job_id. Если эта задача потом падает,
 * failAndRefund ставит 'failed' как обычно, но стоимость ролика уже вернули —
 * второй возврат был бы подарком.
 *
 * Предикат запроса к реестру берётся из ТЕКСТА SQL: ошибка в нём меняет ответ
 * фейка так же, как изменила бы ответ Postgres.
 */
import { VideoService } from './video.service';

type LedgerRow = { user_id: string; transaction_type: string; metadata: any };

function makeFakePg(job: Record<string, any>, ledger: LedgerRow[]) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const row = { ...job };
  const client = {
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: s, params });
      if (/UPDATE video_jobs SET status='failed'/i.test(s)) {
        if (row.status === 'failed') return { rows: [], rowCount: 0 };
        row.status = 'failed';
        return { rows: [{ image_tokens_spent: row.image_tokens_spent ?? 0 }], rowCount: 1 };
      }
      if (/FROM token_transactions/.test(s)) {
        const keys = [...s.matchAll(/metadata->>'(\w+)'\s*=\s*\$2/g)].map((m) => m[1]);
        const type = /transaction_type\s*=\s*'(\w+)'/.exec(s)?.[1];
        const hit = ledger.some((r) => r.user_id === params[0]
          && (!type || r.transaction_type === type)
          && keys.some((k) => r.metadata?.[k] === params[1]));
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    calls,
    row,
    pg: { async getClient() { return client; }, async query() { return { rows: [] }; } } as any,
  };
}

const refunds = (calls: Array<{ sql: string; params: any[] }>) =>
  calls.filter((c) => /add_user_tokens/i.test(c.sql)).map((c) => Number(c.params[1]));

describe('failAndRefund задачи-перезапуска', () => {
  const NEW_JOB = 'bbbbcccc-dddd-eeee-ffff-000011112222';
  const job = { id: NEW_JOB, user_id: 'u1', status: 'processing', tokens_spent: 3500, image_tokens_spent: 0 };
  const rerunRefund: LedgerRow = {
    user_id: 'u1', transaction_type: 'refund',
    metadata: { ticket_id: 't-1', original_job_id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111', new_job_id: NEW_JOB },
  };
  const svcWith = (pg: any) => new (VideoService as any)(pg);

  it('стоимость уже вернул перезапуск — статус failed, но второго возврата нет', async () => {
    const fake = makeFakePg(job, [rerunRefund]);
    const svc: any = svcWith(fake.pg);
    const warn = jest.spyOn(svc.logger, 'warn').mockImplementation(() => undefined);

    await svc.failAndRefund(NEW_JOB, 'u1', 3500, 'veo: render failed');

    expect(fake.row.status).toBe('failed');
    expect(refunds(fake.calls)).toEqual([]);
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/перезапуск/);
  });

  it('запрос к реестру: только возвраты и по номеру новой задачи перезапуска', async () => {
    const fake = makeFakePg(job, [rerunRefund]);
    await svcWith(fake.pg).failAndRefund(NEW_JOB, 'u1', 3500, 'veo: render failed');

    const q = fake.calls.find((c) => /FROM token_transactions/.test(c.sql))!;
    expect(q.sql).toMatch(/transaction_type = 'refund'/);
    expect(q.sql).toMatch(/metadata->>'new_job_id' = \$2/);
    expect(q.params).toEqual(['u1', NEW_JOB]);
  });

  it('кадр-заготовку перезапуск не возвращал — её возвращаем', async () => {
    const fake = makeFakePg({ ...job, image_tokens_spent: 5000 }, [rerunRefund]);
    await svcWith(fake.pg).failAndRefund(NEW_JOB, 'u1', 3500, 'veo: render failed');
    expect(refunds(fake.calls)).toEqual([5000]);
  });

  it('обычная задача (не перезапуск) возвращает стоимость как раньше', async () => {
    const fake = makeFakePg(job, []);
    await svcWith(fake.pg).failAndRefund(NEW_JOB, 'u1', 3500, 'veo: render failed');
    expect(refunds(fake.calls)).toEqual([3500]);
  });

  it('перезапуск ДРУГОЙ задачи этой не касается', async () => {
    const fake = makeFakePg(job, [{ ...rerunRefund, metadata: { ...rerunRefund.metadata, new_job_id: 'other' } }]);
    await svcWith(fake.pg).failAndRefund(NEW_JOB, 'u1', 3500, 'veo: render failed');
    expect(refunds(fake.calls)).toEqual([3500]);
  });
});
