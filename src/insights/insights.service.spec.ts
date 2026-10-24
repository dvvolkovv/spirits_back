import { InsightsService, MAX_POSTPONES } from './insights.service';
import { weekOf } from './insights-week';
import { emptySignals } from './insights.types';

const week = weekOf('2026-10-19');

function harness(
  over: { labelText?: string[]; synthText?: string[]; claudeError?: string; lock?: boolean; attempts?: number; rerun?: boolean; active?: string } = {},
) {
  const calls: Array<{ prompt: string; opts: any }> = [];
  const labelQueue = [...(over.labelText ?? ['[{"conv":1,"items":[{"type":"confused","about":"путает два вида ботов","severity":2}]}]'])];
  const synthQueue = [
    ...(over.synthText ?? [
      JSON.stringify({
        findings: [{ prior_id: null, type: 'confused', title: 'Путают боты', description: 'Идут не во ту вкладку', proposal: 'Дать ссылку', people: [1], severity: 2 }],
      }),
    ]),
  ];
  const claude = {
    textWithCost: jest.fn(async (prompt: string, opts: any) => {
      calls.push({ prompt, opts });
      if (over.claudeError) throw new Error(over.claudeError);
      const queue = opts.model === 'claude-haiku-4-5' ? labelQueue : synthQueue;
      return { text: queue.length > 1 ? queue.shift()! : queue[0], costUsd: 0.01 };
    }),
  };
  const lock = { release: jest.fn() };
  const pg = { tryAdvisoryLock: jest.fn(async () => (over.lock === false ? null : lock)) };
  const order: string[] = [];
  const store = {
    activeRun: jest.fn(async () => (over.active ?? null) as string | null),
    createRun: jest.fn(async () => 'run-new'),
    weekHasResults: jest.fn(async () => over.rerun ?? false),
    resetWeek: jest.fn(async () => {
      order.push('reset');
    }),
    priorFindings: jest.fn(async () => {
      order.push('prior');
      return [];
    }),
    saveFindings: jest.fn(async (_w: string, list: any[]) => list.map((f, i) => ({ ...f, id: `id-${i}`, status: 'open', weeksSeen: 1, prevPeople: null }))),
    finishRun: jest.fn(),
    failRun: jest.fn(),
    postponeRun: jest.fn(async () => over.attempts ?? 1),
    setDigest: jest.fn(),
  };
  const collector = {
    collect: jest.fn(async () => ({
      conversations: [
        {
          key: 'web:79990000001_12',
          source: 'web',
          userId: '79990000001',
          assistant: 'Роман',
          turns: [
            { role: 'user', text: 'Я Владимир, почта vova@mail.ru, телефон 8 903 016 91 87' },
            { role: 'assistant', text: 'ответ' },
          ],
        },
      ],
      signals: emptySignals(),
      names: new Map([['79990000001', ['Владимир']]]),
    })),
  };
  const tg = { sendMessage: jest.fn(async () => ({ message_id: 555 })) };
  const svc = new InsightsService(store as any, collector as any, claude as any, pg as any, tg as any);
  return { svc, calls, store, tg, lock, claude, order };
}

describe('InsightsService.startManual', () => {
  it('второй клик, пока прогон недели идёт, возвращает его, а не заводит новый', async () => {
    const h = harness({ active: 'run-busy' });
    await expect(h.svc.startManual(week)).resolves.toBe('run-busy');
    expect(h.store.createRun).not.toHaveBeenCalled();
  });
});

describe('InsightsService.execute', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INSIGHTS_TG_CHAT_ID = '42';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('счастливый путь: разметка, сводка, запись, сводка владельцу с кнопками', async () => {
    const h = harness();
    await h.svc.execute('run-1', week);
    expect(h.store.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ conversations: 1, people: 1, costUsd: 0.02 }));
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Затыки недели · 19–25 окт'), {
      reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
    });
    expect(h.store.setDigest).toHaveBeenCalledWith('run-1', 42, 555, ['id-0']);
    expect(h.lock.release).toHaveBeenCalled();
  });

  it('модели не уходят телефон, почта, имя и userId', async () => {
    const h = harness();
    await h.svc.execute('run-1', week);
    const all = h.calls.map((c) => c.prompt).join('\n');
    expect(all).not.toMatch(/Владимир|vova@mail\.ru|903|79990000001/);
  });

  it('повтор той же недели сначала сбрасывает её итоги, потом читает прошлые находки', async () => {
    const h = harness({ rerun: true });
    await h.svc.execute('run-2', week);
    expect(h.store.resetWeek).toHaveBeenCalledWith('2026-10-19');
    expect(h.order).toEqual(['reset', 'prior']);
  });

  it('первый прогон недели ничего не сбрасывает', async () => {
    const h = harness();
    await h.svc.execute('run-1', week);
    expect(h.store.resetWeek).not.toHaveBeenCalled();
  });

  it('второй прогон при занятом замке не идёт', async () => {
    const h = harness({ lock: false });
    await h.svc.execute('run-1', week);
    expect(h.store.failRun).toHaveBeenCalledWith('run-1', 'другой прогон уже идёт');
    expect(h.claude.textWithCost).not.toHaveBeenCalled();
  });

  it('сводка дважды не по форме — прогон failed и сообщение владельцу', async () => {
    const h = harness({ synthText: ['мусор'] });
    await h.svc.execute('run-1', week);
    expect(h.store.failRun).toHaveBeenCalledWith('run-1', 'сводка не разобралась дважды');
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('сводка не собралась'));
  });

  it('разметка дважды не по форме — пачка пропущена, прогон доходит до конца', async () => {
    const h = harness({ labelText: ['мусор'] });
    await h.svc.execute('run-1', week);
    expect(h.store.finishRun).toHaveBeenCalled();
    expect(h.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('Затыков на этой неделе не нашлось.'), {});
  });

  it('недельный лимит — отложить без сообщения, а на третий раз — failed и сообщение', async () => {
    const first = harness({ claudeError: "You've hit your usage limit", attempts: 1 });
    await first.svc.execute('run-1', week);
    expect(first.store.postponeRun).toHaveBeenCalled();
    expect(first.tg.sendMessage).not.toHaveBeenCalled();

    const last = harness({ claudeError: "You've hit your usage limit", attempts: MAX_POSTPONES });
    await last.svc.execute('run-1', week);
    expect(last.store.failRun).toHaveBeenCalledWith('run-1', expect.stringContaining('лимит подписки'));
    expect(last.tg.sendMessage).toHaveBeenCalledWith(42, expect.stringContaining('сводка не собралась'));
  });
});
