import { TripService } from './trip.service';
import { NotConnected, SourceUnavailable } from '../talerid/talerid-calendar.connector';

/**
 * ⚠️ Дефект владельца 11.10.2026: «в десктопе событие есть, телефон его не видит».
 *
 * Причина была не в синхронизации: TalerID отвечал 429, коннектор ловил ошибку и возвращал
 * пустой список, лаунчер рисовал пустой день. Недоступный источник и отсутствие событий
 * выглядели для человека ОДИНАКОВО — и он сделал единственный возможный вывод, что события
 * нет. Молчаливая деградация тут хуже ошибки: ошибку видно, пустоту — нет.
 */
describe('TripService: недоступный источник называется, а не превращается в пустоту', () => {
  const ok = <T>(v: T) => jest.fn(async () => v);

  function makeSvc(taleridEvents: () => Promise<any[]>) {
    // Время — от «сейчас»: событие без end считается закончившимся через час,
    // и зашитая дата (было 2026-10-12T08:15+05:00) роняла тест в тот же день.
    const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const calendar = {
      listTasks: ok([]),
      listEvents: ok([{ at: soon, title: 'занятие Савы', conflict: false }]),
      listPendingProposals: ok([]),
    };
    // Порядок зависимостей: pg, calendar, taleridCalendar, linkeonTasks.
    const svc: any = new TripService(
      { query: jest.fn(async () => ({ rows: [] })) } as any,
      calendar as any,
      { listEvents: jest.fn(taleridEvents), listTasks: ok([]) } as any,
      { list: ok([]) } as any,
    );
    return { svc, calendar };
  }

  it('TalerID не ответил → источник назван, остальные данные на месте', async () => {
    const { svc } = makeSvc(async () => { throw new SourceUnavailable('TalerID', new Error('429')); });
    const state = await svc.getState('u1');
    expect(state.degraded).toContain('TalerID');
    // ⚠️ Главное: то, что ДОШЛО, человек всё равно видит. Полный отказ был бы не лучше пустоты.
    expect(JSON.stringify(state)).toContain('занятие Савы');
  });

  it('TalerID просто не подключён → это не сбой, поля нет', async () => {
    const { svc } = makeSvc(async () => []);
    const state = await svc.getState('u1');
    expect(state.degraded).toBeUndefined();
  });

  it('все источники ответили → поля нет', async () => {
    const { svc } = makeSvc(async () => [{ at: '2026-10-12T10:00:00+05:00', title: 'из TalerID', conflict: false }]);
    const state = await svc.getState('u1');
    expect(state.degraded).toBeUndefined();
  });

  it('NotConnected и SourceUnavailable — разные вещи', () => {
    expect(new NotConnected()).toBeInstanceOf(Error);
    expect(new SourceUnavailable('TalerID', new Error('429')).source).toBe('TalerID');
    expect(new NotConnected() instanceof SourceUnavailable).toBe(false);
  });
});
