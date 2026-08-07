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

/**
 * Клип в таблице. `cached: true` — это кэш-хит: строка старая (created_at ушёл
 * в прошлое), но SpeechService на выдаче двигает last_used_at, поэтому по
 * времени последнего использования клип попадает в текущий стрим.
 * `tokensSpent` — то, что списали при ПЕРВОМ синтезе; у кэш-хита сейчас
 * денег не брали.
 */
interface ClipSpec {
  id: string;
  cached?: boolean;
  tokensSpent?: number;
}

const fresh = (id: string, tokensSpent = 0): ClipSpec => ({ id, tokensSpent });
const cachedHit = (id: string, tokensSpent = 0): ClipSpec => ({ id, cached: true, tokensSpent });

interface Harness {
  svc: ChatService;
  written: any[];
  pgCalls: { sql: string; params: any[] }[];
  run: (message?: string) => Promise<void>;
}

function makeHarness(opts: { deltas: string[]; clips: ClipSpec[]; userId?: string }): Harness {
  const written: any[] = [];
  const pgCalls: { sql: string; params: any[] }[] = [];
  const owner = opts.userId ?? 'u1';

  /**
   * Честная заглушка speech_clips: предикаты берутся ИЗ ТЕКСТА запроса, как в
   * настоящем Postgres. Прошлая версия отдавала строки на любой
   * `FROM speech_clips` безусловно — то есть моделировала только свежую
   * вставку и по построению не могла отличить кэш-хит. Из-за этого дефект
   * «повтор текста не даёт маркера» тесты проходили насквозь.
   *
   * Уберёшь `last_used_at >= $2` из запроса маркеров — кэш-хит перестанет
   * находиться, ровно как в боевой БД. Добавишь `last_used_at` в запрос
   * стоимости — в сумму влезет старая, сегодня не взятая плата.
   */
  const evalClips = (sql: string, params: any[]) => {
    const [uid, boundaryIso] = params;
    const boundary = Date.parse(boundaryIso);
    const byCreated = /created_at >= \$2/.test(sql);
    const byLastUsed = /last_used_at >= \$2/.test(sql);
    const now = Date.now();

    const rows = opts.clips
      .map((c) => ({
        id: c.id,
        user_id: owner,
        tokens_spent: c.tokensSpent ?? 0,
        // Кэш-хиту сутки от роду — он заведомо создан до старта стрима.
        created_at: c.cached ? now - 86_400_000 : now,
        // И свежая вставка, и кэш-хит выданы прямо сейчас (DEFAULT now() /
        // UPDATE ... SET last_used_at = now()).
        last_used_at: now,
      }))
      .filter(
        (r) =>
          r.user_id === uid &&
          ((byCreated && r.created_at >= boundary) || (byLastUsed && r.last_used_at >= boundary)),
      )
      .sort((a, b) => a.created_at - b.created_at);

    if (/SUM\(tokens_spent\)/.test(sql)) {
      return { rows: [{ spent: rows.reduce((s, r) => s + r.tokens_spent, 0) }] };
    }
    const lim = sql.match(/LIMIT (\d+)/);
    const limited = lim ? rows.slice(0, Number(lim[1])) : rows;
    return { rows: limited.map((r) => ({ id: r.id })) };
  };

  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      pgCalls.push({ sql, params });
      // Проверять speech_clips надо ДО `AS spent`: запрос стоимости озвучки
      // подходит под оба шаблона.
      if (/FROM speech_clips/.test(sql)) return evalClips(sql, params);
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

/** Запрос, которым добираются id клипов для маркеров. */
function markerQuery(pgCalls: { sql: string; params: any[] }[]) {
  return pgCalls.find((c) => /FROM speech_clips/.test(c.sql) && !/SUM\(tokens_spent\)/.test(c.sql));
}

/** Запрос стоимости озвучки — тот, что кормит индикатор «X токенов». */
function spendQuery(pgCalls: { sql: string; params: any[] }[]) {
  return pgCalls.find((c) => /FROM speech_clips/.test(c.sql) && /SUM\(tokens_spent\)/.test(c.sql));
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
    const h = makeHarness({ deltas: ['Готово, слушай.'], clips: [fresh(CLIP_A)] });
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
    const h = makeHarness({ deltas: ['ок'], clips: [fresh(CLIP_A)] });
    await h.run();

    const q = markerQuery(h.pgCalls);
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
    const h = makeHarness({ deltas: ['Сценка:'], clips: [fresh(CLIP_A), fresh(CLIP_B)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(end.content).toContain(`{{audio:id=${CLIP_B}}}`);
    expect(end.content.indexOf(CLIP_A)).toBeLessThan(end.content.indexOf(CLIP_B));
  });

  it('клипов нет — никаких маркеров не появляется', async () => {
    const h = makeHarness({ deltas: ['Просто текст.'], clips: [] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toBe('Просто текст.');
    expect(end.content).not.toContain('{{audio:');
  });

  it('нагаллюцинированный моделью маркер вырезается, остаётся только проверенный из БД', async () => {
    const fake = '99999999-9999-4999-8999-999999999999';
    const h = makeHarness({
      deltas: [`Вот аудио {{audio:id=${fake}}} слушай.`],
      clips: [fresh(CLIP_A)],
    });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).not.toContain(fake);
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(persistedAiText(h.pgCalls)).not.toContain(fake);
  });

  it('формат маркера ровно тот, что разбирает фронт: {{audio:id=<36 симв. lowercase>}}', async () => {
    const h = makeHarness({ deltas: ['ок'], clips: [fresh(CLIP_A)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    // Регулярка скопирована из spirits_front/src/utils/customMarkdown.tsx
    // (AUDIO_CLIP_REGEX) — свой формат придумывать нельзя, фронт его не поймёт.
    const AUDIO_CLIP_REGEX = /\{\{audio:id=([a-f0-9-]{36})\}\}/g;
    const found = [...String(end.content).matchAll(AUDIO_CLIP_REGEX)].map((m) => m[1]);
    expect(found).toEqual([CLIP_A]);
  });

  it('падение запроса клипов не роняет ответ ассистента', async () => {
    const h = makeHarness({ deltas: ['Текст ответа.'], clips: [fresh(CLIP_A)] });
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

/**
 * Дефект 1: кэш-хит не давал маркера.
 *
 * «Повтор того же текста бесплатно» — заявленная фича кэша: SpeechService
 * находит клип по (user_id, cache_key), возвращает ok и tokensSpent: 0, нового
 * INSERT нет. Но выборка маркеров смотрела только на created_at, а у такого
 * клипа он старый — маркер не подставлялся. Наружу это выглядит хуже всего:
 * инструмент отчитался успехом, модель написала «готово, слушай», а плеера нет.
 *
 * Лечение: SpeechService на кэш-хите двигает last_used_at, а выборка берёт
 * клипы по `created_at >= $2 OR last_used_at >= $2`.
 */
describe('streamUniversalAgent — кэш-хит озвучки (дефект 1)', () => {
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

  it('повтор того же текста (клип из кэша, created_at старый) всё равно даёт маркер', async () => {
    const h = makeHarness({ deltas: ['Готово, слушай.'], clips: [cachedHit(CLIP_A, 1000)] });
    await h.run();

    const marker = `{{audio:id=${CLIP_A}}}`;
    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toContain(marker);
    // И в поток, и в историю — плеер должен пережить F5 ровно как у свежего клипа.
    const items = h.written.filter((w) => w.type === 'item').map((w) => w.content);
    expect(items.some((c: string) => c.includes(marker))).toBe(true);
    expect(persistedAiText(h.pgCalls)).toContain(marker);
  });

  it('в одном ответе свежий синтез и кэш-хит — маркеры на оба', async () => {
    const h = makeHarness({ deltas: ['Сценка:'], clips: [cachedHit(CLIP_A, 1000), fresh(CLIP_B, 2000)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(end.content).toContain(`{{audio:id=${CLIP_B}}}`);
  });

  it('выборка маркеров смотрит и на created_at, и на last_used_at', async () => {
    const h = makeHarness({ deltas: ['ок'], clips: [cachedHit(CLIP_A, 1000)] });
    await h.run();

    const q = markerQuery(h.pgCalls);
    expect(q!.sql).toMatch(/created_at >= \$2::timestamptz/);
    expect(q!.sql).toMatch(/last_used_at >= \$2::timestamptz/);
  });

  it('старый клип, который сегодня НЕ трогали, в ответ не лезет', async () => {
    // last_used_at такого клипа тоже в прошлом — эмулируем тем, что его просто
    // нет среди «выданных за стрим» строк. Проверяем, что маркеров не появилось
    // на пустой выборке (иначе граница по времени была бы декоративной).
    const h = makeHarness({ deltas: ['Просто текст.'], clips: [] });
    await h.run();
    const end = h.written.find((w) => w.type === 'end');
    expect(end.content).not.toContain('{{audio:');
  });

  it('маркеров не больше 50 за ответ — потолок против сотен клипов в длинном стриме', async () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      fresh(`${String(i).padStart(8, '0')}-2222-4333-8444-555555555555`),
    );
    const h = makeHarness({ deltas: ['Много.'], clips: many });
    await h.run();

    const q = markerQuery(h.pgCalls);
    expect(q!.sql).toMatch(/LIMIT 50/);

    const end = h.written.find((w) => w.type === 'end');
    const found = [...String(end.content).matchAll(/\{\{audio:id=([a-f0-9-]{36})\}\}/g)];
    expect(found).toHaveLength(50);
  });
});

/**
 * Дефект 2: стоимость озвучки не попадала в индикатор «X токенов».
 *
 * У speech_clips вообще не было колонки tokens_spent, поэтому сценка из десяти
 * реплик уводила баланс на 10 000 невидимо для пользователя: списание шло, а
 * под сообщением показывалась только стоимость текста.
 *
 * Тонкость — кэш-хит: у его строки tokens_spent > 0 (это плата за ПЕРВЫЙ
 * синтез), но сейчас денег не брали. Поэтому сумма считается по created_at, а
 * не по last_used_at: последнее нужно только маркерам.
 */
describe('streamUniversalAgent — стоимость озвучки в счётчике (дефект 2)', () => {
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

  /** Стоимость текста ответа: длина × SDK_TEXT_MULTIPLIER (=2). */
  const textCost = (s: string) => s.length * 2;

  it('свежий синтез добавляет свою стоимость к показанному итогу', async () => {
    const h = makeHarness({ deltas: ['Готово.'], clips: [fresh(CLIP_A, 2000)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.usage.total).toBe(textCost(end.content) + 2000);
  });

  it('сценка из нескольких реплик суммирует стоимость всех клипов', async () => {
    const h = makeHarness({ deltas: ['Сценка:'], clips: [fresh(CLIP_A, 1000), fresh(CLIP_B, 3000)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.usage.total).toBe(textCost(end.content) + 4000);
  });

  it('кэш-хит бесплатен — его старая плата в итог НЕ попадает', async () => {
    const h = makeHarness({ deltas: ['Готово.'], clips: [cachedHit(CLIP_A, 1000)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    // Маркер есть (дефект 1), а денег за него сегодня не брали.
    expect(end.content).toContain(`{{audio:id=${CLIP_A}}}`);
    expect(end.usage.total).toBe(textCost(end.content));
  });

  it('свежий синтез + кэш-хит: считается только свежий', async () => {
    const h = makeHarness({ deltas: ['Сценка:'], clips: [cachedHit(CLIP_A, 1000), fresh(CLIP_B, 2000)] });
    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.usage.total).toBe(textCost(end.content) + 2000);
  });

  it('запрос стоимости ограничен created_at — last_used_at в нём быть не должно', async () => {
    const h = makeHarness({ deltas: ['ок'], clips: [fresh(CLIP_A, 1000)] });
    await h.run();

    const q = spendQuery(h.pgCalls);
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/user_id = \$1/);
    expect(q!.sql).toMatch(/created_at >= \$2::timestamptz/);
    expect(q!.sql).not.toMatch(/last_used_at/);
  });

  it('нет speech_clips (миграция не докатилась) — учёт картинок и видео не ломается', async () => {
    const h = makeHarness({ deltas: ['Текст.'], clips: [fresh(CLIP_A, 1000)] });
    const orig = (h.svc as any).pg.query;
    (h.svc as any).pg.query = jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM speech_clips/.test(sql)) throw new Error('relation "speech_clips" does not exist');
      // Картинки/видео за этот стрим отдали 700 токенов — они обязаны дойти.
      if (/AS spent/.test(sql)) return { rows: [{ spent: 700 }] };
      return orig(sql, params);
    });

    await h.run();

    const end = h.written.find((w) => w.type === 'end');
    expect(end.usage.total).toBe(textCost(end.content) + 700);
  });
});
