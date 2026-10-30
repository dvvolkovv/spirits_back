import { ContextService } from './context.service';
import { TOTAL_BUDGET } from './context.types';

const pgEmpty = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) as any;

describe('ContextService', () => {
  it('при переполнении общего бюджета вытесняется самая низкоранговая секция', async () => {
    // Сумма посекционных потолков (7970) больше общего (7500), поэтому
    // вытеснение включается только когда секции набиты почти под завязку.
    // Режется history: разговор её восстановит, а пропущенную встречу — нет.
    const svc = new ContextService(pgEmpty());
    const big = (n: number) => 'х'.repeat(n);
    jest.spyOn(svc as any, 'sectionNow').mockResolvedValue('СЕЙЧАС');
    jest.spyOn(svc as any, 'sectionIdentity').mockResolvedValue(big(2000));
    jest.spyOn(svc as any, 'sectionContinuation').mockResolvedValue(big(2000));
    jest.spyOn(svc as any, 'sectionToday').mockResolvedValue(big(2000));
    jest.spyOn(svc as any, 'sectionCloudProfile').mockResolvedValue(big(2000));
    jest.spyOn(svc as any, 'sectionBusiness').mockResolvedValue(big(2000));
    jest.spyOn(svc as any, 'sectionHistory').mockResolvedValue(big(2000));

    const out = await svc.build('u1', 'voice-launcher', { device: big(2000) });

    expect(out.text).toContain('СЕЙЧАС');
    expect(out.sections.find((s) => s.name === 'now')!.dropped).toBe(false);
    expect(out.sections.find((s) => s.name === 'history')!.dropped).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(TOTAL_BUDGET);
  });

  it('секция device не собирается для веб-звонка: у веба нет устройства', async () => {
    const svc = new ContextService(pgEmpty());
    jest.spyOn(svc as any, 'sectionNow').mockResolvedValue('СЕЙЧАС');

    const out = await svc.build('u1', 'voice-web', { device: 'ЛИЧНОЕ-С-ТЕЛЕФОНА' });

    expect(out.text).not.toContain('ЛИЧНОЕ-С-ТЕЛЕФОНА');
    expect(out.sections.some((s) => s.name === 'device')).toBe(false);
  });

  it('выжимка с устройства идёт ВЫШЕ облачного профиля (правило приоритета)', async () => {
    const svc = new ContextService(pgEmpty());
    jest.spyOn(svc as any, 'sectionCloudProfile').mockResolvedValue('ОБЛАЧНЫЙ-ПРОФИЛЬ');

    const out = await svc.build('u1', 'voice-launcher', { device: 'С-УСТРОЙСТВА' });

    expect(out.text.indexOf('С-УСТРОЙСТВА')).toBeLessThan(out.text.indexOf('ОБЛАЧНЫЙ-ПРОФИЛЬ'));
  });

  it('упавший источник не роняет сборку — звонок дороже секции', async () => {
    const svc = new ContextService(pgEmpty());
    jest.spyOn(svc as any, 'sectionNow').mockResolvedValue('СЕЙЧАС');
    jest.spyOn(svc as any, 'sectionToday').mockRejectedValue(new Error('Neo4j прилёг'));

    const out = await svc.build('u1', 'voice-launcher');

    expect(out.text).toContain('СЕЙЧАС');
    expect(out.sections.some((s) => s.name === 'today')).toBe(false);
  });

  it('время берётся из пояса клиента, мусорный пояс не роняет', async () => {
    const svc = new ContextService(pgEmpty());

    const good = await svc.build('u1', 'voice-launcher', { clientTz: 'Europe/Lisbon' });
    expect(good.text).toContain('Europe/Lisbon');

    // ⚠️ Имя пояса в промпте должно совпадать с тем, по которому посчитано
    // время. Пока подмена происходила внутри форматирования, промпт называл
    // отвергнутый пояс и выдавал под ним чужие часы.
    const bad = await svc.build('u1', 'voice-launcher', { clientTz: '; DROP TABLE' });
    expect(bad.text).toContain('Asia/Yekaterinburg');
    expect(bad.text).not.toContain('DROP TABLE');
  });

  it('день собирается из состояния лаунчера и несёт отметку снимка', async () => {
    const trip = {
      getState: jest.fn().mockResolvedValue({
        headline: '',
        contextLines: [],
        events: [{ at: '2026-10-05T14:00:00+05:00', title: 'Разбор макетов', conflict: false }],
        tasks: [{ uid: 't1', title: 'Оплатить интернет', status: 'pending' }],
      }),
    } as any;
    const svc = new ContextService(pgEmpty(), trip);

    const text = await (svc as any).sectionToday('u1', 'Asia/Yekaterinburg');

    expect(text).toContain('14:00 — Разбор макетов');
    expect(text).toContain('дело: Оплатить интернет');
    expect(text).toContain('данные на');
  });
});

describe('ContextService.scheduleText', () => {
  it('отдаёт только «сейчас» и «сегодня» — для запроса посреди разговора', async () => {
    const trip = {
      getState: jest.fn().mockResolvedValue({
        headline: '', contextLines: [],
        events: [{ at: '2026-10-06T16:00:00+05:00', title: 'Эпиляция', conflict: false }],
        tasks: [],
      }),
    } as any;
    const svc = new ContextService(pgEmpty(), trip);
    jest.spyOn(svc as any, 'sectionCloudProfile').mockResolvedValue('ОБЛАЧНЫЙ-ПРОФИЛЬ');

    const text = await svc.scheduleText('u1');

    expect(text).toContain('--- Сейчас ---');
    expect(text).toContain('16:00 — Эпиляция');
    // В расписание не должно утекать ничего лишнего: это ответ на вопрос
    // «сколько времени и что у меня дальше», а не второй полный контекст.
    expect(text).not.toContain('ОБЛАЧНЫЙ-ПРОФИЛЬ');
  });

  it('упавший календарь не роняет инструмент — разговор ждёт ответа', async () => {
    const trip = { getState: jest.fn().mockRejectedValue(new Error('календарь прилёг')) } as any;
    const svc = new ContextService(pgEmpty(), trip);

    const text = await svc.scheduleText('u1');

    expect(text).toContain('--- Сейчас ---');
  });
});

/**
 * ⚠️ Звонок владельца 28.10.2026: разговор оборвался на 4-й минуте, человек
 * перезвонил через 20 секунд, и Роман не помнил НИЧЕГО.
 *
 * Резюме прерванного разговора лежало в истории за 13 секунд до второго звонка
 * (карточка записана в 21:12:46, звонок начат в 21:12:59) — и до модели не
 * дошло. Блок «Из переписки» собирался от старых к новым, а потом обрезался по
 * потолку секции с КОНЦА: из 7663 знаков выживали первые 1800, то есть
 * переписка за 10–11 октября. Самое свежее сообщение отрезало всегда, и чем
 * оно свежее, тем вернее.
 *
 * Разговор пришлось начинать заново — ровно то, чего человек не хотел.
 */
describe('ContextService: история набирается с конца', () => {
  /** Двадцать длинных сообщений — столько набирается у живого пользователя. */
  const chatRowsNewestFirst = () => {
    const rows: any[] = [{ sender_type: 'ai', content: 'САМОЕ-СВЕЖЕЕ ' + 'х'.repeat(400) }];
    for (let i = 0; i < 18; i++) {
      rows.push({ sender_type: 'ai', content: `середина ${i} ` + 'х'.repeat(400) });
    }
    rows.push({ sender_type: 'human', content: 'САМОЕ-СТАРОЕ ' + 'х'.repeat(400) });
    return rows;
  };
  const svcWithChat = () =>
    new ContextService({ query: jest.fn().mockResolvedValue({ rows: chatRowsNewestFirst() }) } as any);

  it('⚠️ ГЛАВНОЕ: в бюджет попадает последнее сообщение, а не первое', async () => {
    const text = await (svcWithChat() as any).sectionHistory('u1', 12, 1800);

    expect(text).toContain('САМОЕ-СВЕЖЕЕ');
    expect(text).not.toContain('САМОЕ-СТАРОЕ');
    expect(text.length).toBeLessThanOrEqual(1800);
  });

  it('порядок остаётся хронологическим: что старше — выше', async () => {
    const text = await (svcWithChat() as any).sectionHistory('u1', 12, 1800);

    expect(text.indexOf('середина 2')).toBeLessThan(text.indexOf('САМОЕ-СВЕЖЕЕ'));
  });
});

/**
 * Подхват прерванного разговора.
 *
 * Пересказ — не то же самое, что продолжение. Карточка звонка рассказывает о
 * человеке в третьем лице («Пользователь сказал, что ему было тяжело») и
 * живёт в общей переписке наравне с перепиской месячной давности. Когда
 * разговор оборвался минуту назад, нужен его ХВОСТ дословно и в самом верху
 * контекста — иначе человек обязан пересказывать сам.
 */
describe('ContextService: подхват недавнего разговора', () => {
  const tail = [
    { role: 'assistant', text: 'Привет, Роман на связи, слушаю.', ts: 1 },
    { role: 'user', text: 'Сегодня у младшего сына Вани шестой день рождения.', ts: 2 },
    { role: 'assistant', text: 'Поздравляю. Как прошёл день?', ts: 3 },
    { role: 'user', text: 'Было тяжело. Празднуем так, наверное, последний раз.', ts: 4 },
  ];
  const callRows = (minutesAgo: number, transcript: any[] = tail) => ({
    rows: [{
      id: 'call-1',
      ended_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      transcript,
    }],
  });
  const svcWithCall = (minutesAgo: number, transcript?: any[]) =>
    new ContextService({ query: jest.fn().mockResolvedValue(callRows(minutesAgo, transcript)) } as any);

  it('⚠️ ГЛАВНОЕ: берётся хвост разговора дословно, а не пересказ', async () => {
    const text = await (svcWithCall(1) as any).sectionContinuation('u1', 1200);

    expect(text).toContain('Празднуем так, наверное, последний раз');
    expect(text).toContain('минуту назад');
  });

  it('давний разговор подхватом не считается — для него есть карточка в переписке', async () => {
    expect(await (svcWithCall(180) as any).sectionContinuation('u1', 1200)).toBe('');
  });

  it('при нехватке бюджета отрезается НАЧАЛО разговора, а конец остаётся', async () => {
    const long = [
      { role: 'user', text: 'ПЕРВАЯ РЕПЛИКА ' + 'х'.repeat(400), ts: 1 },
      { role: 'assistant', text: 'вторая ' + 'х'.repeat(400), ts: 2 },
      { role: 'user', text: 'ПОСЛЕДНЯЯ РЕПЛИКА', ts: 3 },
    ];
    const text = await (svcWithCall(2, long) as any).sectionContinuation('u1', 500);

    expect(text).toContain('ПОСЛЕДНЯЯ РЕПЛИКА');
    expect(text).not.toContain('ПЕРВАЯ РЕПЛИКА');
    expect(text.length).toBeLessThanOrEqual(500);
  });

  it('звонок без реплик подхватывать нечего', async () => {
    expect(await (svcWithCall(1, []) as any).sectionContinuation('u1', 1200)).toBe('');
  });

  it('подхват стоит выше переписки и не вытесняется ею', async () => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (String(sql).includes('voice_calls')) return callRows(1);
        if (String(sql).includes('custom_chat_history')) {
          return { rows: [{ sender_type: 'ai', content: 'СТАРАЯ-ПЕРЕПИСКА' }] };
        }
        return { rows: [] };
      }),
    } as any;

    const out = await new ContextService(pg).build('u1', 'voice-launcher');

    expect(out.text.indexOf('последний раз')).toBeLessThan(out.text.indexOf('СТАРАЯ-ПЕРЕПИСКА'));
    expect(out.sections.find((s) => s.name === 'continuation')!.dropped).toBe(false);
  });
});

/**
 * ⚠️ Звонок владельца 29.10.2026: «по расписанию завтра утром у тебя йога в
 * 3:30, дальше с 6 утра уже рабочие дела».
 *
 * Йога стояла на 8:30, рабочие дела — с 11:00. Роман назвал UTC: секция дня
 * брала отметку события как строку и вырезала из неё знаки 11–16, то есть
 * часы и минуты ИЗ ISO, а ISO приходит из календаря в UTC
 * (`new Date(...).toISOString()` в calendar.ts и talerid-calendar.connector.ts).
 * На экране лаунчера то же событие рисуется через Intl и показывает 8:30 —
 * расходились не данные, а только то, что видел ассистент.
 *
 * Старый тест этого не ловил: в нём отметка была со смещением (+05:00), и
 * вырезанные знаки случайно совпадали с местным временем.
 */
describe('ContextService: день — часами собеседника, а не сервера', () => {
  const tripWith = (events: any[]) => ({
    getState: jest.fn().mockResolvedValue({ headline: '', contextLines: [], events, tasks: [] }),
  }) as any;

  beforeEach(() => {
    jest.useFakeTimers();
    // 29.10.2026, 22:33 в Екатеринбурге — время того самого звонка.
    jest.setSystemTime(new Date('2026-10-29T17:33:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('⚠️ ГЛАВНОЕ: отметка в UTC печатается местным временем', async () => {
    const svc = new ContextService(
      pgEmpty(),
      tripWith([{ at: '2026-10-29T03:30:00.000Z', title: 'Йога', conflict: false }]),
    );

    const text = await (svc as any).sectionToday('u1', 'Asia/Yekaterinburg');

    expect(text).toContain('08:30 — Йога');
    expect(text).not.toContain('03:30');
  });

  it('пояс собеседника применяется и ко дню, а не только к «сейчас»', async () => {
    const svc = new ContextService(
      pgEmpty(),
      tripWith([{ at: '2026-10-29T03:30:00.000Z', title: 'Йога', conflict: false }]),
    );

    const text = await (svc as any).sectionToday('u1', 'Europe/Moscow');

    expect(text).toContain('06:30 — Йога');
  });

  it('завтрашнее событие помечается днём: горизонт «сегодня» = сегодня + завтра', async () => {
    const svc = new ContextService(
      pgEmpty(),
      tripWith([
        { at: '2026-10-29T13:00:00.000Z', title: 'Созвон', conflict: false },
        { at: '2026-10-30T03:30:00.000Z', title: 'Йога', conflict: false },
      ]),
    );

    const text = await (svc as any).sectionToday('u1', 'Asia/Yekaterinburg');

    expect(text).toContain('18:00 — Созвон');
    expect(text).toContain('завтра 08:30 — Йога');
  });

  it('сборка целиком отдаёт секциям ОДИН пояс: «сейчас» и день не расходятся', async () => {
    const svc = new ContextService(
      pgEmpty(),
      tripWith([{ at: '2026-10-29T03:30:00.000Z', title: 'Йога', conflict: false }]),
    );

    const out = await svc.build('u1', 'voice-launcher', { clientTz: 'Europe/Moscow' });

    expect(out.text).toContain('Europe/Moscow');
    expect(out.text).toContain('06:30 — Йога');
  });

  it('мусорный пояс не роняет день — падает обратно на пояс по умолчанию', async () => {
    const svc = new ContextService(
      pgEmpty(),
      tripWith([{ at: '2026-10-29T03:30:00.000Z', title: 'Йога', conflict: false }]),
    );

    const out = await svc.build('u1', 'voice-launcher', { clientTz: 'Atlantis/Nowhere' });

    expect(out.text).toContain('08:30 — Йога');
  });
});
