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
 *    различаются только provider: 'linkeon' — звонок из приложения, всё
 *    остальное — встречи на площадках (комната Linkeon, Taler ID, Meet, Zoom,
 *    Teams, Телемост). Без фильтра получасовая встреча выглядит как звонок;
 *  - площадка уходит в SQL параметром, тестовые включаются по запросу, а
 *    разбивка по площадкам не сужается выбранной площадкой;
 *  - консультации не утекают между типами: при выборке звонков в
 *    tokens_consult не должны попадать вопросы, заданные на встрече.
 */
import { AdminService } from './admin.service';

const ROWS_Q = /GROUP BY c\.user_id/i;
const TOTALS_Q = /COUNT\(DISTINCT c\.user_id\)/i;
const BY_PROVIDER_Q = /GROUP BY c\.provider/i;

/** Фейковый pg: отвечает по форме запроса и запоминает SQL вместе с параметрами. */
function makePg(rows: any[], totals: any, byProvider: any[] = []) {
  const seen: string[] = [];
  const calls: Array<[string, any[] | undefined]> = [];
  return {
    seen,
    calls,
    /** Весь SQL одной строкой — по нему проверяем предикаты. */
    sql: () => seen.join(' | '),
    async query(sql: string, params?: any[]) {
      const flat = sql.replace(/\s+/g, ' ').trim();
      seen.push(flat);
      calls.push([flat, params]);
      if (TOTALS_Q.test(flat)) return { rows: [totals] };
      if (ROWS_Q.test(flat)) return { rows };
      if (BY_PROVIDER_Q.test(flat)) return { rows: byProvider };
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

  it('kind=meeting собирает все площадки встреч, а не одну комнату Linkeon', async () => {
    // Раньше тут стояло provider = 'linkeon_room', и Taler ID, Meet, Zoom,
    // Телемост и Teams не попадали ни в одну вкладку, кроме «Все».
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'meeting' });

    expect(res.kind).toBe('meeting');
    expect(pg.sql()).toMatch(/c\.provider <> 'linkeon'/);
    expect(pg.sql()).not.toMatch(/linkeon_room/);
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

  it('площадка уходит параметром, а не склейкой в SQL', async () => {
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'meeting', provider: 'zoom' });

    expect(res.provider).toBe('zoom');
    expect(pg.sql()).not.toMatch(/'zoom'/);
    const [rowsSql, rowsParams] = pg.calls.find(([s]: [string]) => ROWS_Q.test(s));
    expect(rowsSql).toMatch(/c\.provider = \$2/);
    expect(rowsParams).toEqual([30, 'zoom']);
  });

  it('площадка не по образцу отбрасывается целиком', async () => {
    // В SQL она и так ушла бы параметром; образец нужен, чтобы в ответ не
    // вернулась произвольная строка, выданная за выбранную площадку.
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ kind: 'meeting', provider: "zoom' OR 1=1 --" });

    expect(res.provider).toBeNull();
    for (const [, params] of pg.calls) expect(params).toEqual([30]);
  });

  it('includeTest снимает фильтр тестовых аккаунтов', async () => {
    // Все встречи на проде 24.09.2026 — прогоны владельца с тестового номера.
    // Без этого переключателя раздел встреч на проде пуст.
    const pg = makePg([ROW], TOTALS);
    const res = await service(pg).getCallsByUser({ includeTest: true });

    expect(res.include_test).toBe(true);
    expect(pg.sql()).not.toMatch(/c\.user_id <> ALL/);
  });

  it('разбивка по площадкам не сужается выбранной площадкой', async () => {
    // Иначе после клика по «Zoom» остальные кнопки исчезли бы и вернуться к
    // ним было бы нельзя.
    const pg = makePg([ROW], TOTALS, [
      { provider: 'talerid', sessions: 43 },
      { provider: 'zoom', sessions: '2' },
    ]);
    const res = await service(pg).getCallsByUser({ kind: 'meeting', provider: 'zoom' });

    const [byProvSql, byProvParams] = pg.calls.find(([s]: [string]) => BY_PROVIDER_Q.test(s));
    expect(byProvSql).toMatch(/c\.provider <> 'linkeon'/);
    expect(byProvSql).not.toMatch(/c\.provider = \$/);
    expect(byProvParams).toEqual([30]);
    expect(res.byProvider).toEqual([
      { provider: 'talerid', sessions: 43 },
      { provider: 'zoom', sessions: 2 },
    ]);
  });

  it('период ограничен сверху и снизу', async () => {
    const pg = makePg([ROW], TOTALS);
    expect((await service(pg).getCallsByUser({ days: 0 })).days).toBe(1);
    expect((await service(pg).getCallsByUser({ days: 9999 })).days).toBe(365);
  });
});
