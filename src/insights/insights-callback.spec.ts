import { backlogAnalysis, backlogCounts, InsightsCallbackService, parseInsightsCallback, shouldRouteToInsights } from './insights-callback.service';

const ID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

const finding = {
  id: ID,
  type: 'confused' as const,
  title: 'Путают два вида ботов',
  description: 'Идут за своим ботом во вкладку групповых ботов',
  proposal: 'Дать во вкладке ссылку на Продукты',
  status: 'open' as const,
  firstWeek: '2026-10-12',
  people: 4,
  conversations: 6,
  assistants: ['Роман'],
  weeks: 2,
  runFindingIds: [ID],
};

function harness(over: { claim?: boolean; reject?: boolean; createFails?: boolean; linkFails?: boolean; messageIds?: string[] | null } = {}) {
  const store = {
    findingIdsForMessage: jest.fn(async () => over.messageIds ?? null),
    findingForCallback: jest.fn(async () => finding),
    claimBacklog: jest.fn(async () => over.claim ?? true),
    setBacklogItem: jest.fn(async () => {
      if (over.linkFails) throw new Error('db hiccup');
    }),
    revertToOpen: jest.fn(),
    reject: jest.fn(async () => over.reject ?? true),
    statuses: jest.fn(async () => new Map([[ID, 'backlog'], [OTHER, 'open']])),
  };
  const backlog = {
    create: jest.fn(async () => {
      if (over.createFails) throw new Error('db down');
      return { id: 'item-1' };
    }),
    addComment: jest.fn(),
  };
  const editMessageReplyMarkup = jest.fn();
  const tg = { answerCallbackQuery: jest.fn(async () => undefined), getBot: () => ({ api: { editMessageReplyMarkup } }) };
  const svc = new InsightsCallbackService(store as any, backlog as any, tg as any);
  return { svc, store, backlog, tg, editMessageReplyMarkup };
}

const cb = (data: string, from = 42, chat = 42) => ({ id: 'cb1', data, from: { id: from }, message: { message_id: 9, chat: { id: chat } } });

describe('разбор кнопок', () => {
  it('префикс и форма', () => {
    expect(shouldRouteToInsights('ins:b:x')).toBe(true);
    expect(shouldRouteToInsights('blog:ok:x')).toBe(false);
    expect(parseInsightsCallback(`ins:b:${ID}`)).toEqual({ action: 'b', findingId: ID });
    expect(parseInsightsCallback('ins:b:not-a-uuid')).toBeNull();
  });
});

describe('текст задачи бэклога', () => {
  it('в описании нет цифр о людях, они — в комментарии', () => {
    expect(backlogAnalysis(finding)).not.toMatch(/\d/);
    expect(backlogCounts(finding)).toContain('людей — 4, разговоров — 6');
  });
});

describe('InsightsCallbackService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.INSIGHTS_TG_CHAT_ID = '42';
  });
  afterEach(() => {
    process.env = { ...env };
  });

  it('чужой аккаунт — отказ, ничего не меняется', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`, 7));
    expect(h.tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', { text: 'Недоступно' });
    expect(h.store.claimBacklog).not.toHaveBeenCalled();
  });

  it('кнопка из чужого чата — отказ', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`, 42, -100));
    expect(h.store.claimBacklog).not.toHaveBeenCalled();
  });

  it('«В бэклог»: задача одобрена, без цифр, счётчики комментарием, клавиатура обновлена', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.backlog.create).toHaveBeenCalledWith('insights', { title: finding.title, analysis_md: backlogAnalysis(finding), status: 'approved' });
    expect(h.store.setBacklogItem).toHaveBeenCalledWith(ID, 'item-1');
    expect(h.backlog.addComment).toHaveBeenCalledWith('item-1', 'insights', backlogCounts(finding));
    expect(h.editMessageReplyMarkup).toHaveBeenCalledWith(42, 9, {
      reply_markup: { inline_keyboard: [[{ text: '1 ✓ В бэклоге', callback_data: `ins:noop:${ID}` }]] },
    });
    expect(h.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', { text: 'В бэклоге' });
  });

  it('повторное нажатие — «Уже обработано», задача не заводится второй раз', async () => {
    const h = harness({ claim: false });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.backlog.create).not.toHaveBeenCalled();
    expect(h.tg.answerCallbackQuery).toHaveBeenCalledWith('cb1', { text: 'Уже обработано' });
  });

  it('задача не завелась — находка снова открыта', async () => {
    const h = harness({ createFails: true });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.store.revertToOpen).toHaveBeenCalledWith(ID);
  });

  it('задача создана, а привязка упала — находка не откатывается, второй задачи не будет', async () => {
    const h = harness({ linkFails: true });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.store.revertToOpen).not.toHaveBeenCalled();
    expect(h.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', { text: 'В бэклоге' });
  });

  it('клавиатура — по тому сообщению, где нажали', async () => {
    const h = harness({ messageIds: [OTHER, ID] });
    await h.svc.handleCallback(cb(`ins:b:${ID}`));
    expect(h.store.findingIdsForMessage).toHaveBeenCalledWith(42, 9);
    expect(h.editMessageReplyMarkup).toHaveBeenCalledWith(42, 9, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '1 → В бэклог', callback_data: `ins:b:${OTHER}` },
            { text: '1 ✗ Отклонить', callback_data: `ins:r:${OTHER}` },
          ],
          [{ text: '2 ✓ В бэклоге', callback_data: `ins:noop:${ID}` }],
        ],
      },
    });
  });

  it('«Отклонить» запоминает число людей', async () => {
    const h = harness();
    await h.svc.handleCallback(cb(`ins:r:${ID}`));
    expect(h.store.reject).toHaveBeenCalledWith(ID, 4);
    expect(h.tg.answerCallbackQuery).toHaveBeenLastCalledWith('cb1', { text: 'Отклонено' });
  });
});
