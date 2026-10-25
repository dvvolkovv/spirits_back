import { SupportService } from './support.service';

/// Перезапуск упавшего видео из поддержки: сколько токенов возвращается.
///
/// Перезапуск бесплатен для человека: новое списание createJob обнуляется
/// возвратом. Стоимость ИСХОДНОЙ задачи возвращается только если её ещё не
/// вернули. Упавшая задача почти всегда уже получила возврат в момент провала
/// (VideoService.failAndRefund ставит 'failed' и начисляет 'refund' с
/// metadata.job_id одной транзакцией) — и прежняя редакция performRerun
/// возвращала её стоимость второй раз, мимо лимитов возврата.
///
/// «База» здесь — журнал token_transactions в памяти: тест спрашивает его так
/// же, как спросит сервис, и смотрит, какую сумму сервис начислил.

const USER = 'u-rerun';
const TICKET = 't-rerun';
const OLD_JOB = '11111111-2222-3333-4444-555555555555';
const NEW_JOB = '99999999-8888-7777-6666-555555555555';
const OLD_COST = 3_000;
const NEW_COST = 3_500;

type LedgerRow = { user_id: string; transaction_type: string; metadata: any };

function makeWorld(ledger: LedgerRow[]) {
  const credits: number[] = [];
  const events: any[] = [];

  const client = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/FROM token_transactions/.test(s)) {
        // Запрос о прошлом возврате: ищем по пользователю и исходной задаче.
        const hit = ledger.find(
          (r) => params.includes(r.user_id) && r.transaction_type === 'refund'
            && params.includes(r.metadata?.job_id),
        );
        return { rows: hit ? [{ '?column?': 1 }] : [], rowCount: hit ? 1 : 0 };
      }
      if (/add_user_tokens/.test(s)) {
        credits.push(Number(params[1]));
        ledger.push({ user_id: params[0], transaction_type: 'refund', metadata: JSON.parse(params[3]) });
        return { rows: [{ res: { new_balance: 10_000 } }], rowCount: 1 };
      }
      if (/INSERT INTO support_events/.test(s)) {
        events.push(JSON.parse(params[1]));
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: jest.fn(),
  };

  const pg = {
    query: jest.fn(async (sql: string) => {
      if (/FROM video_jobs/.test(sql)) {
        return {
          rows: [{
            id: OLD_JOB, user_id: USER, status: 'failed', mode: 'text2video',
            model: 'veo-3.1-fast', prompt: 'кот на крыше', tokens_spent: OLD_COST,
            composed_plan: {}, target_duration_sec: 8,
          }],
        };
      }
      if (/INSERT INTO support_messages/.test(sql)) return { rows: [{ id: 'm-1' }] };
      return { rows: [] };
    }),
    getClient: jest.fn(async () => client),
  };

  const video = {
    createJob: jest.fn(async () => ({ jobId: NEW_JOB, status: 'processing', tokensSpent: NEW_COST })),
  };

  const svc = new SupportService(pg as any, undefined, video as any);
  const rerun = () => (svc as any).performRerun(TICKET, USER, { job_id: OLD_JOB });
  return { rerun, credits, events, video };
}

describe('перезапуск упавшего видео — возврат', () => {
  it('исходная задача уже получила возврат при провале — второй раз её стоимость не возвращается', async () => {
    const ledger: LedgerRow[] = [
      { user_id: USER, transaction_type: 'refund', metadata: { job_id: OLD_JOB, video_tokens: OLD_COST, still_tokens: 0 } },
    ];
    const { rerun, credits, events, video } = makeWorld(ledger);

    const res = await rerun();

    expect(video.createJob).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, new_job_id: NEW_JOB, credited: NEW_COST });
    // Ровно одно начисление и ровно на новое списание: перезапуск бесплатен,
    // а исходную задачу человек уже получил назад.
    expect(credits).toEqual([NEW_COST]);
    expect(events[0]).toMatchObject({ original_job_id: OLD_JOB, total_credited: NEW_COST });
  });

  it('возврата за исходную задачу в журнале нет — она возвращается вместе с новым списанием', async () => {
    const { rerun, credits } = makeWorld([]);

    const res = await rerun();

    expect(res).toMatchObject({ ok: true, credited: NEW_COST + OLD_COST });
    expect(credits).toEqual([NEW_COST + OLD_COST]);
  });

  it('возврат за ДРУГУЮ задачу того же человека не считается возвратом за эту', async () => {
    const ledger: LedgerRow[] = [
      { user_id: USER, transaction_type: 'refund', metadata: { job_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' } },
    ];
    const { rerun, credits } = makeWorld(ledger);

    await rerun();

    expect(credits).toEqual([NEW_COST + OLD_COST]);
  });
});
