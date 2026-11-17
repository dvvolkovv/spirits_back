import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { ChatContextResetService } from '../context-reset/context-reset.service';
import { ActionPlansService, parseGeneratedActionPlan } from './action-plans.service';

describe('parseGeneratedActionPlan', () => {
  it('reads JSON from a fenced model response', () => {
    expect(parseGeneratedActionPlan('```json\n{"title":"Переезд","summary":"Подготовиться спокойно","items":["Составить список вещей","Забронировать транспорт"]}\n```')).toEqual({
      title: 'Переезд',
      summary: 'Подготовиться спокойно',
      items: ['Составить список вещей', 'Забронировать транспорт'],
    });
  });

  it('rejects a response without actionable items', () => {
    expect(() => parseGeneratedActionPlan('{"title":"План","items":[]}')).toThrow('incomplete');
    expect(() => parseGeneratedActionPlan('not json')).toThrow('not JSON');
  });
});

describe('ActionPlansService', () => {
  const row = {
    id: 'plan-1', assistant_id: '12', title: 'Новый план', summary: 'Кратко',
    items: [], created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z',
  };

  // resets — сервис точки «Чистого листа», как его отдаёт DI; без него — как
  // в графе без ContextResetModule (@Optional).
  function setup(
    resets?: { get: jest.Mock },
    raw = '{"title":"Новый план","summary":"Кратко","items":["Первый шаг","Второй шаг"]}',
  ) {
    const pg = { query: jest.fn() };
    const chat = {
      getChatHistory: jest.fn().mockResolvedValue({ messages: [
        { type: 'user', content: 'Нужно подготовиться к переезду' },
        { type: 'assistant', content: 'Начни со списка вещей' },
      ] }),
      generateAgentReply: jest.fn().mockResolvedValue(raw),
    };
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM action_plans')) return { rows: [] };
      return { rows: [row] };
    });
    return { service: new ActionPlansService(pg as any, chat as any, resets as any), pg, chat };
  }

  it('generates in an isolated session without writing to chat history', async () => {
    const { service, chat, pg } = setup();
    await service.generate('user-1', '12');
    expect(chat.generateAgentReply).toHaveBeenCalledWith(
      'user-1', '12', expect.stringContaining('Return ONLY valid JSON'), expect.stringMatching(/^action_plan_/),
    );
    expect(pg.query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (user_id, session_id)'), expect.any(Array));
  });

  // «Чистый лист» — точка отсчёта (spec 2026-11-17-context-reset): лента одна,
  // а план — только по разговору после точки.
  const beforeAndAfterReset = { hasMore: false, messages: [
    { type: 'user', content: 'СТАРЫЙ вопрос', timestamp: '2026-11-10T09:00:00Z' },
    { type: 'assistant', content: 'СТАРЫЙ ответ', timestamp: '2026-11-10T09:00:01Z' },
    { type: 'user', content: 'НОВЫЙ вопрос', timestamp: '2026-11-17T09:00:00Z' },
    { type: 'assistant', content: 'НОВЫЙ ответ', timestamp: '2026-11-17T09:00:01Z' },
  ] };

  const resetsAt = (iso: string) => ({ get: jest.fn(async () => new Date(iso)) });

  it('строит план по сообщениям после точки «Чистого листа»', async () => {
    const resets = resetsAt('2026-11-17T00:00:00Z');
    const { service, chat } = setup(resets);
    chat.getChatHistory.mockResolvedValue(beforeAndAfterReset);
    await service.generate('u1', '10');
    expect(resets.get).toHaveBeenCalledWith('u1', '10');
    // История — основной ленты, без подмены сессии.
    expect(chat.getChatHistory).toHaveBeenCalledWith('u1', '10', 30, 0);
    const prompt = chat.generateAgentReply.mock.calls[0][2];
    expect(prompt).toContain('НОВЫЙ вопрос');
    expect(prompt).toContain('НОВЫЙ ответ');
    expect(prompt).not.toContain('СТАРЫЙ');
  });

  it('после точки разговора ещё нет — 400, как при пустой истории, и модель не зовётся', async () => {
    const { service, chat, pg } = setup(resetsAt('2026-11-17T12:00:00Z'));
    chat.getChatHistory.mockResolvedValue(beforeAndAfterReset);
    const error = await service.generate('u1', '10').catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('not enough conversation for an action plan');
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO action_plans'), expect.anything());
  });

  it('после точки только вопрос, ответа ассистента ещё нет — 400, и модель не зовётся', async () => {
    const { service, chat, pg } = setup(resetsAt('2026-11-17T00:00:00Z'));
    chat.getChatHistory.mockResolvedValue({ hasMore: false, messages: [
      ...beforeAndAfterReset.messages.slice(0, 3),
    ] });
    const error = await service.generate('u1', '10').catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.message).toBe('not enough conversation for an action plan');
    expect(chat.generateAgentReply).not.toHaveBeenCalled();
    expect(pg.query).not.toHaveBeenCalledWith(expect.stringContaining('INSERT INTO action_plans'), expect.anything());
  });

  it('сбой чтения точки — план строится по всей выборке, а не падает; в журнале пара без разговора', async () => {
    const { service, chat } = setup({ get: jest.fn(async () => { throw new Error('db down'); }) });
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    chat.getChatHistory.mockResolvedValue(beforeAndAfterReset);
    await expect(service.generate('u1', '10')).resolves.toBeDefined();
    const prompt = chat.generateAgentReply.mock.calls[0][2];
    expect(prompt).toContain('СТАРЫЙ вопрос');
    expect(prompt).toContain('НОВЫЙ вопрос');
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('u1_10');
    expect(line).not.toMatch(/СТАРЫЙ|НОВЫЙ/);
  });

  it('хранит план по основной ленте', async () => {
    const { service, pg } = setup();
    await service.generate('u1', '10');
    const insert = pg.query.mock.calls.find(([sql]) => /INSERT INTO action_plans/.test(String(sql)));
    expect(insert?.[1][1]).toBe('u1_10');
  });

  it('freshTs старого клиента не уводит план в отдельную ленту', async () => {
    const { service, chat, pg } = setup();
    await (service.generate as any).call(service, 'u1', '10', '1786468316338');
    expect(chat.getChatHistory).toHaveBeenCalledWith('u1', '10', 30, 0);
    const insert = pg.query.mock.calls.find(([sql]) => /INSERT INTO action_plans/.test(String(sql)));
    expect(insert?.[1][1]).toBe('u1_10');

    await (service.findForConversation as any).call(service, 'u1', '10', '1786468316338');
    const select = pg.query.mock.calls.filter(([sql]) => /SELECT \* FROM action_plans/.test(String(sql))).pop();
    expect(select?.[1]).toEqual(['u1', 'u1_10']);
  });

  // @Optional и класс, а не import type: иначе Nest не найдёт провайдер и
  // план тихо останется без точки (тот же экземпляр в графе AppModule —
  // chat-uploads/chat-uploads.di.spec.ts).
  it('объявляет сервис точки классом ChatContextResetService', () => {
    expect(Reflect.getMetadata('design:paramtypes', ActionPlansService)).toContain(ChatContextResetService);
  });

  it('keeps completion for unchanged steps when regenerating', async () => {
    const { service, pg } = setup();
    pg.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM action_plans')) return { rows: [{ ...row, items: [{ id: 'old', text: 'Первый шаг', done: true }] }] };
      return { rows: [row] };
    });
    await service.generate('user-1', '12');
    const insert = pg.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO action_plans'));
    const items = JSON.parse(insert?.[1][5]);
    expect(items[0].done).toBe(true);
    expect(items[1].done).toBe(false);
  });

  it('scopes edits and deletion to the plan owner', async () => {
    const { service, pg } = setup();
    pg.query.mockResolvedValue({ rows: [row] });
    await service.update('user-1', 'plan-1', { title: 'План', summary: '', items: [{ id: 'one', text: 'Шаг', done: false }] });
    expect(pg.query.mock.calls[0][1].slice(-2)).toEqual(['plan-1', 'user-1']);
    await service.remove('user-1', 'plan-1');
    expect(pg.query.mock.calls[1][1]).toEqual(['plan-1', 'user-1']);
  });
});
