import { RoutinePushService } from './routine-push.service';

/**
 * Канонический ключ энерго-рутины — `daily:<assistantId>`, а не 'energy_of_day':
 * app-widget.controller.ts проверяет включённость именно по нему (фикс 2026-08-23).
 */
const ENERGY_KIND = 'daily:14';

const preset = (over: any = {}) => ({
  id: 'r1',
  userId: 'u1',
  kind: ENERGY_KIND,
  title: 'Энергия дня',
  assistantId: '14',
  prompt: 'p',
  sendHour: 8,
  tz: 'Europe/Moscow',
  days: null,
  enabled: true,
  lastSentDate: null,
  ...over,
});

/**
 * Собирает сервис с заглушками. Порядок аргументов — как в конструкторе
 * routine-push.service.ts:17 — pg, push, chat, store.
 */
function makeService(store: any, push: any = { sendPush: jest.fn().mockResolvedValue(1) }) {
  return new RoutinePushService(
    { query: jest.fn().mockResolvedValue({ rows: [] }) } as any,          // pg
    push as any,                                                          // push
    { generateAgentReply: jest.fn().mockResolvedValue('текст') } as any,  // chat
    store as any,                                                         // store
  );
}

describe('ensureEnergyPreset: опознание по kind', () => {
  it('находит существующий пресет с нерусским заголовком и не создаёт дубль', async () => {
    const store = {
      list: jest.fn().mockResolvedValue([preset({ title: 'Energy of the day' })]),
      create: jest.fn(),
      knownTz: jest.fn().mockResolvedValue('Asia/Tashkent'),
    };
    const svc = makeService(store);

    const r = await svc.ensureEnergyPreset('u1');

    expect(store.create).not.toHaveBeenCalled();
    expect(r.id).toBe('r1');
  });

  it('не принимает за пресет пользовательскую рутину, названную «Энергия дня»', async () => {
    const store = {
      list: jest.fn().mockResolvedValue([preset({ kind: 'custom' })]),
      create: jest.fn().mockResolvedValue(preset({ id: 'r2' })),
      knownTz: jest.fn().mockResolvedValue(null),
    };
    const svc = makeService(store);

    const r = await svc.ensureEnergyPreset('u1');

    expect(store.create).toHaveBeenCalled();
    expect(r.id).toBe('r2');
  });

  it('создаёт пресет с kind=daily:14 — ключом, который читает app-widget', async () => {
    const store = {
      list: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(preset()),
      knownTz: jest.fn().mockResolvedValue(null),
    };
    const svc = makeService(store);

    await svc.ensureEnergyPreset('u1');

    expect(store.create.mock.calls[0][1]).toMatchObject({ kind: ENERGY_KIND });
  });
});

describe('deliver: выбор заголовка по kind', () => {
  it('энерго-рутина получает свой заголовок, а не «Напоминание»', async () => {
    const sendPush = jest.fn().mockResolvedValue(1);
    const store = { getById: jest.fn().mockResolvedValue(preset()) };
    const svc = makeService(store, { sendPush });

    await svc.fireNow('u1', 'r1');

    expect(sendPush.mock.calls[0][1].title).toBe('Энергия дня от Райи 🌅');
  });

  it('обычная рутина с заголовком «Энергия дня» энергетической не считается', async () => {
    const sendPush = jest.fn().mockResolvedValue(1);
    const store = { getById: jest.fn().mockResolvedValue(preset({ kind: 'custom' })) };
    const svc = makeService(store, { sendPush });

    await svc.fireNow('u1', 'r1');

    expect(sendPush.mock.calls[0][1].title).toMatch(/·/);
  });
});
