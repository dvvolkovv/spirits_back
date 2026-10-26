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
  return { pg: { getClient: async () => client }, log };
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
});
