/**
 * Четвёртый путь сборки промпта — SMM-продюсер (Юля, agent.name='smm_producer',
 * category='business' в прод-базе), через Claude Agent SDK с возобновлением
 * сессии (profile_data.smm_sdk_session_id).
 *
 * До этой правки chat.service.ts уводил Юлю в отдельную ветку ДО
 * streamUniversalAgent (см. business-profile-injection.spec.ts) — она не видела
 * ни бизнес-карточку в system prompt, ни писала в неё факты.
 *
 * Системный промпт (ctxBlock + SMM_PRODUCER_SYSTEM_PROMPT) собирается заново
 * на каждый вызов streamSmmProducer — в том числе и при resume: ctx.balanceBlock
 * уже доказывает это (волатильный баланс доезжает и в резюмируемую сессию),
 * поэтому карточку можно вставлять тем же механизмом, без переделки SDK-мостика.
 */
const mockSdkQuery = jest.fn();
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: any[]) => mockSdkQuery(...args),
  tool: (name: string, description: string, schema: any, handler: any) => ({ name, description, schema, handler }),
  createSdkMcpServer: (opts: any) => opts,
}));

import { ClaudeAgentService } from './claude-agent.service';

async function* fakeSdkEvents() {
  yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
  yield {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Привет! Помогу с контентом.' } },
  };
  yield { type: 'result', total_cost_usd: 0.001, usage: {} };
}

function makeRes() {
  return {
    write: jest.fn(() => true),
    end: jest.fn(),
  } as any;
}

function makePg() {
  return {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM/i.test(sql)) return { rows: [{ tokens: 100000 }] };
      if (/smm_sdk_session_id/i.test(sql)) return { rows: [{ sid: null }] };
      return { rows: [], rowCount: 1 };
    }),
  } as any;
}

function makeService(bizBlock: string) {
  const pg = makePg();
  const smmTools = { handle: jest.fn() } as any;
  const businessProfile = {
    renderForPrompt: jest.fn(async () => bizBlock),
    extractFromTurn: jest.fn(async () => {}),
  } as any;
  const svc = new ClaudeAgentService(pg, smmTools, businessProfile);
  return { svc, pg, businessProfile };
}

describe('SMM-путь (Юля) — бизнес-карточка', () => {
  beforeEach(() => {
    mockSdkQuery.mockReset();
    mockSdkQuery.mockImplementation(() => fakeSdkEvents());
  });

  it('рендерит карточку через renderForPrompt(userId, category) и кладёт её в system prompt SDK-вызова', async () => {
    const { svc, businessProfile } = makeService('Business profile:\nWhat the business does: студия маникюра');
    const res = makeRes();

    await svc.streamSmmProducer(
      { userId: 'u1', isAdmin: false, balanceBlock: '' },
      'привет',
      'u1_15',
      15,
      res,
      'business',
      false,
    );

    expect(businessProfile.renderForPrompt).toHaveBeenCalledWith('u1', 'business');
    const callArgs = mockSdkQuery.mock.calls[0][0];
    expect(callArgs.options.systemPrompt).toContain('студия маникюра');
  });

  it('не добавляет пустую строку в system prompt, когда карточки ещё нет', async () => {
    const { svc } = makeService('');
    const res = makeRes();

    await svc.streamSmmProducer(
      { userId: 'u1', isAdmin: false, balanceBlock: '' },
      'привет',
      'u1_15',
      15,
      res,
      'business',
      false,
    );

    const callArgs = mockSdkQuery.mock.calls[0][0];
    // Не должно быть трёх подряд переводов строки — след пустой вставки между блоками.
    expect(callArgs.options.systemPrompt).not.toMatch(/\n{3,}/);
  });

  it('зовёт extractFromTurn с полным текстом ответа после завершения хода', async () => {
    const { svc, businessProfile } = makeService('');
    const res = makeRes();

    await svc.streamSmmProducer(
      { userId: 'u1', isAdmin: false, balanceBlock: '' },
      'у меня студия маникюра, 4 мастера',
      'u1_15',
      15,
      res,
      'business',
      false,
    );

    expect(businessProfile.extractFromTurn).toHaveBeenCalledWith(
      'u1',
      '15',
      'у меня студия маникюра, 4 мастера',
      expect.stringContaining('Привет! Помогу с контентом.'),
    );
  });

  it('не зовёт extractFromTurn в fresh-режиме (чистый лист)', async () => {
    const { svc, businessProfile } = makeService('');
    const res = makeRes();

    await svc.streamSmmProducer(
      { userId: 'u1', isAdmin: false, balanceBlock: '' },
      'у меня студия маникюра',
      'u1_15',
      15,
      res,
      'business',
      true,
    );

    expect(businessProfile.extractFromTurn).not.toHaveBeenCalled();
  });
});
