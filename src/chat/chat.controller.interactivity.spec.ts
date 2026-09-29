import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

const PHONE = '79030169187';

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

function makeRes() {
  const written: any[] = [];
  return {
    written,
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn((s: string) => { try { written.push(JSON.parse(s)); } catch {} return true; }),
    end: jest.fn(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: PHONE })) };

describe('POST soulmate/chat: ui доезжает до сервиса', () => {
  const run = async (body: any) => {
    const streamChat = jest.fn(async () => {});
    const ctrl = new ChatController({ streamChat } as any, jwtSvc as any, undefined as any, undefined);
    await ctrl.chat(
      { headers: { authorization: 'Bearer t' }, body: { chatInput: 'привет', assistant: '12', ...body } } as any,
      makeRes(),
    );
    const args = streamChat.mock.calls[0] as any[];
    return args[args.length - 1];
  };

  it('веб прислал ui — сервис получает обе возможности', async () => {
    expect(await run({ ui: { activity: true, ask: true } })).toEqual({ activity: true, ask: true });
  });

  it('без ui — ничего нового', async () => {
    expect(await run({})).toEqual({ activity: false, ask: false });
  });
});

describe('upload-and-chat: шаги работы и правило карточек', () => {
  const AGENT = { id: 12, name: 'Роман', display_name: 'Роман', description: '', system_prompt: '', category: 'business', is_active: true };

  const upload = async (body: any) => {
    const pg = {
      query: jest.fn(async (sql: string) => {
        if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
        if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
        return { rows: [] };
      }),
    };
    const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
    const svc = new ChatService(
      pg as any, null as any, null as any, null as any, null as any,
      language as any, undefined, undefined, undefined, undefined,
    );
    const ctrl = new ChatController(svc, jwtSvc as any, undefined as any, undefined);
    const post = jest.fn(async () => ({
      data: sseStream([
        { type: 'tool', tool: 'Read', input: `{"file_path":"/tmp/agent-uploads/${PHONE}_12_ru_egrul.pdf"}` },
        { type: 'delta', text: 'Выписка на трёх листах.' },
        { type: 'done' },
      ]),
    }));
    (axios as any).default = { post };
    (axios as any).post = post;
    const res = makeRes();
    await ctrl.uploadAndChat({
      headers: { authorization: 'Bearer t' },
      files: [{ originalname: 'egrul.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
      body: { message: 'сколько листов?', assistantId: '12', ...body },
    } as any, res);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const fd: any = (post.mock.calls[0] as any[])[1];
    return { written: res.written, systemPrompt: fd.getBuffer().toString('utf8') };
  };

  it('клиент прислал ui строкой — шаг чтения файла уходит', async () => {
    const { written } = await upload({ ui: '{"activity":true,"ask":true}' });
    expect(written.filter((w: any) => w.type === 'activity'))
      .toEqual([{ type: 'activity', kind: 'read_upload', detail: 'egrul.pdf' }]);
  });

  it('с ui.ask системный промпт загрузки содержит правило карточек', async () => {
    const { systemPrompt } = await upload({ ui: '{"activity":true,"ask":true}' });
    expect(systemPrompt).toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
  });

  it('без ui — ни шагов, ни правила', async () => {
    const { written, systemPrompt } = await upload({});
    expect(written.some((w: any) => w.type === 'activity')).toBe(false);
    expect(systemPrompt).not.toContain('УТОЧНЯЮЩИЕ ВОПРОСЫ');
  });
});
