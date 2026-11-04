jest.mock('@napi-rs/canvas', () => ({
  createCanvas: jest.fn(),
  loadImage: jest.fn(),
  GlobalFonts: { register: jest.fn() },
}));
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
  tool: (name: string, description: string, schema: any, handler: any) => ({ name, description, schema, handler }),
  createSdkMcpServer: (o: any) => o,
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { SupportService } from './support.service';
import { LIMITS, SUPPORT_MODEL } from './support.dto';

/** pg с одним тикетом и одной репликой пользователя; запоминает записанные ответы. */
function makePg() {
  const inserted: Array<{ sender: string; content: string }> = [];
  const pg = {
    query: jest.fn(async (sql: string, params?: any[]) => {
      if (/SELECT user_id FROM support_tickets/.test(sql)) return { rows: [{ user_id: 'u1' }] };
      if (/FROM support_messages/.test(sql)) {
        return { rows: [{ sender_type: 'user', content: 'Как сменить ключ бота?' }] };
      }
      if (/FROM ai_profiles_consolidated/.test(sql)) {
        return { rows: [{ tokens: 1000, profile_data: { language: 'ru' }, created_at: '2026-10-01' }] };
      }
      if (/INSERT INTO support_messages/.test(sql)) {
        inserted.push({ sender: params?.[1], content: params?.[3] });
        return { rows: [{}] };
      }
      return { rows: [] };
    }),
  };
  return { pg, inserted };
}

function stream(events: any[]) {
  return (async function* () { for (const e of events) yield e; })();
}
const assistant = (content: any[]) => ({ type: 'assistant', message: { content } });

describe('ход ИИ-поддержки', () => {
  afterEach(() => (query as jest.Mock).mockReset());

  it('модель и предел шагов — из настроек поддержки', async () => {
    (query as jest.Mock).mockReturnValue(stream([assistant([{ type: 'text', text: 'Ответ.' }])]));
    const { pg } = makePg();
    await (new SupportService(pg as any) as any).generateAiResponse('t-1', 'u1');
    const options = (query as jest.Mock).mock.calls[0][0].options;
    expect(SUPPORT_MODEL).toBe('claude-sonnet-5');
    expect(options.model).toBe(SUPPORT_MODEL);
    expect(options.maxTurns).toBe(LIMITS.AI_MAX_TURNS);
  });

  it('человек получает только реплику после вызова инструмента', async () => {
    (query as jest.Mock).mockReturnValue(stream([
      assistant([{ type: 'text', text: 'Я передам вопрос команде.' }]),
      assistant([{ type: 'tool_use', name: 'mcp__support-tools__escalate_to_owner', input: {} }]),
      assistant([{ type: 'text', text: 'Вопрос передан команде.' }]),
    ]));
    const { pg, inserted } = makePg();
    await (new SupportService(pg as any) as any).generateAiResponse('t-1', 'u1');
    expect(inserted.filter((m) => m.sender === 'ai').map((m) => m.content)).toEqual(['Вопрос передан команде.']);
  });
});
