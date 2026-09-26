import axios from 'axios';
import { BlogApprovalService } from './blog-approval.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogController } from './blog.controller';
import { BlogCron } from './blog.cron';
import { formatQueueShift, leaveQueue } from './blog-queue';
import { SLOT_INDEX } from './blog-slot-claim';
import { rowToPost } from './blog.types';

jest.mock('axios');

/**
 * Очередь без дыр: пост ушёл из очереди раньше своего слота — каждый
 * следующий одобренный встаёт на слот предыдущего.
 *
 * Решение владельца. Кира в понедельник, Продукты в среду; Киру выпустили
 * сейчас — Продукты переезжают на понедельник, а не ждут среды при пустом
 * понедельнике. Поводов уйти из очереди три — опубликован сейчас, отправлен в
 * мусор, отправлен на переработку, — и правило одно на все пути: админку,
 * кнопки в личке, крон. Ручной перенос (`reschedule`) очередь НЕ двигает: это
 * осознанный выбор слота владельцем.
 *
 * Postgres здесь в миниатюре, но условия он читает из САМИХ запросов, а не
 * зашивает в себя: какие статусы двигаются, двигается ли очередь в прошлое —
 * решает текст запроса, и мутация кода меняет ответ заглушки. Частичный
 * уникальный индекс (004_one_post_per_slot.sql) заглушка держит как база:
 * запись поста в занятый слот — 23505. Транзакции откатываются по-настоящему,
 * каждая на своём соединении. Незнакомый запрос — ошибка: за SQL, которого
 * она не понимает, заглушка не ручается.
 *
 * Блокировки строк и гонки здесь не воспроизводятся — они проверяются против
 * живого Postgres в blog-approval.integration.spec.ts.
 */

// сб 26 сентября 2026, 12:00 МСК. Слоты пн/ср/пт 10:00 МСК.
const SAT = '2026-09-26T09:00:00.000Z';
const FRI_PAST = '2026-09-25T07:00:00.000Z';   // пт 25-го — уже прошёл
const MON = '2026-09-28T07:00:00.000Z';
const WED = '2026-09-30T07:00:00.000Z';
const FRI = '2026-10-02T07:00:00.000Z';
const MON2 = '2026-10-05T07:00:00.000Z';

const VERSION = '2026-09-25T10:00:00.000Z';   // updated_at постов по умолчанию
const APPROVER = 77;

type Row = Record<string, any>;

const HOLDING = ['approved', 'publishing'];
const TIMESTAMPS = ['slot_at', 'published_at', 'created_at', 'updated_at', 'drafting_started_at'];
const ms = (v: any): number | null => (v === null || v === undefined ? null : new Date(v).getTime());
const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

function seedRow(over: Row): Row {
  const row: Row = {
    rubric: 'case', source: 'manual', source_ref: null, topic_key: 'k', topic_hint: null, lang: 'ru',
    title: 'Пост', body: 'Текст', image_prompt: 'сцена', image_url: 'https://minio/i.png',
    status: 'pending_review', editor_notes: [], note_prompt_ids: [], drafting_started_at: null,
    slot_at: null, published_at: null, review_chat_id: String(APPROVER), review_message_id: '12',
    tg_message_id: null, tg_url: null, attempts: 0, last_error: null,
    created_at: '2026-09-20T09:00:00.000Z', updated_at: VERSION,
    ...over,
  };
  for (const col of TIMESTAMPS) if (row[col]) row[col] = new Date(row[col]);
  return row;
}

/**
 * WHERE из запроса — в JS-предикат над строкой. Понимает ровно те
 * конструкции, из которых собраны запросы очереди, слотов и публикации; всё,
 * что не перевелось, — ошибка.
 */
function whereToJs(clause: string): string {
  const p = (n: string) => `P[${Number(n) - 1}]`;
  const op = (o: string) => (o === '=' ? '===' : o);
  const js = clause
    .replace(/\$(\d+)::timestamptz > now\(\)/g, (_m, n) => `(ms(${p(n)}) > NOW)`)
    .replace(/\$(\d+) = ANY\(note_prompt_ids\)/g, (_m, n) => `r.note_prompt_ids.map(Number).includes(Number(${p(n)}))`)
    .replace(/(review_chat_id|review_message_id) = \$(\d+)/g, (_m, col, n) => `(Number(r.${col}) === Number(${p(n)}))`)
    .replace(/created_at < now\(\) - \(\$(\d+) \|\| ' days'\)::interval/g,
      (_m, n) => `(ms(r.created_at) < NOW - Number(${p(n)}) * 86400000)`)
    .replace(/drafting_started_at IS NOT NULL/g, '(r.drafting_started_at != null)')
    .replace(/drafting_started_at IS NULL/g, '(r.drafting_started_at == null)')
    .replace(/drafting_started_at (>=|<) now\(\) - \(\$(\d+) \|\| ' minutes'\)::interval/g,
      (_m, o, n) => `(r.drafting_started_at != null && ms(r.drafting_started_at) ${o} NOW - Number(${p(n)}) * 60000)`)
    .replace(/slot_at IS NOT NULL/g, '(r.slot_at != null)')
    .replace(/slot_at (<=|>=|<|>|=) now\(\)/g, (_m, o) => `(r.slot_at != null && ms(r.slot_at) ${op(o)} NOW)`)
    .replace(/slot_at (<=|>=|<|>|=) \$(\d+)/g, (_m, o, n) => `(r.slot_at != null && ms(r.slot_at) ${op(o)} ms(${p(n)}))`)
    .replace(/status = ANY\(\$(\d+)::text\[\]\)/g, (_m, n) => `${p(n)}.includes(r.status)`)
    .replace(/status IN \(([^)]*)\)/g, (_m, list) => `[${list}].includes(r.status)`)
    .replace(/status = \$(\d+)/g, (_m, n) => `(r.status === ${p(n)})`)
    .replace(/status = ('[a-z_]+')/g, (_m, s) => `(r.status === ${s})`)
    .replace(/rubric = ('[a-z_]+')/g, (_m, s) => `(r.rubric === ${s})`)
    .replace(/\bid = \$(\d+)/g, (_m, n) => `(r.id === ${p(n)})`)
    .replace(/attempts < \$(\d+)/g, (_m, n) => `(r.attempts < ${p(n)})`)
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||');
  const leftover = js
    .replace(/ms\((r\.[a-z_]+|P\[\d+\])\)|Number\((r\.[a-z_]+|P\[\d+\])\)|\.map\(Number\)|r\.[a-z_]+|P\[\d+\]|NOW|\.includes|null|'[a-z_]+'|\d+/g, '')
    .replace(/===|!=|==|>=|<=|&&|\|\||[<>*+\-()[\],\s]/g, '');
  if (leftover) throw new Error(`заглушка не понимает условия «${clause}»: не перевелось «${leftover}»`);
  return js;
}

/** Значение в SET. */
function setValue(expr: string, row: Row, params: any[]): any {
  let m: RegExpMatchArray | null;
  if (expr === 'now()') return new Date(Date.now());
  if (expr === 'NULL') return null;
  if (expr === "'{}'::text[]") return [];
  if ((m = expr.match(/^\$(\d+)(?:::[a-z]+(?:\[\])?)?$/))) return params[Number(m[1]) - 1];
  if ((m = expr.match(/^'([^']*)'$/))) return m[1];
  if ((m = expr.match(/^([a-z_]+) \+ 1$/))) return Number(row[m[1]]) + 1;
  throw new Error(`заглушка не понимает значения «${expr}»`);
}

interface Tx { undo: Map<string, Row> | null }

/** Postgres в миниатюре: таблица blog_post, индекс uq_blog_post_slot, транзакции по соединениям. */
function blogPg(seed: Row[]) {
  const rows: Row[] = seed.map(seedRow);
  const log: string[] = [];
  const faults: Array<{ pattern: RegExp; when: (params: any[]) => boolean; error: Error }> = [];
  const hooks: Array<{ pattern: RegExp; run: () => void }> = [];

  const duplicate = () => Object.assign(
    new Error(`duplicate key value violates unique constraint "${SLOT_INDEX}"`),
    { code: '23505', constraint: SLOT_INDEX },
  );
  const holds = (r: Row) => HOLDING.includes(r.status) && r.slot_at != null;

  const run = async (sql: string, params: any[] = [], tx: Tx | null) => {
    const s = String(sql).replace(/\s+/g, ' ').trim();
    log.push(s);
    for (const f of faults) if (f.pattern.test(s) && f.when(params)) throw f.error;
    for (const h of hooks.splice(0)) {
      if (h.pattern.test(s)) h.run();
      else hooks.push(h);
    }

    if (s === 'BEGIN') {
      if (tx) tx.undo = new Map();
      return { rows: [], rowCount: null };
    }
    if (s === 'COMMIT') {
      if (tx) tx.undo = null;
      return { rows: [], rowCount: null };
    }
    if (s === 'ROLLBACK') {
      for (const [id, saved] of tx?.undo ?? []) {
        const r = rows.find((x) => x.id === id)!;
        for (const k of Object.keys(r)) delete r[k];
        Object.assign(r, saved);
      }
      if (tx) tx.undo = null;
      return { rows: [], rowCount: null };
    }

    let m = s.match(/^SELECT (.+?) FROM blog_post WHERE (.+?)(?: ORDER BY ([a-z_]+)(?: (ASC|DESC))?( NULLS LAST)?)?(?: LIMIT (\d+))?( FOR UPDATE)?$/);
    if (m) {
      const [, cols, where, orderCol, dir, , limit] = m;
      const test = new Function('r', 'P', 'NOW', 'ms', `return (${whereToJs(where)});`);
      let hit = rows.filter((r) => test(r, params, Date.now(), ms));
      if (orderCol) {
        const sign = dir === 'DESC' ? -1 : 1;
        const key = (r: Row) => (TIMESTAMPS.includes(orderCol) ? ms(r[orderCol]) : r[orderCol]);
        hit = [...hit].sort((a, b) => {
          const x = key(a), y = key(b);
          if (x === y) return 0;
          if (x === null) return 1;      // NULLS LAST в обе стороны — других порядков запросы не просят
          if (y === null) return -1;
          return (x < y ? -1 : 1) * sign;
        });
      }
      if (limit) hit = hit.slice(0, Number(limit));
      if (cols === 'count(*)::int AS n') return { rows: [{ n: hit.length }], rowCount: 1 };
      const project = (r: Row) => (cols === '*' ? { ...r }
        : Object.fromEntries(cols.split(/,\s*/).map((c) => [c, r[c]])));
      return { rows: hit.map(project), rowCount: hit.length };
    }

    m = s.match(/^UPDATE blog_post SET (.+?) WHERE (.+?)(?: RETURNING (.+))?$/);
    if (m) {
      const [, sets, where, returning] = m;
      const test = new Function('r', 'P', 'NOW', 'ms', `return (${whereToJs(where)});`);
      const assignments = sets.split(/,\s*(?=[a-z_]+ = )/).map((part) => {
        const a = part.match(/^([a-z_]+) = (.+)$/);
        if (!a) throw new Error(`заглушка не понимает присваивания «${part}»`);
        return a;
      });
      const hit = rows.filter((r) => test(r, params, Date.now(), ms));
      const before = hit.map((r) => ({ ...r }));
      try {
        for (const r of hit) {
          const next = { ...r };
          for (const [, col, expr] of assignments) {
            const v = setValue(expr.trim(), r, params);
            next[col] = TIMESTAMPS.includes(col) && typeof v === 'string' ? new Date(v) : v;
          }
          // Индекс проверяется построчно, как у настоящего неотложенного
          // уникального индекса: в занятый слот не пускает сразу.
          if (holds(next) && rows.some((x) => x.id !== r.id && holds(x) && ms(x.slot_at) === ms(next.slot_at))) {
            throw duplicate();
          }
          if (tx?.undo && !tx.undo.has(r.id)) tx.undo.set(r.id, { ...r });
          Object.assign(r, next);
        }
      } catch (e) {
        hit.forEach((r, i) => Object.assign(r, before[i]));   // запрос падает целиком
        throw e;
      }
      const out = returning === '*' ? hit.map((r) => ({ ...r }))
        : returning ? hit.map((r) => Object.fromEntries(returning.split(/,\s*/).map((c) => [c, r[c]])))
          : [];
      return { rows: out, rowCount: hit.length };
    }

    throw new Error(`заглушка не знает запроса: ${s}`);
  };

  return {
    rows,
    log,
    row: (id: string) => rows.find((r) => r.id === id)!,
    slot: (id: string) => iso(rows.find((r) => r.id === id)!.slot_at),
    /** Запрос по образцу (и параметрам) упадёт с этой ошибкой. */
    fail(pattern: RegExp, error: Error, when: (params: any[]) => boolean = () => true) {
      faults.push({ pattern, when, error });
    },
    /** Перед первым запросом по образцу — чужая запись «между чтением и записью». */
    before(pattern: RegExp, run: () => void) {
      hooks.push({ pattern, run });
    },
    query: jest.fn((sql: string, params?: any[]) => run(sql, params, null)),
    getClient: jest.fn(async () => {
      const tx: Tx = { undo: null };
      return { query: (sql: string, params?: any[]) => run(sql, params, tx), release: jest.fn() };
    }),
  };
}

const SETTINGS = { channelChatId: '-1001234567890', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' };

function fakeTg() {
  const sent: Array<{ chatId: number; text: string }> = [];
  return {
    sent,
    answerCallbackQuery: jest.fn(async () => true),
    editMessageText: jest.fn(),
    sendMessage: jest.fn(async (chatId: number, text: string) => {
      sent.push({ chatId, text });
      return { message_id: 900 + sent.length, chat: { id: chatId } };
    }),
    sendPhoto: jest.fn(async (chatId: number) => ({ message_id: 42, chat: { id: chatId, username: 'linkeon_blog' } })),
  };
}

/** Весь блог поверх одной базы: админка, кнопки в личке, паблишер, крон. */
function world(seed: Row[], settingsOver: Partial<typeof SETTINGS> = {}) {
  const pg = blogPg(seed);
  const tg = fakeTg();
  const settings = { get: jest.fn(async () => ({ ...SETTINGS, ...settingsOver })), update: jest.fn() };
  const approval = new BlogApprovalService(pg as any, tg as any, settings as any);
  const publisher = new BlogPublisherService(pg as any, tg as any, settings as any);
  const admin = new BlogController(
    pg as any, { addTopic: jest.fn() } as any, settings as any, { render: jest.fn() } as any, publisher, approval,
  );
  const cron = new BlogCron(pg as any, {} as any, {} as any, {} as any, publisher, approval, settings as any, {} as any);

  /** Код и тело ответа админки — ровно то, что уйдёт фронту. */
  const call = async (body: any): Promise<{ status: number; body: any }> => {
    const r: any = {};
    r.status = jest.fn().mockReturnValue(r);
    r.json = jest.fn().mockReturnValue(r);
    try {
      await admin.action(body, r);
      return { status: r.status.mock.calls[0][0], body: r.json.mock.calls[0][0] };
    } catch (e: any) {
      if (typeof e?.getStatus !== 'function') throw e;
      return { status: e.getStatus(), body: e.getResponse() };
    }
  };

  /** Кнопка под черновиком в личке. */
  const press = (action: 'ok' | 'no' | 'redo', id: string, chat = APPROVER) => approval.handleCallback({
    id: `cb-${action}-${id}`, data: `blog:${action}:${id}`, from: { id: chat }, message: { chat: { id: chat }, message_id: 12 },
  });

  return { pg, tg, settings, approval, publisher, admin, cron, call, press };
}

const OLD_ENV = { enabled: process.env.BLOG_ENABLED, approver: process.env.BLOG_APPROVER_TG_ID };

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] });
  jest.setSystemTime(new Date(SAT));
  (axios.get as jest.Mock).mockResolvedValue({ data: Buffer.from('png-bytes') });
  process.env.BLOG_ENABLED = 'true';
  process.env.BLOG_APPROVER_TG_ID = String(APPROVER);
});

afterEach(() => {
  jest.useRealTimers();
  restoreEnv('BLOG_ENABLED', OLD_ENV.enabled);
  restoreEnv('BLOG_APPROVER_TG_ID', OLD_ENV.approver);
});

/** Уход «в мусор» — самый простой способ освободить слот для проверки самих правил сдвига. */
const trash = (pg: any, id: string) => leaveQueue(pg, id, async (tx, post) => {
  const r = await tx.query(
    `UPDATE blog_post SET status = 'rejected', updated_at = now() WHERE id = $1 AND status = $2`,
    [post.id, post.status],
  );
  return r.rowCount !== 0;
});

const shiftsOf = (shifted: any[]) => shifted.map((s) => [s.id, s.title, iso(s.from), iso(s.to)]);

describe('сдвиг очереди — правила', () => {
  it('каждый следующий одобренный встаёт на слот предыдущего, сдвиги названы по порядку', async () => {
    const pg = blogPg([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
      { id: 'case', title: 'Кейс', status: 'approved', slot_at: FRI },
      { id: 'news', title: 'Новость', status: 'approved', slot_at: MON2 },
    ]);

    const { shifted } = await trash(pg, 'kira');

    expect([pg.slot('products'), pg.slot('case'), pg.slot('news')]).toEqual([MON, WED, FRI]);
    expect(shiftsOf(shifted)).toEqual([
      ['products', 'Продукты', WED, MON],
      ['case', 'Кейс', FRI, WED],
      ['news', 'Новость', MON2, FRI],
    ]);
  });

  /**
   * Сорвавшаяся в своём слоте публикация держит слот, который уже наступил.
   * Сдвинь очередь на него — следующий пост встал бы в прошлое и вышел бы
   * ближайшим тиком, мимо расписания.
   */
  it('освободился слот, который уже наступил, — никто не сдвигается', async () => {
    const pg = blogPg([
      { id: 'late', title: 'Сорвался в пятницу', status: 'approved', slot_at: FRI_PAST, attempts: 1 },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: MON },
    ]);

    const { shifted } = await trash(pg, 'late');

    expect(shifted).toEqual([]);
    expect(pg.slot('products')).toBe(MON);
  });

  it('пост в publishing не трогается — он прямо сейчас уходит в канал', async () => {
    const pg = blogPg([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'going', title: 'Уходит в канал', status: 'publishing', slot_at: WED },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: FRI },
    ]);

    const { shifted } = await trash(pg, 'kira');

    expect(pg.slot('going')).toBe(WED);
    expect(pg.row('going').status).toBe('publishing');
    expect(pg.slot('products')).toBe(MON);
    expect(shiftsOf(shifted)).toEqual([['products', 'Продукты', FRI, MON]]);
  });

  it('двигаются только одобренные: опубликованный, отклонённый и черновик со старым слотом стоят', async () => {
    const pg = blogPg([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'out', status: 'published', slot_at: WED },
      { id: 'trash', status: 'rejected', slot_at: WED },
      { id: 'redo', status: 'drafting', slot_at: FRI },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: MON2 },
    ]);

    await trash(pg, 'kira');

    expect([pg.slot('out'), pg.slot('trash'), pg.slot('redo')]).toEqual([WED, WED, FRI]);
    expect(pg.slot('products')).toBe(MON);
  });

  /**
   * Переработанный пост хранит старый `slot_at`, а его слот после сдвига уже
   * занял следующий. Уход такого поста в мусор — не уход из очереди: он в ней
   * не стоял. Сдвинь очередь от его старого слота — следующий пост упёрся бы
   * в того, кто этот слот уже держит (23505), и кнопка отвечала бы 500.
   */
  it('уходит пост не из approved, пусть и со старым слотом, — очередь стоит', async () => {
    const pg = blogPg([
      { id: 'redo', title: 'На переработке', status: 'drafting', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: MON },
      { id: 'case', title: 'Кейс', status: 'approved', slot_at: WED },
    ]);

    const { applied, shifted } = await trash(pg, 'redo');

    expect(applied).toBe(true);
    expect(shifted).toEqual([]);
    expect([pg.slot('products'), pg.slot('case')]).toEqual([MON, WED]);
    expect(pg.slot('redo')).toBeNull();   // и чужой ему слот с него снят
  });

  it('запись не прошла — очередь стоит', async () => {
    const pg = blogPg([
      { id: 'kira', status: 'approved', slot_at: MON },
      { id: 'products', status: 'approved', slot_at: WED },
    ]);

    const out = await leaveQueue(pg as any, 'kira', async () => false);

    expect(out).toMatchObject({ applied: false, shifted: [] });
    expect(pg.slot('products')).toBe(WED);
  });

  it('пост остался в своём слоте — сдвигать нечего', async () => {
    const pg = blogPg([
      { id: 'kira', status: 'approved', slot_at: MON },
      { id: 'products', status: 'approved', slot_at: WED },
    ]);

    const out = await leaveQueue(pg as any, 'kira', async (tx, post) => {
      await tx.query(`UPDATE blog_post SET title = $2, updated_at = now() WHERE id = $1`, [post.id, 'Новый заголовок']);
      return true;
    });

    expect(out.shifted).toEqual([]);
    expect(pg.slot('products')).toBe(WED);
  });

  it('поста нет — ничего не пишется', async () => {
    const pg = blogPg([{ id: 'products', status: 'approved', slot_at: WED }]);
    const apply = jest.fn(async () => true);

    const out = await leaveQueue(pg as any, 'ghost', apply);

    expect(out).toEqual({ before: null, applied: false, shifted: [] });
    expect(apply).not.toHaveBeenCalled();
  });

  /** Атомарность: сдвиг — одна транзакция вместе с уходом поста. */
  it('сбой посреди сдвига откатывает всё, включая уход поста', async () => {
    const pg = blogPg([
      { id: 'kira', status: 'approved', slot_at: MON },
      { id: 'products', status: 'approved', slot_at: WED },
      { id: 'case', status: 'approved', slot_at: FRI },
    ]);
    pg.fail(/^UPDATE blog_post SET slot_at = /, new Error('connection reset'), (params) => params[0] === 'case');

    await expect(trash(pg, 'kira')).rejects.toThrow('connection reset');

    expect(pg.row('kira').status).toBe('approved');
    expect([pg.slot('kira'), pg.slot('products'), pg.slot('case')]).toEqual([MON, WED, FRI]);
    expect(pg.log).toContain('ROLLBACK');
  });
});

/**
 * Каждый путь, которым одобренный пост уходит из очереди, сдвигает её — одним
 * и тем же правилом. Кира в понедельник, Продукты в среду: Кира ушла —
 * Продукты на понедельнике.
 */
describe('каждый путь ухода из очереди сдвигает её', () => {
  const queue = (kira: Row = {}) => [
    { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON, ...kira },
    { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
  ];

  it('админка: reject — ответ по-прежнему сам пост', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'reject', id: 'kira' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'kira', status: 'rejected', slotAt: null });
    expect(w.pg.slot('kira')).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('админка: redraft — ответ по-прежнему сам пост', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'redraft', id: 'kira' });

    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'kira', status: 'drafting', slotAt: null });
    expect(w.pg.slot('kira')).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('админка: publish_now', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'publish_now', id: 'kira' });

    expect(r.status).toBe(200);
    expect(w.pg.row('kira').status).toBe('published');
    expect(w.pg.slot('kira')).toBe(SAT);   // слот «сейчас» — история выхода
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('личка: «🗑 В мусор» под одобренным постом', async () => {
    const w = world(queue());

    await w.press('no', 'kira');

    expect(w.pg.row('kira').status).toBe('rejected');
    expect(w.pg.slot('kira')).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('личка: «🔄 Переписать» под одобренным постом', async () => {
    const w = world(queue());

    await w.press('redo', 'kira');

    expect(w.pg.row('kira').status).toBe('drafting');
    expect(w.pg.slot('kira')).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('крон: протухшая одобренная новость уходит в мусор', async () => {
    const w = world(queue({ rubric: 'news', created_at: '2026-09-01T09:00:00.000Z' }));

    await w.cron.dropStaleNews();

    expect(w.pg.row('kira')).toMatchObject({ status: 'rejected', last_error: 'протухла', slot_at: null });
    expect(w.pg.slot('products')).toBe(MON);
  });

  /**
   * Путь не из списка владельца. Черновик, который пишется дольше порога
   * STALE_DRAFTING_MINUTES, подбирает второй тик; первый тем временем
   * показывает свой вариант, владелец его одобряет — и поздний второй
   * возвращает пост на проверку уже со своим текстом. Пост ушёл из очереди
   * раньше слота — очередь сдвигается тем же правилом.
   */
  it('поздний второй черновик возвращает одобренный пост на проверку', async () => {
    const w = world(queue());
    const stale = { ...rowToPost(w.pg.row('kira')), status: 'drafting' as const };

    await w.approval.sendForReview(stale, APPROVER);

    expect(w.pg.row('kira').status).toBe('pending_review');
    expect(w.pg.slot('kira')).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('ручной перенос очередь НЕ сдвигает — это выбор слота владельцем', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'reschedule', id: 'kira', slotAt: FRI });

    expect(r.status).toBe(200);
    expect(w.pg.slot('kira')).toBe(FRI);
    expect(w.pg.slot('products')).toBe(WED);
  });
});

/**
 * Ушедший из очереди пост не держит ложный слот.
 *
 * Очередь сдвигается при каждом уходе, так что старый `slot_at` ушедшего
 * поста почти всегда совпадает со слотом, который уже занял следующий. В
 * админке у черновика висело бы «слот пн 28.09», которого у него нет, — а
 * владелец решает, что выйдет в понедельник, глядя на эти подписи. Слот
 * появится заново при следующем одобрении (ближайший свободный).
 *
 * Слот остаётся там, где он что-то значит: у `publish_now` — «сейчас», на нём
 * держится ретрай; у опубликованного — история выхода.
 */
describe('ушедший из очереди пост не держит ложный слот', () => {
  it('одобренный пост на пн ушёл на переработку — слота у него нет, пн у следующего', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);

    await w.call({ action: 'redraft', id: 'kira' });

    expect(w.pg.row('kira').slot_at).toBeNull();
    expect(w.pg.slot('products')).toBe(MON);
  });

  it('переработанный пост при новом одобрении получает свободный слот, а не старый', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);
    await w.call({ action: 'redraft', id: 'kira' });
    Object.assign(w.pg.row('kira'), { status: 'pending_review' });   // черновик переписан и показан снова

    await w.press('ok', 'kira');

    expect(w.pg.slot('products')).toBe(MON);
    expect(w.pg.slot('kira')).toBe(WED);
  });

  it('publish_now, который Telegram не принял, держит слот «сейчас» — на нём ретрай', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);
    w.tg.sendPhoto.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    await w.call({ action: 'publish_now', id: 'kira' });

    expect(w.pg.row('kira').status).toBe('approved');
    expect(w.pg.slot('kira')).toBe(SAT);
  });

  it('опубликованный в свой слот пост хранит слот — это история', async () => {
    const w = world([{ id: 'kira', title: 'Кира', status: 'approved', slot_at: FRI_PAST }]);

    await w.cron.publishDue();

    expect(w.pg.row('kira').status).toBe('published');
    expect(w.pg.slot('kira')).toBe(FRI_PAST);
  });
});

describe('владельцу — одно сообщение со всеми сдвигами', () => {
  it('один сдвиг', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);

    await w.call({ action: 'reject', id: 'kira' });

    expect(w.tg.sent).toEqual([
      { chatId: APPROVER, text: 'Очередь сдвинулась: «Продукты» — теперь в понедельник, 28 сентября, в 10:00 МСК.' },
    ]);
  });

  it('несколько сдвигов — всё в одном сообщении', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
      { id: 'case', title: 'Кейс', status: 'approved', slot_at: FRI },
    ]);

    await w.call({ action: 'redraft', id: 'kira' });

    expect(w.tg.sent).toHaveLength(1);
    expect(w.tg.sent[0].text).toBe(
      'Очередь сдвинулась:\n'
      + '«Продукты» — теперь в понедельник, 28 сентября, в 10:00 МСК;\n'
      + '«Кейс» — теперь в среду, 30 сентября, в 10:00 МСК.',
    );
  });

  it('сдвигов нет — сообщения нет', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);

    await w.call({ action: 'reject', id: 'products' });   // последний в очереди

    expect(w.tg.sent).toEqual([]);
  });

  it('кнопка в личке — сообщение в тот чат, где её нажали', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);

    await w.press('no', 'kira', 555);

    expect(w.tg.sent.map((m) => m.chatId)).toEqual([555]);
    expect(w.tg.sent[0].text).toContain('«Продукты» — теперь в понедельник');
  });

  /**
   * Крон выбрасывает протухшие новости по одной, и каждая сдвигает очередь.
   * Владельцу — одно сообщение с тем, где посты оказались в итоге, а не
   * цепочка промежуточных переездов.
   */
  it('крон выбросил две одобренные новости — одно сообщение с итоговыми слотами', async () => {
    const stale = { rubric: 'news', created_at: '2026-09-01T09:00:00.000Z' };
    const w = world([
      { id: 'old1', title: 'Старая 1', status: 'approved', slot_at: MON, ...stale },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
      { id: 'old2', title: 'Старая 2', status: 'approved', slot_at: FRI, ...stale },
      { id: 'case', title: 'Кейс', status: 'approved', slot_at: MON2 },
    ]);

    await w.cron.dropStaleNews();

    expect([w.pg.slot('products'), w.pg.slot('case')]).toEqual([MON, WED]);
    expect(w.tg.sent).toEqual([{
      chatId: APPROVER,
      text: 'Очередь сдвинулась:\n'
        + '«Продукты» — теперь в понедельник, 28 сентября, в 10:00 МСК;\n'
        + '«Кейс» — теперь в среду, 30 сентября, в 10:00 МСК.',
    }]);
  });

  it('пост без заголовка назван постом без заголовка', () => {
    const text = formatQueueShift(
      [{ id: 'x', title: null, from: new Date(WED), to: new Date(MON) }],
      new Date(SAT),
    );
    expect(text).toBe('Очередь сдвинулась: пост без заголовка — теперь в понедельник, 28 сентября, в 10:00 МСК.');
  });

  it('пустой список — текста нет', () => {
    expect(formatQueueShift([], new Date(SAT))).toBeNull();
  });
});

/**
 * Контракт `publish_now` зафиксирован для фронта, который делается
 * параллельно, — поэтому тело ответа сверяется целиком.
 */
describe('publish_now — контракт', () => {
  const queue = (kira: Row = {}) => [
    { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON, ...kira },
    { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
  ];

  it('одобренный пост выходит сейчас: 200 { post: published + tgUrl, shifted }', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'publish_now', id: 'kira', updatedAt: VERSION });

    expect(r.status).toBe(200);
    expect(r.body.post).toMatchObject({ id: 'kira', status: 'published', tgUrl: 'https://t.me/linkeon_blog/42' });
    expect(r.body.shifted).toEqual([{ id: 'products', title: 'Продукты', from: WED, to: MON }]);
    expect(w.tg.sendPhoto).toHaveBeenCalledTimes(1);
  });

  /**
   * Telegram не принял: пост остаётся в approved с lastError и слотом «сейчас»,
   * так что ближайший тик publishDue его подхватит. Очередь при этом уже
   * сдвинута — это корректно: пост выйдет ближайшим тиком.
   */
  it('Telegram не принял — approved с lastError, очередь сдвинута, ближайший тик публикует', async () => {
    const w = world(queue());
    w.tg.sendPhoto.mockRejectedValueOnce(new Error('ETIMEDOUT'));

    const r = await w.call({ action: 'publish_now', id: 'kira' });

    expect(r.status).toBe(200);
    expect(r.body.post).toMatchObject({ id: 'kira', status: 'approved' });
    expect(r.body.post.lastError).toContain('ETIMEDOUT');
    expect(r.body.shifted).toEqual([{ id: 'products', title: 'Продукты', from: WED, to: MON }]);
    expect(w.pg.slot('products')).toBe(MON);

    await w.cron.publishDue();

    expect(w.pg.row('kira')).toMatchObject({ status: 'published', tg_url: 'https://t.me/linkeon_blog/42' });
    expect(w.pg.row('products').status).toBe('approved');   // её слот ещё не наступил
  });

  it('пост на проверке одобряется и выходит сразу; слота у него не было — сдвигать нечего', async () => {
    const w = world([
      { id: 'draft', title: 'Черновик', status: 'pending_review' },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
    ]);

    const r = await w.call({ action: 'publish_now', id: 'draft' });

    expect(r.status).toBe(200);
    expect(r.body.post).toMatchObject({ id: 'draft', status: 'published' });
    expect(r.body.shifted).toEqual([]);
    expect(w.pg.slot('products')).toBe(WED);
    expect(w.tg.sent).toEqual([]);
  });

  it('публикация, сорвавшаяся в своём слоте: выходит сейчас, но никто не сдвигается', async () => {
    const w = world([
      { id: 'late', title: 'Сорвался в пятницу', status: 'approved', slot_at: FRI_PAST, attempts: 1, last_error: 'ETIMEDOUT' },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: MON },
    ]);

    const r = await w.call({ action: 'publish_now', id: 'late' });

    expect(r.status).toBe(200);
    expect(r.body.post.status).toBe('published');
    expect(r.body.shifted).toEqual([]);
    expect(w.pg.slot('products')).toBe(MON);
  });

  const untouched = (w: ReturnType<typeof world>) => {
    expect(w.pg.row('kira').status).toBe('approved');
    expect(w.pg.slot('kira')).toBe(MON);
    expect(w.pg.slot('products')).toBe(WED);
    expect(w.tg.sendPhoto).not.toHaveBeenCalled();
    expect(w.tg.sent).toEqual([]);
  };

  it('устаревший updatedAt — 409 version_conflict, ничего не тронуто', async () => {
    const w = world(queue());

    const r = await w.call({ action: 'publish_now', id: 'kira', updatedAt: '2026-09-25T09:00:00.000Z' });

    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ statusCode: 409, error: 'version_conflict' });
    expect(typeof r.body.message).toBe('string');
    untouched(w);
  });

  it.each(['idea', 'drafting', 'publishing', 'published', 'rejected', 'failed'])(
    'пост в %s — 400 bad_request, ничего не тронуто',
    async (status) => {
      const w = world([...queue(), { id: 'other', status, title: 'Другой' }]);

      const r = await w.call({ action: 'publish_now', id: 'other' });

      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({ statusCode: 400, error: 'bad_request' });
      expect(w.pg.row('other').status).toBe(status);
      untouched(w);
    },
  );

  it.each([
    ['пустой id', { id: '' }],
    ['id не передан', {}],
    ['id из пробелов', { id: '   ' }],
    ['такого поста нет', { id: 'ghost' }],
  ])('%s — 400 bad_request', async (_why, payload) => {
    const w = world(queue());

    const r = await w.call({ action: 'publish_now', ...payload });

    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ statusCode: 400, error: 'bad_request' });
    untouched(w);
  });

  /**
   * Без картинки паблишер отказывает ДО захвата — пост так и висел бы в
   * approved со слотом «сейчас» и без lastError, а очередь была бы уже
   * сдвинута. Отказать надо раньше, чем что-либо тронуто.
   */
  it('у поста нет картинки — 400, ничего не тронуто', async () => {
    const w = world(queue({ image_url: null }));

    const r = await w.call({ action: 'publish_now', id: 'kira' });

    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request' });
    untouched(w);
  });

  it('канал не настроен — 400, ничего не тронуто', async () => {
    const w = world(queue(), { channelChatId: null as any });

    const r = await w.call({ action: 'publish_now', id: 'kira' });

    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: 'bad_request' });
    untouched(w);
  });
});

/**
 * Пути, которые могли бы увести одобренный пост мимо очереди, закрыты:
 * паблишер не берёт пост раньше слота, захват черновика и замечание не
 * трогают одобренный пост.
 */
describe('мимо очереди из approved не уйти', () => {
  const queue = () => [
    { id: 'kira', title: 'Кира', status: 'approved', slot_at: MON },
    { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED },
  ];

  it('паблишер не берёт пост, чей слот ещё не наступил', async () => {
    const w = world(queue());

    const result = await w.publisher.publish(rowToPost(w.pg.row('kira')));

    expect(result.ok).toBe(false);
    expect(w.pg.row('kira').status).toBe('approved');
    expect(w.tg.sendPhoto).not.toHaveBeenCalled();
  });

  /**
   * Выборка `takeNextIdea` и захват не атомарны. Пост, который выборка видела
   * черновиком, к захвату мог стать одобренным, — захват не должен увести его
   * в работу мимо очереди.
   */
  it('захват черновика не уводит одобренный пост, даже если выборка видела его черновиком', async () => {
    const w = world(queue());
    const seen = { ...rowToPost(w.pg.row('kira')), status: 'drafting' as const };
    const editor = { draft: jest.fn() };
    const cron = new BlogCron(
      w.pg as any, { takeNextIdea: jest.fn(async () => seen) } as any, editor as any, { render: jest.fn() } as any,
      w.publisher, w.approval, w.settings as any, {} as any,
    );

    await cron.prepareDrafts();

    expect(w.pg.row('kira').status).toBe('approved');
    expect(editor.draft).not.toHaveBeenCalled();
    expect(w.pg.slot('products')).toBe(WED);
  });

  it('замечание не уводит пост, одобренный между чтением и записью', async () => {
    const w = world([
      { id: 'kira', title: 'Кира', status: 'pending_review' },
      { id: 'products', title: 'Продукты', status: 'approved', slot_at: WED, review_message_id: '99' },
    ]);
    w.pg.before(/^UPDATE blog_post SET editor_notes = /, () => {
      Object.assign(w.pg.row('kira'), { status: 'approved', slot_at: new Date(MON) });
    });

    const handled = await w.approval.handleReplyEdit({
      chat: { id: APPROVER }, message_id: 500, text: 'короче', reply_to_message: { message_id: 12 },
    });

    expect(handled).toBe(true);
    expect(w.pg.row('kira')).toMatchObject({ status: 'approved', editor_notes: [] });
    expect(w.pg.slot('products')).toBe(WED);
    expect(w.tg.sent[w.tg.sent.length - 1].text).toMatch(/одобрен/);
  });
});
