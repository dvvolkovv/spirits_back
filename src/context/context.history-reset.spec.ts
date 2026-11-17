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

    const out: string = await (svc as any).sectionHistory('u1', 12);

    expect(out).toContain('--- Из переписки ---');
    expect(out).toContain('НОВОЕ');
    expect(out).toContain('ОТВЕТ-НОВЫЙ');
    expect(out).not.toContain('СТАРОЕ');
    expect(out).not.toContain('ОТВЕТ-СТАРЫЙ');
    // Точка — на пару «пользователь + этот ассистент».
    expect(get).toHaveBeenCalledWith('u1', '12');
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

    const built = await svc.build('u1', 'voice-launcher', { agentId: 12 });

    expect(built.text).toContain('НОВОЕ');
    expect(built.text).not.toContain('СТАРОЕ');
  });

  it('сервис точки в конструкторе — класс, а не import type (сторож design:paramtypes)', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ContextService);
    expect(paramTypes).toContain(ChatContextResetService);
  });
});

/**
 * «Чем кончился прошлый разговор» — дословный хвост последнего звонка. Звонок,
 * закончившийся не позже точки, — старый разговор: после «Чистого листа»
 * перезвон в пределах получаса не должен возвращать его Роману.
 *
 * sectionContinuation(userId, budget, agentId) — agentId третьим, чтобы не
 * менять вызовы существующих спек; по умолчанию 12, как у sectionHistory.
 */
describe('ContextService «Чем кончился прошлый разговор»: точка «Чистого листа»', () => {
  const tail = [
    { role: 'user', text: 'ХВОСТ-ЗВОНКА: перезвоню после встречи', ts: 1 },
    { role: 'assistant', text: 'Хорошо, жду', ts: 2 },
  ];
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  // ended_at — строкой, как в соседних спеках подхвата; на проде pg отдаёт Date.
  const pgWithCall = (endedAt: Date | string) => ({
    query: jest.fn(async (sql: string) =>
      /FROM voice_calls/i.test(sql)
        ? { rows: [{ id: 'call-1', ended_at: endedAt, transcript: tail }] }
        : { rows: [] }),
  });
  const svcWithCall = (endedAt: Date | string, get?: jest.Mock) => {
    const resets = get ? ({ get } as unknown as ChatContextResetService) : undefined;
    return new ContextService(pgWithCall(endedAt) as any, undefined, undefined, undefined, undefined, resets);
  };

  it('звонок закончился до точки — раздела нет', async () => {
    const get = jest.fn(async () => minutesAgo(5));
    const svc = svcWithCall(minutesAgo(10).toISOString(), get);

    expect(await (svc as any).sectionContinuation('u1', 1200)).toBe('');
    expect(get).toHaveBeenCalledWith('u1', '12');
  });

  it('звонок закончился ровно в момент точки — раздела нет (проходит только строго после)', async () => {
    const at = minutesAgo(5);
    const svc = svcWithCall(new Date(at.getTime()), jest.fn(async () => new Date(at.getTime())));

    expect(await (svc as any).sectionContinuation('u1', 1200)).toBe('');
  });

  it('звонок закончился после точки — раздел есть', async () => {
    const svc = svcWithCall(minutesAgo(5), jest.fn(async () => minutesAgo(10)));

    expect(await (svc as any).sectionContinuation('u1', 1200)).toContain('ХВОСТ-ЗВОНКА');
  });

  it('без точки — раздел есть, как раньше', async () => {
    const svc = svcWithCall(minutesAgo(5), jest.fn(async () => null));

    expect(await (svc as any).sectionContinuation('u1', 1200)).toContain('ХВОСТ-ЗВОНКА');
  });

  it('сбой чтения точки — раздел есть, warn без текста разговора', async () => {
    const svc = svcWithCall(minutesAgo(5), jest.fn(async () => { throw new Error('pg прилёг'); }));
    const warn = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    expect(await (svc as any).sectionContinuation('u1', 1200)).toContain('ХВОСТ-ЗВОНКА');
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('u1_12');
    expect(logged).not.toContain('ХВОСТ-ЗВОНКА');
  });

  it('build: точка берётся на пару с ассистентом из opts.agentId', async () => {
    const get = jest.fn(async () => minutesAgo(5));
    const svc = svcWithCall(minutesAgo(10), get);

    const built = await svc.build('u1', 'voice-launcher', { agentId: 12 });

    expect(built.text).not.toContain('ХВОСТ-ЗВОНКА');
    expect(get).toHaveBeenCalledWith('u1', '12');
  });
});
