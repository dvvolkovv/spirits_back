import { __resetBucketCacheForTests, loadChatFilesStats } from './chat-files-stats';
import { excludedUsers, TEST_USER_PATTERN } from '../../common/test-users';

const ROW = {
  opens: 5, users: 3, downloads: 4, dl_image: 2, dl_document: 1, dl_video: 0, dl_audio: 1,
  ff_calls: 6, ff_found: 4, ff_stored: 3, stored: 10, failed: 2,
};

function pgWith(rows: any[][]) {
  const calls: { sql: string; params: any[] }[] = [];
  let i = 0;
  return {
    calls,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return { rows: rows[i++] ?? [] };
    }),
  };
}

beforeEach(() => __resetBucketCacheForTests());

describe('loadChatFilesStats', () => {
  it('собирает блок из событий и объёма бакета', async () => {
    const pg = pgWith([[ROW], [{ reason: 'timeout', n: 2 }]]);
    const storage = { bucketStats: jest.fn(async () => ({ objects: 601, bytes: 324009984 })) };
    expect(await loadChatFilesStats(pg as any, storage as any, '30d', '30 days')).toEqual({
      panel: { opens: 5, users: 3 },
      downloads: { total: 4, byKind: { image: 2, document: 1, video: 0, audio: 1 } },
      findFiles: { calls: 6, withResults: 4, withStored: 3 },
      storage: { stored: 10, failed: 2, topFailReason: 'timeout', bucketObjects: 601, bucketBytes: 324009984 },
    });
  });

  it('тестовые аккаунты и окно — в параметрах запроса', async () => {
    const pg = pgWith([[ROW], []]);
    await loadChatFilesStats(pg as any, undefined, '7d', '7 days');
    const { sql, params } = pg.calls[0];
    expect(sql).toContain('<> ALL($3::text[])');
    expect(sql).toContain('!~ $4');
    expect(params.slice(0, 4)).toEqual(['7d', '7 days', excludedUsers(), TEST_USER_PATTERN]);
  });

  it('MinIO не ответил — объём null, остальное на месте', async () => {
    const pg = pgWith([[ROW], []]);
    const storage = { bucketStats: jest.fn(async () => { throw new Error('Access Denied.'); }) };
    const s = await loadChatFilesStats(pg as any, storage as any, '30d', '30 days');
    expect(s?.storage).toMatchObject({ bucketObjects: null, bucketBytes: null, stored: 10, topFailReason: null });
  });

  it('объём бакета кешируется на 5 минут', async () => {
    const storage = { bucketStats: jest.fn(async () => ({ objects: 1, bytes: 2 })) };
    await loadChatFilesStats(pgWith([[ROW], []]) as any, storage as any, '30d', '30 days');
    await loadChatFilesStats(pgWith([[ROW], []]) as any, storage as any, '7d', '7 days');
    expect(storage.bucketStats).toHaveBeenCalledTimes(1);
  });

  it('база не ответила — null, а не ошибка обзора', async () => {
    const pg = { query: jest.fn(async () => { throw new Error('ECONNREFUSED'); }) };
    expect(await loadChatFilesStats(pg as any, undefined, '30d', '30 days')).toBeNull();
  });

  it('мусор в props (ручка событий анонимная) не роняет подсчёт', async () => {
    const pg = pgWith([[ROW], []]);
    await loadChatFilesStats(pg as any, undefined, '30d', '30 days');
    // Сравнение текстом, без ::int: props->>'found' = 'abc' не должен ломать запрос.
    expect(pg.calls[0].sql).not.toMatch(/props->>'(found|stored)'\)::int/);
  });

  it('MinIO завис — таймаут бакета, а не бесконечное ожидание ответа', async () => {
    const pg = pgWith([[ROW], []]);
    // Никогда не резолвится сама — только когда сигнал оборвали.
    const storage = {
      bucketStats: jest.fn((_bucket: string, signal?: AbortSignal) => new Promise<never>((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })),
    };
    const s = await loadChatFilesStats(pg as any, storage as any, '30d', '30 days', 20);
    expect(s?.storage).toMatchObject({ bucketObjects: null, bucketBytes: null });
  }, 1000);
});
