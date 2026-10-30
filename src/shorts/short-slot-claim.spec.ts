import { NoFreeSlotError } from '../blog/blog-slots';
import { SHORT_SLOT_INDEX, approveShortIntoSlot, chooseApprovalSlot } from './short-slot-claim';

const schedule = { slotDays: [2, 4, 6], slotHourMsk: 18 };
const NOW = new Date('2026-10-26T12:00:00.000Z'); // понедельник
const TUE = new Date('2026-10-27T15:00:00.000Z'); // вторник, 18:00 МСК
const THU = new Date('2026-10-29T15:00:00.000Z');
const conflict = () => Object.assign(new Error('duplicate key'), { code: '23505', constraint: SHORT_SLOT_INDEX });

describe('chooseApprovalSlot', () => {
  it('планируемый слот впереди и свободен — он', () => {
    expect(chooseApprovalSlot(NOW, THU, schedule, [])).toEqual(THU);
  });
  it('планируемый занят — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, THU, schedule, [THU])).toEqual(TUE);
  });
  it('планируемый прошёл — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, new Date('2026-10-25T15:00:00.000Z'), schedule, [])).toEqual(TUE);
  });
  it('без планируемого — ближайший свободный', () => {
    expect(chooseApprovalSlot(NOW, null, schedule, [TUE])).toEqual(THU);
  });
});

/** Соединение-заглушка: SELECT отдаёт строки по очереди, UPDATE — по сценарию. */
function fakePg(selects: Array<{ rows: any[] }>, updates: Array<() => any>) {
  const log: string[] = [];
  const client = {
    query: jest.fn(async (sql: string) => {
      const verb = sql.trim().split(/\s+/)[0];
      log.push(verb);
      if (verb === 'SELECT') return selects.shift() ?? { rows: [] };
      if (verb === 'UPDATE') return (updates.shift() as () => any)();
      return { rows: [] };
    }),
    release: jest.fn(),
  };
  return { pg: { getClient: async () => client }, log, client };
}

describe('approveShortIntoSlot', () => {
  it('проигрыш гонки — новый круг видит слот занятым и берёт следующий', async () => {
    const { pg, log } = fakePg(
      [{ rows: [] }, { rows: [{ slot_at: THU }] }],
      [() => { throw conflict(); }, () => ({ rowCount: 1 })],
    );
    expect(await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).toEqual({ slot: TUE, now: NOW });
    expect(log.filter((v) => v === 'ROLLBACK')).toHaveLength(1);
    expect(log.filter((v) => v === 'COMMIT')).toHaveLength(1);
  });

  it('ролик ушёл из pending_review — null', async () => {
    const { pg } = fakePg([{ rows: [] }], [() => ({ rowCount: 0 })]);
    expect(await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).toBeNull();
  });

  it('чужой конфликт новым слотом не лечится', async () => {
    const other = Object.assign(new Error('pk'), { code: '23505', constraint: 'short_video_pkey' });
    const { pg } = fakePg([{ rows: [] }], [() => { throw other; }]);
    await expect(approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).rejects.toThrow('pk');
  });

  it('пять проигрышей подряд — NoFreeSlotError', async () => {
    const { pg } = fakePg([], Array.from({ length: 5 }, () => () => { throw conflict(); }));
    await expect(approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW)).rejects.toBeInstanceOf(NoFreeSlotError);
  });

  it('версия из админки — условие в записи одобрения; без версии SQL и параметры прежние', async () => {
    const VERSION = '2026-10-30 12:34:56.123456+00';
    const calls: any[][] = [];
    const client = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        calls.push([sql, params]);
        return sql.trim().startsWith('UPDATE') ? { rowCount: 1 } : { rows: [] };
      }),
      release: jest.fn(),
    };
    const pg = { getClient: async () => client };
    const update = () => calls.find(([sql]) => String(sql).trim().startsWith('UPDATE')) as any[];

    await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW, VERSION);
    expect(update()[0]).toContain("WHERE id = $1 AND status = 'pending_review' AND updated_at = $3::timestamptz");
    expect(update()[1]).toEqual(['v1', THU.toISOString(), VERSION]);

    calls.length = 0;
    await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW);
    expect(update()[0]).not.toContain('updated_at = $');
    expect(update()[1]).toEqual(['v1', THU.toISOString()]);
  });

  it('с версией проигрыш гонки не копит параметры: в каждом круге $3 и три значения', async () => {
    const VERSION = '2026-10-30 12:34:56.123456+00';
    const { pg, client } = fakePg(
      [{ rows: [] }, { rows: [{ slot_at: THU }] }],
      [() => { throw conflict(); }, () => ({ rowCount: 1 })],
    );
    expect(await approveShortIntoSlot(pg as any, 'v1', THU, schedule, () => NOW, VERSION)).toEqual({ slot: TUE, now: NOW });
    const ups = (client.query.mock.calls as any[][]).filter(([sql]) => String(sql).trim().startsWith('UPDATE'));
    expect(ups.map(([, p]) => p)).toEqual([['v1', THU.toISOString(), VERSION], ['v1', TUE.toISOString(), VERSION]]);
    expect(ups.every(([sql]) => String(sql).includes('AND updated_at = $3::timestamptz'))).toBe(true);
  });

  it('одобрение обнуляет счётчик попыток, аренду и ошибку отправки в личку: дальше по счётчику считает публикатор', async () => {
    const calls: string[] = [];
    const client = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        return sql.trim().startsWith('UPDATE') ? { rowCount: 1 } : { rows: [] };
      }),
      release: jest.fn(),
    };
    await approveShortIntoSlot({ getClient: async () => client } as any, 'v1', THU, schedule, () => NOW);
    expect(calls.find((s) => s.trim().startsWith('UPDATE'))).toContain('attempts = 0, lease_until = NULL, last_error = NULL');
  });
});
