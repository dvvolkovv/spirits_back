import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));

/**
 * Task 11 — video tick не опрашивает провайдера за удалённый аккаунт.
 *
 * Поллер каждые 5 секунд берёт video_jobs в status='processing' и ходит в
 * Omni/Veo (платные запросы) и в БД. После DELETE /webhook/profile задача
 * удалённого аккаунта не должна ни дёргать провайдера, ни обновлять строки:
 * gate на user_id.state='active' встроен в сам SELECT поллера.
 */

const GATE_RE = /EXISTS \(SELECT 1 FROM user_id u WHERE u\.internal_id = video_jobs\.user_id AND u\.state = 'active'\)/;

function makePg(job: { id: string; user_id: string } | null) {
  const queries: Array<{ sql: string; params: any[] }> = [];
  return {
    queries,
    async query(sql: string, params: any[] = []) {
      const s = sql.replace(/\s+/g, ' ').trim();
      queries.push({ sql: s, params });
      if (/FROM video_jobs WHERE status='processing'/.test(s)) {
        // Семантика прод-SQL: EXISTS-гейт на активный аккаунт отфильтровывает
        // задачи удалённого пользователя; без гейта задача ушла бы в pollJob.
        const rows = !GATE_RE.test(s) && job ? [job] : [];
        return { rows, rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async getClient() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    },
  } as any;
}

function makeSvc(pg: any) {
  const svc = new (VideoService as any)(pg, undefined, undefined, {
    get: async () => null, set: async () => undefined, del: async () => undefined,
  }) as VideoService;
  (svc as any).expireStaleJobs = jest.fn(async () => undefined);
  (svc as any).checkProviderRecovered = jest.fn(async () => undefined);
  (svc as any).pollJob = jest.fn(async () => undefined);
  return svc;
}

describe('VideoService.tick — gate на активный аккаунт', () => {
  it('задача удалённого аккаунта не опрашивается: EXISTS-гейт в SELECT поллера', async () => {
    const pg = makePg({ id: 'v-1', user_id: 'u-deleted' });
    const svc = makeSvc(pg);

    await (svc as any).tick();

    expect((svc as any).pollJob).not.toHaveBeenCalled();
    const select = pg.queries.find((q) => /FROM video_jobs WHERE status='processing'/.test(q.sql));
    expect(select).toBeDefined();
    expect(select!.sql).toMatch(GATE_RE);
  });

  it('гейт ссылается на user_id по internal_id и требует state=active', async () => {
    const pg = makePg(null);
    const svc = makeSvc(pg);

    await (svc as any).tick();

    const select = pg.queries.find((q) => /FROM video_jobs WHERE status='processing'/.test(q.sql));
    expect(select!.sql).toContain("u.state = 'active'");
    expect(select!.sql).toContain('u.internal_id = video_jobs.user_id');
  });
});
