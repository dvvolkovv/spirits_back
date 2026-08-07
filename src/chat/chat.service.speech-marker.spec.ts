import { Readable } from 'stream';
import axios from 'axios';
import { ChatService } from './chat.service';

jest.mock('axios');

/**
 * Дефект «озвучка не доходит до фронта».
 *
 * Обычные ассистенты идут через streamUniversalAgent → r.linkeon.io, а этот
 * путь наружу пишет только begin/item/ping/end — структурных tool_result в нём
 * нет (см. комментарий у video-маркеров в chat.service.ts). Поэтому
 * generate_speech отрабатывал, токены списывались, клип ложился в speech_clips —
 * и на этом всё: плеер у пользователя не появлялся.
 *
 * Чинится тем же приёмом, что видео и календарь: после стрима спрашиваем БД про
 * клипы, созданные за время стрима этим пользователем, и дописываем маркер
 * `{{audio:id=<uuid>}}` — И в поток (item), И в chunks (из них собирается
 * fullText, который персистится в историю; без этого плеер исчезал бы после
 * перезагрузки страницы).
 *
 * Тест гоняет НАСТОЯЩИЙ streamUniversalAgent с замоканными axios/pg/res.
 */

const CLIP_A = '11111111-2222-4333-8444-555555555555';
const CLIP_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/** Поток от r.linkeon в формате SSE, как его парсит callUpstreamOnce. */
function sseStream(events: any[]): Readable {
  const s = new Readable({ read() {} });
  process.nextTick(() => {
    for (const ev of events) s.push(`data: ${JSON.stringify(ev)}\n`);
    s.push(null);
  });
  return s;
}

interface Harness {
  svc: ChatService;
  written: any[];
  pgCalls: { sql: string; params: any[] }[];
  run: (message?: string) => Promise<void>;
}

function makeHarness(opts: { deltas: string[]; clipIds: string[] }): Harness {
  const written: any[] = [];
  const pgCalls: { sql: string; params: any[] }[] = [];

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      if (/FROM speech_clips/.test(sql)) {
        return { rows: opts.clipIds.map((id) => ({ id })) };
      }
      if (/FROM video_jobs/.test(sql)) return { rows: [] };
      if (/FROM calendar_proposals/.test(sql)) return { rows: [] };
      if (/AS spent/.test(sql)) return { rows: [{ spent: 0 }] };
      return { rows: [] };
    }),
  };

  const language = { resolveUserLanguage: jest.fn(async () => 'ru') };

  const svc = new ChatService(
    pg as any,
    null as any,      // neo4j
    null as any,      // kling
    null as any,      // tools
    null as any,      // smmProducerTools
    null as any,      // claudeAgent
    null as any,      // claudeCli
    language as any,  // language
    undefined,        // tasksService
    undefined,        // events
    undefined,        // talerIdOauth
  );

  (axios.post as jest.Mock).mockResolvedValue({
    data: sseStream([...opts.deltas.map((text) => ({ type: 'delta', text })), { type: 'done' }]),
  });

  const res: any = {
    status: jest.fn(),
    setHeader: jest.fn(),
    write: jest.fn((line: string) => { written.push(JSON.parse(line)); return true; }),
    end: jest.fn(),
  };

  const run = async (message = 'озвучь фразу') => {
    await (svc as any).streamUniversalAgent(
      'u1', message, '7', '7', [], '', res, 'Роман', '', '', undefined, false, undefined,
    );
    // persistResponse уходит в setImmediate — даём ему отработать.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  return { svc, written, pgCalls, run };
}

/** Строка, которая реально ушла в историю чата (то, что увидит пользователь после F5). */
function persistedAiText(pgCalls: { sql: string; params: any[] }[]): string | undefined {
  const row = pgCalls.find((c) => /INSERT INTO custom_chat_history/.test(c.sql) && /'ai'/.test(c.sql));
  return row?.params[2];
}

describe('streamUniversalAgent — маркеры озвучки', () => {
  // persistResponse ставит 14-секундный таймер очистки dedup-карты. В тесте он
  // держит event loop открытым («Jest did not exit…»), поэтому на время файла
  // помечаем таймеры как unref — на логику это не влияет.
  const realSetTimeout = global.setTimeout;
  beforeAll(() => {
    (global as any).setTimeout = (fn: any, ms?: number, ...a: any[]) => {
      const t: any = (realSetTimeout as any)(fn, ms, ...a);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    };
  });
  afterAll(() => { (global as any).setTimeout = realSetTimeout; });

  beforeEach(() => jest.clearAllMocks());

  it('клип, созданный за время стрима, дописывается маркером в поток И в историю', async () => {
    const h = makeHarness({ deltas: ['Готово, слушай.'], clipIds: [CLIP_A] });
    await h.run();

    const marker = `{{audio:id=${CLIP_A}}}`;

    // 1. Ушёл клиенту отдельным item — плеер появляется сразу, без перезагрузки.
    const items = h.written.filter((w) => w.type === 'item').map((w) => w.content);
    expect(items.some((c: string) => c.includes(marker))).toBe(true);

    // 2. Попал в fullText события end — из него же собирается сохраняемый текст.
    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toContain(marker);

    // 3. Попал в историю — плеер переживает F5.
    expect(persistedAiText(h.pgCalls)).toContain(marker);
  });

  it('запрос клипов ограничен пользователем и временем старта стрима', async () => {
    const h = makeHarness({ deltas: ['ок'], clipIds: [CLIP_A] });
    await h.run();

    const q = h.pgCalls.find((c) => /FROM speech_clips/.test(c.sql));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/user_id = \$1/);
    expect(q!.sql).toMatch(/created_at >= \$2::timestamptz/);
    expect(q!.params[0]).toBe('u1');
    // Граница — момент старта стрима, а не «за всё время»: иначе к каждому
    // ответу цеплялись бы все прошлые клипы пользователя.
    expect(Date.parse(q!.params[1])).toBeLessThanOrEqual(Date.now());
    expect(Date.now() - Date.parse(q!.params[1])).toBeLessThan(60_000);
  });

  it('несколько клипов (сценка по ролям) дают маркер на каждый, в порядке создания', async () => {
    const h = makeHarness({ deltas: ['Сценка:'], clipIds: [CLIP_A, CLIP_B] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(end.content).toContain(`{{audio:id=${CLIP_B}}}`);
    expect(end.content.indexOf(CLIP_A)).toBeLessThan(end.content.indexOf(CLIP_B));
  });

  it('клипов нет — никаких маркеров не появляется', async () => {
    const h = makeHarness({ deltas: ['Просто текст.'], clipIds: [] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toBe('Просто текст.');
    expect(end.content).not.toContain('{{audio:');
  });

  it('нагаллюцинированный моделью маркер вырезается, остаётся только проверенный из БД', async () => {
    const fake = '99999999-9999-4999-8999-999999999999';
    const h = makeHarness({
      deltas: [`Вот аудио {{audio:id=${fake}}} слушай.`],
      clipIds: [CLIP_A],
    });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).not.toContain(fake);
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(persistedAiText(h.pgCalls)).not.toContain(fake);
  });

  it('формат маркера ровно тот, что разбирает фронт: {{audio:id=<36 симв. lowercase>}}', async () => {
    const h = makeHarness({ deltas: ['ок'], clipIds: [CLIP_A] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    // Регулярка скопирована из spirits_front/src/utils/customMarkdown.tsx
    // (AUDIO_CLIP_REGEX) — свой формат придумывать нельзя, фронт его не поймёт.
    const AUDIO_CLIP_REGEX = /\{\{audio:id=([a-f0-9-]{36})\}\}/g;
    const found = [...String(end.content).matchAll(AUDIO_CLIP_REGEX)].map((m) => m[1]);
    expect(found).toEqual([CLIP_A]);
  });

  it('падение запроса клипов не роняет ответ ассистента', async () => {
    const h = makeHarness({ deltas: ['Текст ответа.'], clipIds: [CLIP_A] });
    // Ломаем только запрос клипов — остальные должны отработать как обычно.
    const orig = (h.svc as any).pg.query;
    (h.svc as any).pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM speech_clips/.test(sql)) throw new Error('relation speech_clips does not exist');
      return orig(sql, params);
    });

    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end).toBeDefined();
    expect(end.content).toContain('Текст ответа.');
  });
});
