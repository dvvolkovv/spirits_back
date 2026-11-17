import 'reflect-metadata';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import * as ts from 'typescript';
import axios from 'axios';
import { ChatService } from './chat.service';
import { ChatUploadsService, ChatUploadRecord } from './chat-uploads/chat-uploads.service';
import { ChatContextResetService } from './context-reset/context-reset.service';
import { afterReset } from './context-reset/after-reset';
import { clockRedis } from '../auth/fake-redis.forspec';
import { guestCarryKey } from '../guest-trial/guest-carry';

jest.mock('axios');
jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  sendTelegramPayload: jest.fn(async () => {}),
}));

/**
 * «Чистый лист» как точка отсчёта (spec 2026-11-17-context-reset): после точки
 * ассистент пары (пользователь, ассистент) видит профиль, бизнес-карточку и
 * только сообщения после неё. Точка входит в ключ сессии релея — значит, и
 * текстовый ход, и ход с файлом, и фоновые ответы (рутины, «Путь») обязаны
 * считать ОДИН и тот же ключ: иначе разговор разъедется по разным
 * Claude-сессиям (шапка relay-session.ts — как это уже ломалось 18.08).
 *
 * Харнес — по образцу chat.upload-session.spec.ts; проверяются поля, реально
 * уехавшие на релей.
 */

const OLD_JWT_SECRET = process.env.JWT_SECRET;
const OLD_UPLOADS_FLAG = process.env.CHAT_UPLOADS_ENABLED;
const realSetTimeout = global.setTimeout;
beforeAll(() => {
  // relayFsKey и токены точки продуктов без секрета не чеканятся.
  process.env.JWT_SECRET = 'chat-context-reset-spec';
  // persistResponse ставит таймер очистки dedup-карты; без unref jest не выходит.
  (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
    const t: any = (realSetTimeout as any)(fn, ms, ...a);
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  };
});
afterAll(() => {
  (global as any).setTimeout = realSetTimeout;
  if (OLD_JWT_SECRET === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = OLD_JWT_SECRET;
  if (OLD_UPLOADS_FLAG === undefined) delete process.env.CHAT_UPLOADS_ENABLED;
  else process.env.CHAT_UPLOADS_ENABLED = OLD_UPLOADS_FLAG;
});

const R = new Date('2026-11-17T00:00:00Z');
const ANSWER = 'Готово.';
const sleep = (ms: number) => new Promise((r) => realSetTimeout(r, ms));

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
  id: 12,
  name: 'Роман',
  display_name: 'Роман',
  description: 'бизнес-ассистент',
  system_prompt: 'Ты Роман, помогаешь с налогами и документами.',
  category: 'business',
  is_active: true,
};

function makePg() {
  return {
    query: jest.fn(async (sql: string) => {
      if (/SELECT tokens FROM ai_profiles_consolidated/.test(sql)) return { rows: [{ tokens: 1_000_000 }] };
      if (/SELECT profile_data FROM ai_profiles_consolidated/.test(sql)) {
        return { rows: [{ profile_data: { automaticProfiling: true } }] };
      }
      if (/FROM agents WHERE id/.test(sql)) return { rows: [AGENT] };
      // История с временем — до и после точки, DESC, как отдаёт SQL.
      if (/FROM custom_chat_history/.test(sql) && /SELECT sender_type/.test(sql)) {
        return { rows: [
          { sender_type: 'ai', content: 'НОВЫЙ ответ', created_at: '2026-11-17T09:00:02Z' },
          { sender_type: 'human', content: 'НОВЫЙ вопрос', created_at: '2026-11-17T09:00:01Z' },
          { sender_type: 'ai', content: 'СТАРЫЙ ответ', created_at: '2026-11-10T09:00:02Z' },
          { sender_type: 'human', content: 'СТАРЫЙ вопрос', created_at: '2026-11-10T09:00:01Z' },
        ] };
      }
      return { rows: [] };
    }),
  };
}

function makeService(pg = makePg(), claudeCli: any = null): ChatService {
  const language = { resolveUserLanguage: jest.fn(async (_u: string, hint?: string) => hint || 'ru') };
  const balanceCtx = { buildContextForPrompt: jest.fn(async () => '') };
  return new ChatService(
    pg as any, null as any, null as any, claudeCli, language as any, balanceCtx as any,
  );
}

const resets = (at: Date | null) => ({ get: jest.fn(async () => at) });

function makeTasks() {
  return {
    buildContextForPrompt: jest.fn(async () => ''),
    extractFromTurn: jest.fn(async () => {}),
  };
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
  } as any;
}

/**
 * Релей-заглушка: запоминает момент ПЕРВОГО запроса и отвечает чуть позже —
 * так время, взятое после запроса (например, в persistResponse), заведомо
 * позже `firstPostAt`, и проверка «turnAt взят в начале хода» различает.
 */
function mockRelay() {
  const relay = { firstPostAt: 0, post: jest.fn() };
  relay.post.mockImplementation(async () => {
    if (!relay.firstPostAt) relay.firstPostAt = Date.now();
    await sleep(5);
    return { data: sseStream([{ type: 'delta', text: ANSWER }, { type: 'done' }]) };
  });
  (axios as any).default = { post: relay.post, get: jest.fn(async () => ({ data: [] })) };
  (axios as any).post = relay.post;
  (axios as any).get = jest.fn(async () => ({ data: [] }));
  return relay;
}

const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };

/** Текстовый ход через streamChat → поля, ушедшие на релей. */
async function textTurn(svc: ChatService, message = 'вопрос'): Promise<Record<string, string>> {
  const relay = mockRelay();
  await svc.streamChat('u1', message, '12', 'u1_12', '', makeRes());
  await settle();
  expect(relay.post).toHaveBeenCalled();
  return fieldsOf(relay.post.mock.calls[0][1]);
}

describe('ChatService: точка «Чистого листа»', () => {
  afterEach(() => {
    jest.clearAllMocks();
    delete process.env.CHAT_UPLOADS_ENABLED;
  });

  it('текстовый ход: ключ релея с точкой, хвост — только после неё', async () => {
    const svc = makeService();
    (svc as any).contextResets = resets(R);
    const fields = await textTurn(svc);
    expect(fields.sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(fields.history).toContain('НОВЫЙ вопрос');
    expect(fields.history).not.toContain('СТАРЫЙ');
  });

  it('без точки — ключ и хвост прежние', async () => {
    const svc = makeService();
    (svc as any).contextResets = resets(null);
    const fields = await textTurn(svc);
    expect(fields.sessionId).toBe('u1_12_ru');
    expect(fields.history).toContain('СТАРЫЙ вопрос');
  });

  it('без сервиса точки (старые стенды, спеки) — поведение прежнее', async () => {
    const fields = await textTurn(makeService());
    expect(fields.sessionId).toBe('u1_12_ru');
    expect(fields.history).toContain('СТАРЫЙ вопрос');
  });

  it('загрузка файла: тот же ключ с точкой и тот же отфильтрованный хвост', async () => {
    const svc = makeService();
    (svc as any).contextResets = resets(R);
    const handoff = await svc.buildUploadHandoff({ userId: 'u1', assistantId: '12', requestLang: 'ru' });
    expect(handoff.baseSessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(handoff.sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(handoff.history).toContain('НОВЫЙ вопрос');
    expect(JSON.stringify(handoff)).not.toContain('СТАРЫЙ');
  });

  it('задачи спрашиваются с точкой', async () => {
    const svc = makeService();
    const tasks = makeTasks();
    (svc as any).tasksService = tasks;
    (svc as any).contextResets = resets(R);
    await textTurn(svc);
    expect(tasks.buildContextForPrompt).toHaveBeenCalledWith('u1', expect.any(String), { since: R });
  });

  it('сбой чтения точки не роняет ход', async () => {
    const svc = makeService();
    (svc as any).contextResets = { get: jest.fn(async () => { throw new Error('db down'); }) };
    const fields = await textTurn(svc);
    expect(fields.sessionId).toBe('u1_12_ru');
    expect(fields.history).toContain('СТАРЫЙ вопрос');
  });

  it('память загрузок: файлы до точки ассистенту не напоминаем', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const svc = makeService();
    const old = { id: 'old', originalName: 'old.pdf', createdAt: '2026-11-10T00:00:00.000Z' };
    const fresh = { id: 'new', originalName: 'new.pdf', createdAt: '2026-11-17T09:00:00.000Z' };
    const chatUploads = {
      recentForSession: jest.fn(async () => [fresh, old]),
      assistantBlock: jest.fn((records: any[]) => records.map((r) => `- ${r.originalName}`).join('\n')),
    };
    (svc as any).chatUploads = chatUploads;
    (svc as any).contextResets = resets(R);
    const fields = await textTurn(svc);
    // Реестр — по основной ленте (сырой ключ Postgres), не по ключу релея.
    expect(chatUploads.recentForSession).toHaveBeenCalledWith('u1', 'u1_12', []);
    expect(chatUploads.assistantBlock).toHaveBeenCalledWith([fresh]);
    expect(fields.message).toContain('new.pdf');
    expect(fields.message).not.toContain('old.pdf');
  });

  // Ход с файлом (buildUploadHandoff) — та же память загрузок, что у
  // текстового хода: файлы до точки ассистенту не напоминаем. Блок — боевой
  // assistantBlock (строка с id и именем), выборка и подпись — подменены.
  it('загрузка файла: память загрузок отсекается точкой — файла до точки в handoff нет, после точки есть', async () => {
    process.env.CHAT_UPLOADS_ENABLED = 'true'; // afterEach снимает флаг, afterAll возвращает исходный
    const record = (id: string, originalName: string, createdAt: string): ChatUploadRecord => ({
      id, userId: 'u1', sessionId: 'u1_12', originalName, mime: 'application/pdf', sizeBytes: 1,
      sha256: 'a'.repeat(64), storageKey: `synthetic/${originalName}`, createdAt, source: 'web',
      thumbKey: null, note: null, noteUpdatedAt: null, noteAssistantId: null,
    });
    const before = record('11111111-1111-4111-8111-111111111111', 'договор-до-точки.pdf', '2026-11-10T09:00:00.000Z');
    const after = record('22222222-2222-4222-8222-222222222222', 'счёт-после-точки.pdf', '2026-11-17T09:00:00.000Z');
    const uploads = new ChatUploadsService({ query: jest.fn(async () => ({ rows: [] })) } as any, {} as any);
    // Реестр отдаёт от новых к старым — как recentForSession.
    const recent = jest.spyOn(uploads, 'recentForSession').mockResolvedValue([after, before]);
    jest.spyOn(uploads, 'assistantUrl').mockImplementation((id: string) => `https://backend.test/webhook/chat-uploads/${id}?sig=spec`);
    const svc = makeService();
    (svc as any).chatUploads = uploads;
    (svc as any).contextResets = resets(R);

    const handoff = await svc.buildUploadHandoff({
      userId: 'u1', assistantId: '12', requestLang: 'ru', savedUploadIds: ['33333333-3333-4333-8333-333333333333'],
    });

    // Реестр — по основной ленте; файлы этого хода исключены.
    expect(recent).toHaveBeenCalledWith('u1', 'u1_12', ['33333333-3333-4333-8333-333333333333']);
    expect(handoff.uploadContext).toContain(after.id);
    expect(handoff.uploadContext).toContain('счёт-после-точки.pdf');
    const all = JSON.stringify(handoff);
    expect(all).not.toContain(before.id);
    expect(all).not.toContain('договор-до-точки.pdf');
  });

  it('приписка гостевой пробы после точки не тянется и не стирается', async () => {
    // Проба была до входа — то есть старше любой точки.
    const svc = makeService();
    const redis = clockRedis();
    await redis.set(guestCarryKey('u1', '12'), 'ПРИПИСКА ПРОБЫ', 3600);
    (svc as any).redis = redis;
    (svc as any).contextResets = resets(R);
    const fields = await textTurn(svc);
    expect(fields.message).not.toContain('ПРИПИСКА ПРОБЫ');
    expect(redis.peek(guestCarryKey('u1', '12'))).toBe('ПРИПИСКА ПРОБЫ');
  });

  it('agentReply (рутины, «Путь»): та же точка в ключе основной сессии', async () => {
    const svc = makeService();
    (svc as any).contextResets = resets(R);
    const relay = mockRelay();
    await svc.generateAgentReply('u1', '12', 'фоновый вопрос');
    expect(fieldsOf(relay.post.mock.calls[0][1]).sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
  });

  it('agentReply с изолированной сессией (override) — ровно override, точка не применяется', async () => {
    const svc = makeService();
    const r = resets(R);
    (svc as any).contextResets = r;
    const relay = mockRelay();
    await svc.generateAgentReply('u1', '12', 'синтетическая проба', 'qprobe_u1_12_1');
    expect(fieldsOf(relay.post.mock.calls[0][1]).sessionId).toBe('qprobe_u1_12_1');
    expect(r.get).not.toHaveBeenCalled();
  });

  it('сквозной: при одной точке текст, загрузка и agentReply — один и тот же ключ релея', async () => {
    const svc = makeService();
    (svc as any).contextResets = resets(R);
    const text = await textTurn(svc);
    const handoff = await svc.buildUploadHandoff({ userId: 'u1', assistantId: '12', requestLang: 'ru' });
    const relay = mockRelay();
    await svc.generateAgentReply('u1', '12', 'фоновый вопрос');
    const background = fieldsOf(relay.post.mock.calls[0][1]);

    expect(text.sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(handoff.sessionId).toBe(text.sessionId);
    expect(background.sessionId).toBe(text.sessionId);
    // И папка файлов хода — одна (fs_key считается от ключа сессии).
    expect(text.fs_key).toBeTruthy();
    expect(handoff.linkeon.fs_key).toBe(text.fs_key);
    expect(background.fs_key).toBe(text.fs_key);
  });
});

/**
 * Момент хода для задач (spec 2026-11-17-context-reset, «Риски»): задачи
 * извлекаются в фоне ПОСЛЕ ответа, и если записать им created_at «сейчас»,
 * точка, нажатая сразу после ответа, окажется раньше задачи из старого
 * разговора — и та протечёт за черту. Поэтому created_at = момент хода,
 * взятый в его начале.
 */
describe('ChatService: момент хода для задач', () => {
  afterEach(() => jest.clearAllMocks());

  it('текстовый ход через релей: extractFromTurn получает Date, взятый до запроса к релею', async () => {
    const svc = makeService();
    const tasks = makeTasks();
    (svc as any).tasksService = tasks;
    const relay = mockRelay();
    await svc.streamChat('u1', 'вопрос про сроки', '12', 'u1_12', '', makeRes());
    await settle();

    expect(tasks.extractFromTurn).toHaveBeenCalledTimes(1);
    const turnAt = tasks.extractFromTurn.mock.calls[0][4];
    expect(turnAt).toBeInstanceOf(Date);
    expect(turnAt.getTime()).toBeLessThanOrEqual(relay.firstPostAt);
  });

  it('гонка «ход до точки → точка → фоновое извлечение»: turnAt раньше точки', async () => {
    const svc = makeService();
    const tasks = makeTasks();
    let resetAt: Date | null = null;
    // Извлечение задач отстаёт от ответа (LLM-вызов в фоне). Точку человек
    // ставит, как только увидел ответ, — до того, как извлечение дошло до вставки.
    tasks.extractFromTurn.mockImplementation(async () => {
      resetAt = new Date();
    });
    (svc as any).tasksService = tasks;
    mockRelay();
    await svc.streamChat('u1', 'вопрос до точки', '12', 'u1_12', '', makeRes());
    await settle();

    const turnAt: Date = tasks.extractFromTurn.mock.calls[0][4];
    expect(resetAt).not.toBeNull();
    // Задача хода до точки записана временем хода — значит, за черту не протечёт.
    expect(turnAt.getTime()).toBeLessThan(resetAt!.getTime());
    expect(afterReset([{ created_at: turnAt }], resetAt, (t) => t.created_at)).toEqual([]);
  });

  /**
   * Ветка Маши (agent.id === 3, локальный CLI мимо релея) — тот же контракт.
   * Харнес — как в chat.service.masha-provider.spec.ts.
   */
  function masha() {
    const cli = { calledAt: 0, textWithCost: jest.fn() };
    cli.textWithCost.mockImplementation(async () => {
      if (!cli.calledAt) cli.calledAt = Date.now();
      await sleep(5);
      return { text: 'Давай разберём это вместе.', costUsd: 0.01 };
    });
    const svc = makeService(makePg(), cli);
    jest.spyOn(svc as any, 'resolveAgent').mockResolvedValue({
      id: 3, name: 'Маша', description: 'психолог', system_prompt: 'Ты Маша.', category: 'personal',
    });
    const tasks = makeTasks();
    (svc as any).tasksService = tasks;
    return { svc, cli, tasks };
  }

  it('Маша: extractFromTurn получает Date, взятый до вызова модели', async () => {
    const { svc, cli, tasks } = masha();
    await svc.streamChat('u1', 'Мне тревожно перед встречей', '3', 'u1_3', '', makeRes());
    await settle();

    expect(tasks.extractFromTurn).toHaveBeenCalledTimes(1);
    const turnAt = tasks.extractFromTurn.mock.calls[0][4];
    expect(turnAt).toBeInstanceOf(Date);
    expect(turnAt.getTime()).toBeLessThanOrEqual(cli.calledAt);
  });

  it('Маша: задачи спрашиваются с точкой', async () => {
    const { svc, tasks } = masha();
    (svc as any).contextResets = resets(R);
    await svc.streamChat('u1', 'Мне тревожно перед встречей', '3', 'u1_3', '', makeRes());
    await settle();

    expect(tasks.buildContextForPrompt).toHaveBeenCalledWith('u1', expect.any(String), { since: R });
  });

  it('Маша: хвост в промпте модели — только после точки', async () => {
    // У Маши нет релея и его сессии — память целиком из хвоста, который мы
    // сами клеим в промпт CLI. Значит, и отсекать его надо здесь.
    const { svc, cli } = masha();
    (svc as any).contextResets = resets(R);
    await svc.streamChat('u1', 'Мне тревожно перед встречей', '3', 'u1_3', '', makeRes());
    await settle();

    const prompt: string = cli.textWithCost.mock.calls[0][0];
    expect(prompt).toContain('НОВЫЙ вопрос');
    expect(prompt).not.toContain('СТАРЫЙ');
  });
});

/**
 * Пинг мониторинга (probe + fresh, только тестовые аккаунты) — единственный,
 * у кого остался изолированный путь: одноразовая сессия на каждый пинг. Точка
 * ему не нужна и не должна его трогать.
 */
describe('ChatService: пинг мониторинга и точка', () => {
  afterEach(() => jest.clearAllMocks());

  it('fresh-сессия пинга: точку не читаем, ключ релея — fresh-id, хвост не режем', async () => {
    const svc = makeService();
    const r = resets(R);
    (svc as any).contextResets = r;
    const relay = mockRelay();
    const pingSession = 'u1_12_fresh_1786468316338';
    await svc.streamChat(
      'u1', 'ответь одним словом ок', '12', pingSession, '', makeRes(),
      // req, fresh, requestLang, clientTz, storeBuild, probe
      undefined, true, undefined, undefined, false, true,
    );
    await settle();

    expect(r.get).not.toHaveBeenCalled();
    const fields = fieldsOf(relay.post.mock.calls[0][1]);
    expect(fields.sessionId).toBe(pingSession);
    // Фикстура отдаёт одни и те же строки на любую сессию: фильтра по точке
    // здесь нет, поэтому старая строка доходит.
    expect(fields.history).toContain('СТАРЫЙ вопрос');
  });
});

/**
 * Автоприветствие вкладки, открытой до 13.11 (legacy-greeting.ts): отвечаем
 * без модели только в ПУСТОЙ сессии. После точки «пустая» — значит пустая для
 * ассистента: старая вкладка при «Чистом листе» шлёт приветствие сама, и
 * платить за него человеку не за что.
 */
describe('ChatService: автоприветствие старой вкладки после точки', () => {
  afterEach(() => jest.clearAllMocks());

  it('все строки ленты до точки — приветствие отвечается без модели', async () => {
    const svc = makeService();
    // Точка позже всех строк фикстуры (последняя — 2026-11-17T09:00:02Z).
    (svc as any).contextResets = resets(new Date('2026-11-17T10:00:00Z'));
    const relay = mockRelay();
    const res = makeRes();
    await svc.streamChat('u1', 'Привет! Расскажи про себя!', '12', 'u1_12', '', res);
    await settle();

    expect(relay.post).not.toHaveBeenCalled();
    const end = res.written.find((w: any) => w.type === 'end');
    expect(end.content).toBe('Здравствуйте! Чем могу помочь?');
    expect(end.usage).toEqual({ input: 0, output: 0, total: 0 });
  });
});

/**
 * Дедуп отправки (inflight, окно DEDUP_COOLDOWN_MS = 12 с) гасит повтор того
 * же вопроса. Но повтор после «Чистого листа» — не дубль: человек нажал
 * кнопку и спросил то же самое заново, уже без старого контекста.
 */
describe('ChatService: дедуп и точка', () => {
  afterEach(() => jest.clearAllMocks());

  async function twice(firstAt: Date | null, secondAt: Date | null) {
    const svc = makeService();
    const r = { get: jest.fn(async () => firstAt) };
    (svc as any).contextResets = r;
    const relay = mockRelay();
    await svc.streamChat('u1', 'тот же вопрос', '12', 'u1_12', '', makeRes());
    await settle();
    r.get.mockImplementation(async () => secondAt);
    const res = makeRes();
    await svc.streamChat('u1', 'тот же вопрос', '12', 'u1_12', '', res);
    await settle();
    return { relay, res };
  }

  it('контроль: та же точка — повтор в окне отбивается как дубль', async () => {
    const { relay, res } = await twice(R, R);
    expect(relay.post).toHaveBeenCalledTimes(1);
    expect(res.written.find((w: any) => w.type === 'end').content).toContain('только что обработал');
  });

  it('тот же вопрос до и после новой точки в окне дедупа — второй уходит в модель', async () => {
    const { relay, res } = await twice(null, R);
    expect(relay.post).toHaveBeenCalledTimes(2);
    expect(fieldsOf(relay.post.mock.calls[1][1]).sessionId).toBe(`u1_12_ru_r${R.getTime()}`);
    expect(JSON.stringify(res.written)).not.toContain('только что обработал');
  });
});

/**
 * Точка — обязательный параметр uploadContextBlock: с необязательной вызов
 * без неё (ветка Маши из main, память загрузок) молча скомпилировался и
 * вернул ассистенту файлы до «Чистого листа». Обязательный параметр ловит
 * такой вызов tsc, а этот пин держит саму обязательность: ts-jest типы не
 * проверяет (isolatedModules), а tsc -p tsconfig.build.json спеки не видит.
 */
describe('uploadContextBlock: точка «Чистого листа» — обязательный параметр', () => {
  const file = path.join(__dirname, 'chat.service.ts');
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let decl: ts.MethodDeclaration | undefined;
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(sf) === 'uploadContextBlock') decl = node;
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'uploadContextBlock'
    ) calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  it('since: Date | null — без «?» и без значения по умолчанию', () => {
    expect(decl).toBeDefined();
    const since = decl!.parameters.find((p) => p.name.getText(sf) === 'since');
    expect(since).toBeDefined();
    expect(since!.questionToken).toBeUndefined();
    expect(since!.initializer).toBeUndefined();
    expect(since!.type?.getText(sf).replace(/\s/g, '')).toBe('Date|null');
  });

  it('каждый вызов передаёт точку хода (resetAt) четвёртым аргументом', () => {
    // Релей, загрузка файла (buildUploadHandoff) и Маша.
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.arguments).toHaveLength(4);
      expect(call.arguments[3].getText(sf)).toBe('resetAt');
    }
  });
});

/**
 * Сторож DI (по духу chat.service.guest-carry.spec.ts): зависимость обязана
 * быть объявлена КЛАССОМ. Интерфейс стёрся бы в Object, Nest не нашёл бы
 * провайдер, и @Optional() молча подставил бы undefined — точка на проде не
 * работала бы никогда, а тесты выше это бы не заметили.
 */
describe('ChatService: DI-тип точки «Чистого листа»', () => {
  it('конструктор объявляет зависимость классом ChatContextResetService', () => {
    const paramTypes = Reflect.getMetadata('design:paramtypes', ChatService);
    expect(paramTypes).toContain(ChatContextResetService);
  });
});
