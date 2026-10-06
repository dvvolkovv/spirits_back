import { ContextService } from './context.service';
import { TOTAL_BUDGET } from './context.types';

const pgEmpty = () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }) as any;

describe('ContextService', () => {
  it('при переполнении общего бюджета вытесняется самая низкоранговая секция', async () => {
    // Сумма посекционных потолков (6770) больше общего (6000), поэтому
    // вытеснение включается только когда секции набиты почти под завязку.
    // Режется history: разговор её восстановит, а пропущенную встречу — нет.
    const svc = new ContextService(pgEmpty());
    const big = (n: number) => 'х'.repeat(n);
    jest.spyOn(svc as any, 'sectionNow').mockResolvedValue('СЕЙЧАС');
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

    const good = await (svc as any).sectionNow('Europe/Lisbon');
    expect(good).toContain('Europe/Lisbon');

    const bad = await (svc as any).sectionNow('; DROP TABLE');
    expect(bad).toContain('Asia/Yekaterinburg');
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

    const text = await (svc as any).sectionToday('u1');

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
