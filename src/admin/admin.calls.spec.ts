/**
 * Звонки в разрезе пользователей: сколько звонили и сколько за это списано.
 *
 * До этого раздела расход на голос из админки не был виден вообще. Вопрос
 * «кто звонит и во сколько это обошлось» решался запросом в psql, а цифра
 * там неочевидная: списаний ДВА и лежат они в разных таблицах.
 *
 * Что здесь закреплено:
 *  - разговор и консультации считаются раздельно. voice_calls.tokens_charged —
 *    это минуты разговора, voice_call_jobs.tokens_used — каждый вопрос Романа
 *    профильному ассистенту. Одна общая цифра скрыла бы, что именно съело
 *    токены, а это и есть первый вопрос при разборе крупного счёта;
 *  - тестовые аккаунты отфильтрованы. У владельца это большая часть трафика,
 *    и без фильтра таблица показывает не пользователей, а прогоны;
 *  - встречи не подмешиваются к звонкам. Обе сущности живут в voice_calls и
 *    различаются только provider ('linkeon' против 'linkeon_room'). Без
 *    фильтра получасовая встреча выглядит как звонок и ломает средние;
 *  - консультации не утекают между типами: при выборке звонков в
 *    tokens_consult не должны попадать вопросы, заданные на встрече.
 */
import { AdminService } from './admin.service';

const ROWS_Q = /GROUP BY c\.user_id/i;
const TOTALS_Q = /COUNT\(DISTINCT c\.user_id\)/i;

/** Фейковый pg: отвечает по форме запроса и запоминает весь SQL. */
function makePg(rows: any[], totals: any) {
  const seen: string[] = [];
  return {
    seen,
    /** Весь SQL одной строкой — по нему проверяем предикаты. */
    sql: () => seen.join(' | '),
    async query(sql: string, params?: any[]) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      seen.push(flat);
      if (TOTALS_Q.test(flat)) return { rows: [totals] };
      if (ROWS_Q.test(flat)) return { rows };
      return { rows: [] };
    },
  } as any;
}

const service = (pg: any) => new (AdminService as any)(pg);

const ROW = {
  user_id: '79035281880',
  calls: 4,
  duration_sec: '930',
  tokens_call: '12000',
  tokens_consult: '48000',
  consults: 3,
  last_call: '2026-09-04T10:15:00Z',
};

const TOTALS = {
  calls: 11,
  users: 5,
  duration_sec: '4200',
  tokens_call: '31000',
  tokens_consult: '96000',
};

describe('AdminService.getCallsByUser', () => {
  it('списание разложено на разговор и консультации, итог — их сумма', async () => {
    // Смысл раздельных колонок: 48к из 60к съели не минуты, а три вопроса
    // Роману к специалистам. По одной общей цифре этого не увидеть.
    const svc = service(makePg([ROW], TOTALS));
    const res = await svc.getCallsByUser({});

    expect(res.byUser[0].tokens_call).toBe(12000);
    expect(res.byUser[0].tokens_consult).toBe(48000);
    expect(res.byUser[0].tokens_total).toBe(60000);
  });

  it('в итогах суммируются обе части, а не только разговор', async () => {
    const svc = service(makePg([ROW], TOTALS));
    const res = await svc.getCallsByUser({});

    expect(res.totals.tokens_call).toBe(31000);
    expect(res.totals.tokens_consult).toBe(96000);
    expect(res.totals.tokens_total).toBe(127000);
    expect(res.totals.users).toBe(5);
  });

  it('тестовые аккаунты исключены', async () => {
    const pg = makePg([ROW], TOTALS);
    await service(pg).getCallsByUser({});

    // Предикат строит excludeTest — проверяем, что он вообще применён к
    // user_id звонка, иначе таблица покажет прогоны владельца.
    expect(pg.sql()).toMatch(/c\.user_id <> ALL/);
  });

  it('по умолчанию только звонки: встречи в выборку не попадают', async () => {
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({});

    expect(res.kind).toBe('call');
    expect(pg.sql()).toMatch(/c\.provider = 'linkeon'/);
    expect(pg.sql()).not.toMatch(/linkeon_room/);
  });

  it('kind=meeting выбирает встречи, а не звонки', async () => {
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'meeting' });

    expect(res.kind).toBe('meeting');
    expect(pg.sql()).toMatch(/c\.provider = 'linkeon_room'/);
  });

  it('kind=all снимает фильтр по типу', async () => {
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'all' });

    expect(res.kind).toBe('all');
    expect(pg.sql()).not.toMatch(/c\.provider =/);
  });

  it('консультации берутся только по звонкам той же выборки', async () => {
    // Подзапрос по voice_call_jobs обязан быть привязан к call_id из уже
    // отфильтрованного набора. Иначе при выборе звонков в tokens_consult
    // приедут вопросы, заданные на встречах, — цифра станет больше того,
    // что вообще списано за звонки.
    const pg = makePg([ROW], TOTALS);
    await service(pg).getCallsByUser({});

    expect(pg.sql()).toMatch(/voice_call_jobs/);
    expect(pg.sql()).toMatch(/call_id = c\.id/);
  });

  it('неизвестный kind не превращается в дыру в фильтре', async () => {
    // Значение приходит из query-параметра. Незнакомое должно схлопываться в
    // 'call', а не оставлять запрос вовсе без предиката по provider: иначе
    // ?kind=. подмешал бы встречи в раздел звонков молча.
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'нечто' as any });

    expect(res.kind).toBe('call');
    expect(pg.sql()).toMatch(/c\.provider = 'linkeon'/);
  });

  it('период ограничен сверху и снизу', async () => {
    const pg = makePg([ROW], TOTALS);
    expect((await service(pg).getCallsByUser({ days: 0 })).days).toBe(1);
    expect((await service(pg).getCallsByUser({ days: 9999 })).days).toBe(365);
  });
});
