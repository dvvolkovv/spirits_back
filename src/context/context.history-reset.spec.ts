import { ContextService } from './context.service';
import { ChatContextResetService } from '../chat/context-reset/context-reset.service';

/**
 * «Чистый лист» (spec 2026-11-17-context-reset): после точки ассистент видит
 * профиль и только разговор после неё. Раздел «Из переписки» — последние
 * сообщения основной ленты `${userId}_${agentId}`; голос Романа собирает
 * контекст через него, поэтому без отсечки звонок вернул бы забытое.
 *
 * Сервис точки — шестой параметр конструктора ContextService (последний,
 * @Optional). Строки приходят из БД по created_at DESC.
 */
const RESET = new Date('2026-11-17T00:00:00Z');

function pgWith(rows: any[]) {
  return { query: jest.fn(async () => ({ rows })) };
}

const ROWS = () => [
  { sender_type: 'human', content: 'НОВОЕ', created_at: '2026-11-17T09:00:00Z' },
  // На проде pg отдаёт timestamptz как Date.
  { sender_type: 'ai', content: 'ОТВЕТ-НОВЫЙ', created_at: new Date('2026-11-17T00:00:01Z') },
  { sender_type: 'human', content: 'СТАРОЕ', created_at: '2026-11-10T09:00:00Z' },
  { sender_type: 'ai', content: 'ОТВЕТ-СТАРЫЙ', created_at: new Date('2026-11-16T23:59:59Z') },
];

function svcWith(rows: any[], get: jest.Mock) {
  const pg = pgWith(rows);
  const resets = { get } as unknown as ChatContextResetService;
  const svc = new ContextService(pg as any, undefined, undefined, undefined, undefined, resets);
  return { svc, pg };
}

describe('ContextService «Из переписки»: точка «Чистого листа»', () => {
  it('«Из переписки» — только после точки «Чистого листа»', async () => {
    const get = jest.fn(async () => RESET);
    const { svc } = svcWith(ROWS(), get);

    const out: string = await (svc as any).sectionHistory('u1', 7);

    expect(out).toContain('--- Из переписки ---');
    expect(out).toContain('НОВОЕ');
    expect(out).toContain('ОТВЕТ-НОВЫЙ');
    expect(out).not.toContain('СТАРОЕ');
    expect(out).not.toContain('ОТВЕТ-СТАРЫЙ');
    // Точка — на пару «пользователь + этот ассистент», не на ассистента по умолчанию.
    expect(get).toHaveBeenCalledWith('u1', '7');
    expect(get).not.toHaveBeenCalledWith('u1', '12');
  });

  it('created_at выбирается из базы — без него точка отбросила бы всё', async () => {
    const { svc, pg } = svcWith(ROWS(), jest.fn(async () => RESET));

    await (svc as any).sectionHistory('u1', 12);

    const sql = String((pg.query.mock.calls[0] as any[])[0]);
    expect(sql).toMatch(/SELECT\s[^]*?\bcreated_at\b[^]*?\bFROM custom_chat_history/);
  });

  it('без точки — переписка целиком, как раньше', async () => {
    const { svc } = svcWith(ROWS(), jest.fn(async () => null));

    const out: string = await (svc as any).sectionHistory('u1', 12);

    expect(out).toContain('НОВОЕ');
    expect(out).toContain('СТАРОЕ');
  });

  it('без сервиса точки (стенды, смежные спеки) — переписка целиком', async () => {
    const svc = new ContextService(pgWith(ROWS()) as any);

    const out: string = await (svc as any).sectionHistory('u1', 12);

    expect(out).toContain('НОВОЕ');
    expect(out).toContain('СТАРОЕ');
  });

  it('после точки ничего нового — раздел пустой, как при пустой ленте', async () => {
    const old = ROWS().filter((r) => /СТАР/.test(r.content));
    const { svc } = svcWith(old, jest.fn(async () => RESET));

    expect(await (svc as any).sectionHistory('u1', 12)).toBe('');
  });

  it('сбой чтения точки — раздел строится без фильтра, без текста разговора в логе', async () => {
    const { svc } = svcWith(ROWS(), jest.fn(async () => { throw new Error('pg прилёг'); }));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    const out: string = await (svc as any).sectionHistory('u1', 12);

    expect(out).toContain('НОВОЕ');
    expect(out).toContain('СТАРОЕ');
    expect(warn).toHaveBeenCalled();
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('u1_12');
    expect(logged).not.toContain('СТАРОЕ');
    expect(logged).not.toContain('НОВОЕ');
  });

  it('build: голосовой контекст после точки не несёт старой переписки', async () => {
    // Сборка целиком — так её зовёт голос Романа (VoiceCallService.buildPreamble).
    const pg = {
      query: jest.fn(async (sql: string) =>
        /FROM custom_chat_history/i.test(sql) ? { rows: ROWS() } : { rows: [] }),
    };
    const resets = { get: jest.fn(async () => RESET) } as unknown as ChatContextResetService;
    const svc = new ContextService(pg as any, undefined, undefined, undefined, undefined, resets);

    const built = await svc.build('u1', 'voice-launcher', { agentId: 7 });

    expect(built.text).toContain('НОВОЕ');
    expect(built.text).not.toContain('СТАРОЕ');
    // Ассистент — из opts.agentId, а не умолчание секции (12).
    expect(pg.query).toHaveBeenCalledWith(expect.stringMatching(/FROM custom_chat_history/), ['u1_7']);
    expect((resets as any).get).toHaveBeenCalledWith('u1', '7');
    expect((resets as any).get).not.toHaveBeenCalledWith('u1', '12');
  });

  it('сервис точки в конструкторе — класс, а не import type (сторож design:paramtypes)', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ContextService);
    expect(paramTypes).toContain(ChatContextResetService);
  });
});

/**
 * «Чем кончился прошлый разговор» — дословный хвост последнего звонка. Звонок,
 * НАЧАТЫЙ не позже точки, — старый разговор: после «Чистого листа» перезвон в
 * пределах получаса не должен возвращать его Роману.
 *
 * Сравнивается начало звонка, а не ended_at: ended_at — момент закрытия
 * строки, а не разговора. Его ставят и вытеснение заброшенного звонка новым
 * (start → markInterrupted прямо перед сборкой преамбулы), и реапер: звонок
 * 10:00 с «грязным» концом, точка в 10:20, новый звонок в 10:25 закрывает
 * старый — ended_at 10:25 позже точки, и без этого правила Роман получил бы
 * дословный хвост разговора 10:00. Окно в 30 минут — по-прежнему от ended_at.
 *
 * sectionContinuation(userId, agentId, budget) — порядок как у sectionHistory.
 */
describe('ContextService «Чем кончился прошлый разговор»: точка «Чистого листа»', () => {
  const tail = [
    { role: 'user', text: 'ХВОСТ-ЗВОНКА: перезвоню после встречи', ts: 1 },
    { role: 'assistant', text: 'Хорошо, жду', ts: 2 },
  ];
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  // Время — и строкой, и Date: на проде pg отдаёт timestamptz как Date.
  const pgWithCall = (startedAt: Date | string | null, endedAt: Date | string) => ({
    query: jest.fn(async (sql: string) =>
      /FROM voice_calls/i.test(sql)
        ? { rows: [{ id: 'call-1', started_at: startedAt, ended_at: endedAt, transcript: tail }] }
        : { rows: [] }),
  });
  const svcWithCall = (startedAt: Date | string | null, endedAt: Date | string, get?: jest.Mock) => {
    const pg = pgWithCall(startedAt, endedAt);
    const resets = get ? ({ get } as unknown as ChatContextResetService) : undefined;
    return { svc: new ContextService(pg as any, undefined, undefined, undefined, undefined, resets), pg };
  };

  it('звонок начат и закончен до точки — раздела нет', async () => {
    const get = jest.fn(async () => minutesAgo(5));
    const { svc } = svcWithCall(minutesAgo(15).toISOString(), minutesAgo(10).toISOString(), get);

    expect(await (svc as any).sectionContinuation('u1', 7, 1200)).toBe('');
    expect(get).toHaveBeenCalledWith('u1', '7');
    expect(get).not.toHaveBeenCalledWith('u1', '12');
  });

  it('⚠️ звонок начат до точки, а закрыт вытеснением после неё — раздела нет', async () => {
    // Начат 25 минут назад, точка 10 минут назад, строку закрыл новый звонок
    // 1 минуту назад (ended_at = now() вытеснения).
    const get = jest.fn(async () => minutesAgo(10));
    const { svc } = svcWithCall(minutesAgo(25), minutesAgo(1), get);

    expect(await (svc as any).sectionContinuation('u1', 12, 1200)).toBe('');
  });

  it('звонок начат ровно в момент точки — раздела нет (проходит только строго после)', async () => {
    const at = minutesAgo(5);
    const { svc } = svcWithCall(new Date(at.getTime()), minutesAgo(1), jest.fn(async () => new Date(at.getTime())));

    expect(await (svc as any).sectionContinuation('u1', 12, 1200)).toBe('');
  });

  it('звонок начат после точки — раздел есть', async () => {
    const { svc } = svcWithCall(minutesAgo(8).toISOString(), minutesAgo(5).toISOString(), jest.fn(async () => minutesAgo(10)));

    expect(await (svc as any).sectionContinuation('u1', 12, 1200)).toContain('ХВОСТ-ЗВОНКА');
  });

  it('started_at выбирается из базы — без него точка отбросила бы любой подхват', async () => {
    const { svc, pg } = svcWithCall(minutesAgo(8), minutesAgo(5), jest.fn(async () => minutesAgo(10)));

    await (svc as any).sectionContinuation('u1', 12, 1200);

    const sql = String((pg.query.mock.calls[0] as any[])[0]);
    expect(sql).toMatch(/SELECT\s[^]*?\bstarted_at\b[^]*?\bFROM voice_calls/);
  });

  it('без точки — раздел есть, как раньше', async () => {
    const { svc } = svcWithCall(minutesAgo(25), minutesAgo(5), jest.fn(async () => null));

    expect(await (svc as any).sectionContinuation('u1', 12, 1200)).toContain('ХВОСТ-ЗВОНКА');
  });

  it('сбой чтения точки — раздел есть, warn без текста разговора', async () => {
    const { svc } = svcWithCall(minutesAgo(25), minutesAgo(5), jest.fn(async () => { throw new Error('pg прилёг'); }));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await (svc as any).sectionContinuation('u1', 12, 1200)).toContain('ХВОСТ-ЗВОНКА');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('u1_12');
    expect(logged).not.toContain('ХВОСТ-ЗВОНКА');
  });

  it('build: точка берётся на пару с ассистентом из opts.agentId', async () => {
    const get = jest.fn(async () => minutesAgo(5));
    const { svc } = svcWithCall(minutesAgo(15), minutesAgo(10), get);

    const built = await svc.build('u1', 'voice-launcher', { agentId: 7 });

    expect(built.text).not.toContain('ХВОСТ-ЗВОНКА');
    expect(get).toHaveBeenCalledWith('u1', '7');
    expect(get).not.toHaveBeenCalledWith('u1', '12');
  });
});
