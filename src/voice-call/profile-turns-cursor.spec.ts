import { VoiceCallService } from './voice-call.service';

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
  function makeSvc(rows: any[]) {
    const pg = { query: jest.fn(async () => ({ rows })) };
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
});
