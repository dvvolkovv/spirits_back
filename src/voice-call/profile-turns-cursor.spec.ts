import { VoiceCallService } from './voice-call.service';
import { automaticProfilingAllowed } from '../privacy/profile-privacy';

jest.mock('../privacy/profile-privacy', () => ({
  automaticProfilingAllowed: jest.fn(),
}));

const automaticProfilingAllowedMock = automaticProfilingAllowed as jest.MockedFunction<
  typeof automaticProfilingAllowed
>;

/**
 * ⚠️ Курсор подтяжки реплик — потеря данных владельца 11.10.2026.
 *
 * Курсор считался по ВСЕМ подходящим репликам, а отдавались первые 100. Если накопилось
 * больше, устройство получало страницу, двигало курсор за последнюю из ВСЕХ — и остаток
 * пропадал навсегда, молча.
 *
 * В тот день было два разговора, 207 реплик человека. Телефон получил 100, курсор ушёл на
 * конец, 107 реплик не пришли никогда: первый разговор оборвался на середине, второй — где
 * владелец рассказывал про подачу на развод, запрет на вывоз детей, заявление в опеку и
 * дату судебного заседания — не пришёл вовсе.
 *
 * Два дня я искал причину в промптах, гейтах и нумерации кусков. Она была здесь.
 */
describe('profileTurns: курсор не перепрыгивает неотданное', () => {
  beforeEach(() => {
    automaticProfilingAllowedMock.mockReset().mockResolvedValue(true);
  });

  function makeSvc(rows: any[]) {
    const pg = {
      query: jest.fn(async (sql: string) => {
        const ordered = /ORDER BY started_at ASC/i.test(sql) ? [...rows].reverse() : [...rows];
        return { rows: /LIMIT\s+30/i.test(sql) ? ordered.slice(0, 30) : ordered };
      }),
    };
    return new VoiceCallService(pg as any, ...([] as any[])) as any;
  }

  /** Звонок с N репликами человека, ts = base+i. */
  const call = (id: string, n: number, base: number) => ({
    id,
    transcript: Array.from({ length: n }, (_, i) => ({ role: 'user', text: `реплика ${i}`, ts: base + i })),
  });

  it('⚠️ ГЛАВНОЕ: при переполнении курсор равен ts ПОСЛЕДНЕЙ ОТДАННОЙ, а не последней вообще', async () => {
    const svc = makeSvc([call('a', 137, 1000), call('b', 70, 5000)]);
    const r = await svc.profileTurns('u1', 0);

    expect(r.turns).toHaveLength(100);
    expect(r.cursor).toBe(r.turns[r.turns.length - 1].ts);
    // Раньше тут было 5069 — максимум по всем 207, и 107 реплик терялись.
    expect(r.cursor).toBeLessThan(5000);
  });

  it('следующая подтяжка забирает ровно остаток, ничего не теряя', async () => {
    const rows = [call('a', 137, 1000), call('b', 70, 5000)];
    const svc = makeSvc(rows);
    const seen = new Set<number>();
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const r = await svc.profileTurns('u1', cursor);
      if (!r.turns.length) break;
      r.turns.forEach((t: any) => seen.add(t.ts));
      cursor = r.cursor;
    }
    expect(seen.size).toBe(207);   // все реплики обоих звонков дошли
  });

  it('пустая выдача курсор не двигает', async () => {
    const svc = makeSvc([call('a', 3, 100)]);
    const r = await svc.profileTurns('u1', 999);
    expect(r.turns).toHaveLength(0);
    expect(r.cursor).toBe(999);
  });

  it('не теряет и не дублирует больше 100 реплик с одинаковым ts на границе страницы', async () => {
    const sameTs = 2_000;
    const tiedCall = (id: string, n: number) => ({
      id,
      transcript: Array.from({ length: n }, (_, i) => ({ role: 'user', text: `${id}-${i}`, ts: sameTs })),
    });
    const svc = makeSvc([tiedCall('b', 70), tiedCall('a', 67), call('next', 1, sameTs + 1)]);
    const keys: string[] = [];
    const pageSizes: number[] = [];
    const cursors: number[] = [];
    let cursor = 0;

    for (let i = 0; i < 10; i++) {
      const r = await svc.profileTurns('u1', cursor);
      if (!r.turns.length) break;
      pageSizes.push(r.turns.length);
      keys.push(...r.turns.map((t: any) => `${t.callId}:${t.index}`));
      cursors.push(r.cursor);
      cursor = r.cursor;
    }

    expect(pageSizes).toEqual([100, 38]);
    expect(cursors[0]).toBeGreaterThan(sameTs);
    expect(cursors[0]).toBeLessThan(sameTs + 1);
    expect(cursors[1]).toBe(sameTs + 1);
    expect(keys).toHaveLength(138);
    expect(new Set(keys).size).toBe(138);
  });

  it('после более чем 30 звонков в период запрета отдаёт весь backlog ровно один раз', async () => {
    const rows = Array.from({ length: 35 }, (_, i) => call(`call-${i}`, 1, 1_000 + i)).reverse();
    let enabled = false;
    automaticProfilingAllowedMock.mockImplementation(async () => enabled);
    const svc = makeSvc(rows);

    await expect(svc.profileTurns('u1', 0)).resolves.toEqual({ turns: [], cursor: 0 });
    expect(svc.pg.query).not.toHaveBeenCalled();

    enabled = true;
    const keys: string[] = [];
    let cursor = 0;
    for (let i = 0; i < 10; i++) {
      const r = await svc.profileTurns('u1', cursor);
      if (!r.turns.length) break;
      keys.push(...r.turns.map((t: any) => `${t.callId}:${t.index}`));
      cursor = r.cursor;
    }

    expect(keys).toHaveLength(35);
    expect(new Set(keys).size).toBe(35);
    expect(keys.sort()).toEqual(rows.map((row) => `${row.id}:0`).sort());
  });
});
