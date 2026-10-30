import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatController } from './chat.controller';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({ sendTelegramAlert: jest.fn(async () => {}) }));

const OLD_JWT_SECRET = process.env.JWT_SECRET;
beforeAll(() => { process.env.JWT_SECRET = 'chat-upload-llm-provider-spec'; });
afterAll(() => {
  if (OLD_JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_JWT_SECRET;
});

/**
 * Ход с ВЛОЖЕНИЯМИ следует модели ответов человека так же, как текстовый
 * (spec 2026-10-30-llm-provider-switch, раздел 6): контроллер сам собирает
 * форму к релею, и без поля provider человек с выбранным Qwen получал бы
 * Claude на каждом ходе с файлом. Сборка — как в chat.upload-session.spec.ts.
 */

function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

/** Поля multipart-запроса к релею — то, что реально уехало. */
function fieldsOf(fd: any): Record<string, string> {
  const boundary = fd.getBoundary();
  const raw = fd.getBuffer().toString('utf8');
  const out: Record<string, string> = {};
  for (const part of raw.split(`--${boundary}`)) {
    const name = /name="([^"]+)"/.exec(part);
    const head = part.indexOf('\r\n\r\n');
    if (!name || head < 0) continue;
    out[name[1]] = part.slice(head + 4).replace(/\r\n$/, '');
  }
  return out;
}

const AGENT = {
  id: 12, name: 'Роман', display_name: 'Роман', description: 'бизнес-ассистент',
  system_prompt: 'Ты Роман.', category: 'business', is_active: true,
};

function makePg() {
  return {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
      return { rows: [] };
    }),
  };
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    write: jest.fn(() => true),
    end: jest.fn(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  } as any;
}

/** Прогоняет upload-and-chat с выбором человека и отдаёт поля, ушедшие на релей. */
async function upload(choice: 'claude' | 'qwen') {
  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };
  const svc = new ChatService(
    makePg() as any, null as any, null as any,
    null as any, language as any, undefined, undefined, undefined, undefined,
  );
  const jwtSvc = { verify: jest.fn(() => ({ type: 'access', userId: 'u1' })) };
  const llmProvider = { get: jest.fn(async () => choice) };
  const ctrl = new ChatController(svc, jwtSvc as any, null as any, undefined, llmProvider as any);
  const post = jest.fn(async () => ({ data: sseStream([{ type: 'delta', text: 'Готово.' }, { type: 'done' }]) }));
  (axios as any).default = { post };
  (axios as any).post = post;

  const req = {
    headers: { authorization: 'Bearer token' },
    files: [{ originalname: 'egrul.pdf', buffer: Buffer.from('x'), mimetype: 'application/pdf', size: 1 }],
    body: { message: 'что тут?', assistantId: '12' },
  } as any;
  await ctrl.uploadAndChat(req, makeRes());
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));

  expect(post).toHaveBeenCalled();
  return { fields: fieldsOf((post.mock.calls[0] as any[])[1]), llmProvider };
}

describe('uploadAndChat: модель ответов человека', () => {
  afterEach(() => jest.clearAllMocks());

  it('выбран Qwen — provider=qwen, без noFallback', async () => {
    const { fields, llmProvider } = await upload('qwen');
    expect(fields.provider).toBe('qwen');
    expect(fields.noFallback).toBeUndefined();
    expect(llmProvider.get).toHaveBeenCalledWith('u1');
  });

  it('выбран Claude — ни provider, ни noFallback', async () => {
    const { fields } = await upload('claude');
    expect(fields.provider).toBeUndefined();
    expect(fields.noFallback).toBeUndefined();
  });
});
