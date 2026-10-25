import { SupportService } from './support.service';

/// Перезапуск упавшего видео из поддержки: сколько токенов возвращается и
/// сколько раз.
///
/// Перезапуск бесплатен: списание новой задачи возвращается сразу. Стоимость
/// исходной — только если её ещё не вернули (при провале её почти всегда уже
/// вернул VideoService.failAndRefund). Перезапуск одной задачи — ровно один,
/// даже если поддержка позовёт его дважды одновременно.
///
/// «База» — память, но предикат запроса к реестру берётся из ТЕКСТА SQL:
/// какие ключи metadata сравниваются с $2 и есть ли фильтр по типу. Ошибка в
/// SQL меняет ответ фейка так же, как изменила бы ответ Postgres. FOR UPDATE —
/// настоящая блокировка строки до COMMIT/ROLLBACK этого клиента.

const USER = 'u-rerun';
const TICKET = 't-rerun';
// Буквы в id нарочно: регистр — часть проверки.
const OLD_JOB = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const NEW_JOB = 'bbbbcccc-dddd-eeee-ffff-000011112222';
const OTHER_JOB = 'ccccdddd-eeee-ffff-0000-111122223333';
const OLD_COST = 3_000;
const NEW_COST = 3_500;

type LedgerRow = { user_id: string; transaction_type: string; metadata: any };

/** Предикат запроса к token_transactions, как его прочёл бы Postgres. */
function ledgerHit(sql: string, params: any[], ledger: LedgerRow[]): boolean {
  const keys = [...sql.matchAll(/metadata->>'(\w+)'\s*=\s*\$2/g)].map((m) => m[1]);
  const typeFilter = /transaction_type\s*=\s*'(\w+)'/.exec(sql)?.[1];
  const userFilter = /user_id\s*=\s*\$1/.test(sql);
  return ledger.some((r) =>
    (!userFilter || r.user_id === params[0])
    && (!typeFilter || r.transaction_type === typeFilter)
    // metadata->>'…' — текст: сравнение точное, с учётом регистра.
    && keys.some((k) => r.metadata?.[k] === params[1]));
}

function makeWorld(opts: {
  ledger?: LedgerRow[];
  priorReruns?: string[];
  /** Что сделать внутри createJob: например, «новая задача тут же упала». */
  duringCreate?: (ledger: LedgerRow[]) => void;
  createFails?: boolean;
  /** Сообщение в тикет не записывается (уже после COMMIT). */
  messageFails?: boolean;
} = {}) {
  const ledger = opts.ledger ?? [];
  const priorReruns = [...(opts.priorReruns ?? [])];
  const credits: Array<{ amount: number; metadata: any }> = [];
  const events: any[] = [];
  const log: string[] = [];
  const tokenQueries: Array<{ sql: string; params: any[] }> = [];
  const statuses = new Map<string, string>([[OLD_JOB, 'failed']]);
  const lockModes: Array<{ id: string; mode: string }> = [];

  // Блокировки строк: id → освобождение. Держатся до COMMIT/ROLLBACK.
  const held = new Map<string, Promise<void>>();

  let clients = 0;
  const makeClient = () => {
    const name = `c${++clients}`;
    const mine: Array<{ id: string; release: () => void }> = [];
    const unlockAll = () => { for (const l of mine.splice(0)) { held.delete(l.id); l.release(); } };
    return {
      release: jest.fn(),
      query: jest.fn(async (sql: string, params: any[] = []) => {
        const s = sql.replace(/\s+/g, ' ').trim();
        if (s === 'BEGIN') { log.push(`${name}:BEGIN`); return { rows: [] }; }
        if (s === 'COMMIT' || s === 'ROLLBACK') { log.push(`${name}:${s}`); unlockAll(); return { rows: [] }; }
        const lockMode = /FROM video_jobs WHERE id = \$1 FOR (NO KEY UPDATE|UPDATE)\b/.exec(s)?.[1];
        if (lockMode) {
          // FOR UPDATE и FOR NO KEY UPDATE конфликтуют и сами с собой, и друг
          // с другом — для перезапусков это одна и та же очередь.
          const id = params[0];
          lockModes.push({ id, mode: lockMode });
          while (held.has(id)) await held.get(id);
          let release!: () => void;
          held.set(id, new Promise<void>((r) => { release = r; }));
          mine.push({ id, release });
          log.push(`${name}:lock:${id}`);
          return { rows: statuses.has(id) ? [{ id, status: statuses.get(id) }] : [] };
        }
        if (/FROM support_events/.test(s) && /rerun_job/.test(s)) {
          log.push(`${name}:prior`);
          return { rows: priorReruns.includes(params[0]) ? [{ '?column?': 1 }] : [] };
        }
        if (/FROM token_transactions/.test(s)) {
          tokenQueries.push({ sql: s, params });
          return { rows: ledgerHit(s, params, ledger) ? [{ '?column?': 1 }] : [] };
        }
        if (/add_user_tokens/.test(s)) {
          const metadata = JSON.parse(params[3]);
          credits.push({ amount: Number(params[1]), metadata });
          ledger.push({ user_id: params[0], transaction_type: 'refund', metadata });
          log.push(`${name}:credit`);
          return { rows: [{ res: { new_balance: 10_000 } }] };
        }
        if (/SELECT tokens FROM ai_profiles_consolidated/.test(s)) return { rows: [{ tokens: 10_000 }] };
        if (/INSERT INTO support_events/.test(s)) {
          const payload = JSON.parse(params[1]);
          events.push(payload);
          priorReruns.push(payload.original_job_id);
          return { rows: [] };
        }
        return { rows: [] };
      }),
    };
  };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (opts.messageFails && /INSERT INTO support_messages/.test(sql)) throw new Error('support_messages: connection reset');
      // uuid в Postgres сравнивается без учёта регистра и отдаётся строчными.
      if (/FROM video_jobs WHERE id = \$1 AND user_id = \$2/.test(sql)) {
        if (String(params[0]).toLowerCase() !== OLD_JOB || params[1] !== USER) return { rows: [] };
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
    getClient: jest.fn(async () => makeClient()),
  };

  const video = {
    createJob: jest.fn(async () => {
      log.push('createJob');
      // Даём соседнему вызову шанс вклиниться, как дала бы сеть.
      await new Promise((r) => setImmediate(r));
      if (opts.createFails) throw new Error('veo_start: quota');
      statuses.set(NEW_JOB, 'processing');
      opts.duringCreate?.(ledger);
      return { jobId: NEW_JOB, status: 'processing', tokensSpent: NEW_COST };
    }),
  };

  const svc = new SupportService(pg as any, undefined, video as any);
  const rerun = (jobId = OLD_JOB) => (svc as any).performRerun(TICKET, USER, { job_id: jobId });
  return { rerun, svc, credits, events, log, tokenQueries, lockModes, video, ledger };
}

const failureRefund = (jobId: string): LedgerRow => ({
  user_id: USER, transaction_type: 'refund', metadata: { job_id: jobId, video_tokens: OLD_COST, still_tokens: 0 },
});

describe('перезапуск упавшего видео — возврат', () => {
  it('исходную задачу уже вернули при провале — возвращается только новое списание', async () => {
    const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });

    const res = await w.rerun();

    expect(w.video.createJob).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ ok: true, new_job_id: NEW_JOB, credited: NEW_COST });
    expect(w.credits.map((c) => c.amount)).toEqual([NEW_COST]);
    expect(w.events[0]).toMatchObject({ original_job_id: OLD_JOB, original_credited: 0, total_credited: NEW_COST });
  });

  it('возврата за исходную задачу в реестре нет — она возвращается вместе с новым списанием', async () => {
    const w = makeWorld();
    const res = await w.rerun();
    expect(res).toMatchObject({ ok: true, credited: NEW_COST + OLD_COST });
    expect(w.credits.map((c) => c.amount)).toEqual([NEW_COST + OLD_COST]);
  });

  it('возврат за ДРУГУЮ задачу того же человека не считается возвратом за эту', async () => {
    const w = makeWorld({ ledger: [failureRefund(OTHER_JOB)] });
    await w.rerun();
    expect(w.credits.map((c) => c.amount)).toEqual([NEW_COST + OLD_COST]);
  });

  it('запрос к реестру: только возвраты и именно по номеру задачи', async () => {
    const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });
    await w.rerun();

    const q = w.tokenQueries.find((t) => t.params[1] === OLD_JOB)!;
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/transaction_type = 'refund'/);
    expect(q.sql).toMatch(/metadata->>'job_id' = \$2/);
    expect(q.params).toEqual([USER, OLD_JOB]);
  });

  it('возврат другого типа (не refund) с тем же номером возвратом не считается', async () => {
    const w = makeWorld({
      ledger: [{ user_id: USER, transaction_type: 'bonus', metadata: { job_id: OLD_JOB } }],
    });
    await w.rerun();
    expect(w.credits.map((c) => c.amount)).toEqual([NEW_COST + OLD_COST]);
  });

  it('исходная задача сама была перезапуском — её стоимость вернул тот перезапуск, второй раз не возвращается', async () => {
    const w = makeWorld({
      ledger: [{
        user_id: USER, transaction_type: 'refund',
        metadata: { ticket_id: 't-0', original_job_id: OTHER_JOB, new_job_id: OLD_JOB },
      }],
    });
    const res = await w.rerun();
    expect(res).toMatchObject({ ok: true, credited: NEW_COST });
  });

  describe('номер задачи в верхнем регистре', () => {
    const UPPER = OLD_JOB.toUpperCase();

    it('сравнения текстом идут по каноническому id из базы', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });

      const res = await w.rerun(UPPER);

      // Возврат при провале найден, хотя спрашивали верхним регистром.
      expect(res).toMatchObject({ ok: true, credited: NEW_COST });
      expect(w.tokenQueries.every((t) => t.params[1] !== UPPER)).toBe(true);
      expect(w.events[0].original_job_id).toBe(OLD_JOB);
      expect(w.credits[0].metadata.original_job_id).toBe(OLD_JOB);
    });

    it('повтор верхним регистром ловится защитой от второго перезапуска', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });
      await w.rerun(OLD_JOB);

      const again = await w.rerun(UPPER);

      expect(again).toMatchObject({ ok: false, error: 'already_rerun' });
      expect(w.video.createJob).toHaveBeenCalledTimes(1);
      expect(w.credits).toHaveLength(1);
    });
  });

  describe('один перезапуск на задачу', () => {
    it('проверка «уже перезапускали» — под блокировкой строки исходной задачи, до createJob', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });
      await w.rerun();
      const lockAt = w.log.indexOf(`c1:lock:${OLD_JOB}`);
      expect(lockAt).toBeGreaterThan(w.log.indexOf('c1:BEGIN'));
      expect(w.log.indexOf('c1:prior')).toBeGreaterThan(lockAt);
      expect(w.log.indexOf('createJob')).toBeGreaterThan(w.log.indexOf('c1:prior'));
    });

    it('блокировки — FOR NO KEY UPDATE: проверке внешних ключей на строку они не мешают', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });
      await w.rerun();
      expect(w.lockModes).toEqual([
        { id: OLD_JOB, mode: 'NO KEY UPDATE' },
        { id: NEW_JOB, mode: 'NO KEY UPDATE' },
      ]);
    });

    it('два одновременных перезапуска: задача создаётся и оплачивается один раз', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)] });

      const [a, b] = await Promise.all([w.rerun(), w.rerun()]);

      expect(w.video.createJob).toHaveBeenCalledTimes(1);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect([a, b].find((x) => !x.ok)).toMatchObject({ error: 'already_rerun' });
      expect(w.credits).toHaveLength(1);
    });

    it('уже перезапускали — createJob не зовётся, транзакция откатывается', async () => {
      const w = makeWorld({ priorReruns: [OLD_JOB] });
      const res = await w.rerun();
      expect(res).toMatchObject({ ok: false, error: 'already_rerun' });
      expect(w.video.createJob).not.toHaveBeenCalled();
      expect(w.log).toContain('c1:ROLLBACK');
    });

    it('createJob упал — ни возврата, ни записи о перезапуске: повторить можно', async () => {
      const w = makeWorld({ ledger: [failureRefund(OLD_JOB)], createFails: true });
      const res = await w.rerun();
      expect(res).toMatchObject({ ok: false, error: 'create_failed' });
      expect(w.credits).toEqual([]);
      expect(w.events).toEqual([]);
      expect(w.log).toContain('c1:ROLLBACK');
    });
  });

  it('сообщение в тикет упало уже после COMMIT — ответ ok, возврат один', async () => {
    // credit_failed здесь соврал бы: деньги начислены, и ИИ поддержки мог бы
    // «добрать» их через refund_tokens.
    const w = makeWorld({ ledger: [failureRefund(OLD_JOB)], messageFails: true });
    const warn = jest.spyOn((w.svc as any).logger, 'warn').mockImplementation(() => undefined);

    const res = await w.rerun();

    expect(res).toMatchObject({ ok: true, new_job_id: NEW_JOB, credited: NEW_COST });
    expect(w.credits).toHaveLength(1);
    expect(w.log).toContain('c1:COMMIT');
    expect(w.log).not.toContain('c1:ROLLBACK');
    expect(warn).toHaveBeenCalled();
  });

  it('новая задача упала раньше, чем перезапуск успел вернуть её списание, — второй раз не возвращаем', async () => {
    // failAndRefund новой задачи успел первым: её списание уже вернулось.
    const w = makeWorld({
      ledger: [failureRefund(OLD_JOB)],
      duringCreate: (ledger) => ledger.push(failureRefund(NEW_JOB)),
    });

    const res = await w.rerun();

    expect(res).toMatchObject({ ok: true, credited: 0 });
    expect(w.credits).toEqual([]);
    // Строку новой задачи перезапуск берёт под блокировку до проверки реестра.
    expect(w.log).toContain(`c1:lock:${NEW_JOB}`);
  });
});
