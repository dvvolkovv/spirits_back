import * as fs from 'fs';
import * as path from 'path';
import { Client, Pool } from 'pg';
import { BlogApprovalService } from './blog-approval.service';
import { BlogPublisherService } from './blog-publisher.service';
import { BlogTopicService, STALE_DRAFTING_MINUTES } from './blog-topic.service';
import { BlogController } from './blog.controller';
import { BlogCron } from './blog.cron';
import { upcomingSlots } from './blog-slots';
import { SLOT_INDEX } from './blog-slot-claim';
import { MAX_NOTE_PROMPTS, rowToPost } from './blog.types';

/**
 * «✍️ Замечание» → приглашение → ответ владельца — против живого Postgres.
 *
 * ПОЧЕМУ ЭТОТ ФАЙЛ ИСПОЛНЯЕТ SQL. Что сообщение «наше», решает запрос, а не
 * код вокруг него: какие id поста он сверяет (черновик, приглашения), не
 * отсекает ли пост по статусу, дописывает ли запись id к списку или затирает
 * его. В blog-approval.service.spec.ts те же сценарии идут на заглушке,
 * которая читает эти условия из текста запроса, — она ловит те дефекты,
 * которые умеет прочесть. Здесь SQL исполняется целиком, и только здесь
 * проверяется то, чего заглушка не видит в принципе:
 *
 *  - арифметика предела: срез `[greatest(...):]` ошибается на единицу молча;
 *  - `$2 = ANY(note_prompt_ids)` по bigint[], куда node-pg шлёт параметр текстом;
 *  - два нажатия ОДНОВРЕМЕННО: чтение-изменение-запись в коде теряет одно из
 *    двух приглашений, дописывание внутри самого UPDATE — нет;
 *  - нажатие не трогает updated_at: по нему админка ловит правку из соседней
 *    вкладки, и «Замечание» в личке не должно ронять её сохранение в 409.
 *
 * КАК ГОНЯТЬ. База ОДНОРАЗОВАЯ: beforeEach делает TRUNCATE blog_post. Гард в
 * beforeAll отказывается работать с базой, где уже есть посты или таблицы
 * приложения, — и отказывается ДО миграций: иначе этот файл сам стал бы
 * способом применить 003 к чужой базе.
 *
 *   sudo -u postgres psql -qc "DROP DATABASE IF EXISTS blog_notes"
 *   sudo -u postgres psql -qc "CREATE ROLE blognotes LOGIN PASSWORD 'blognotes'"
 *   sudo -u postgres psql -qc "CREATE DATABASE blog_notes OWNER blognotes"
 *   BLOG_PG_URL=postgresql://blognotes:blognotes@127.0.0.1:5432/blog_notes npx jest src/blog
 *
 * Роль с паролем — по той же причине, что в tokens/add-tokens-race: node-pg
 * ходит по TCP, и peer-аутентификации у него нет.
 *
 * Из воркдерева `npx jest src/blog` не найдёт ни одного теста (в
 * testPathIgnorePatterns стоит /.worktrees/), там только так:
 *
 *   BLOG_PG_URL=... npx jest --testPathPattern='src/blog' --testPathIgnorePatterns='/node_modules/'
 *
 * Без BLOG_PG_URL файл пропускается целиком (skipped), а не зеленеет.
 *
 * Там же, ниже, — «один пост на слот» и очередь черновиков: частичный
 * уникальный индекс, ретрай одобрения на 23505 и условие охраны очереди
 * заглушка не воспроизведёт, они проверяются только здесь. Все блоки — в
 * одном файле намеренно: jest гоняет файлы параллельно, и второй файл на той
 * же базе стирал бы TRUNCATE-ом строки этого посреди теста.
 */

const PG = process.env.BLOG_PG_URL;
const maybe = PG ? describe : describe.skip;

/**
 * ГАРД НА ЧУЖУЮ БАЗУ — до миграций, затем схема. База приложения узнаётся по
 * его главной таблице, даже если постов в ней ещё нет.
 *
 * Каждый блок файла зовёт это в своём beforeAll и чистит таблицу в afterAll —
 * иначе гард следующего блока принял бы строки предыдущего за чужие посты.
 * Чистит ТОЛЬКО если гард базу пропустил (флаг `ours` в блоке): jest зовёт
 * afterAll и тогда, когда beforeAll упал, и без флага отказ гарда кончался бы
 * TRUNCATE-ом той самой базы, от которой он только что отказался.
 */
async function prepareDisposableDb(pool: Pool): Promise<void> {
  const probe = await pool.query(
    `SELECT to_regclass('public.blog_post') AS blog, to_regclass('public.ai_profiles_consolidated') AS app`,
  );
  if (probe.rows[0].app) {
    throw new Error('BLOG_PG_URL указывает на базу приложения — нужна одноразовая (рецепт в шапке файла)');
  }
  if (probe.rows[0].blog) {
    const n = await pool.query('SELECT count(*)::int AS n FROM blog_post');
    if (n.rows[0].n > 0) {
      throw new Error('BLOG_PG_URL указывает на базу с постами — нужна одноразовая, TRUNCATE в beforeEach их сотрёт');
    }
  }

  // Схема — теми же файлами и в том же порядке, что у scripts/migrate.ts:
  // все *.sql каталога по имени. Список руками разошёлся бы с каталогом молча.
  const dir = path.join(__dirname, 'migrations');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await pool.query(fs.readFileSync(path.join(dir, file), 'utf8'));
  }
}

const CHAT = 77;
const DRAFT = 12;

/** Telegram в миниатюре: id сообщениям по порядку и возможность придержать отправку. */
function fakeTg() {
  let nextId = 1000;
  let holdUntil = 0;
  const parked: Array<() => void> = [];
  const sent: Array<{ chatId: number; text: string; options: any; id: number }> = [];
  return {
    sent,
    /** Ни одна отправка не вернётся, пока их не накопится `n`. */
    holdSends(n: number) {
      holdUntil = n;
    },
    answerCallbackQuery: jest.fn(async () => true),
    sendPhoto: jest.fn(),
    sendMessage: jest.fn(async (chatId: number, text: string, options: any = {}) => {
      const id = nextId++;
      sent.push({ chatId, text, options, id });
      if (holdUntil > 0) {
        await new Promise<void>((resolve) => {
          parked.push(resolve);
          if (parked.length >= holdUntil) {
            holdUntil = 0;
            parked.splice(0).forEach((go) => go());
          }
        });
      }
      return { message_id: id, chat: { id: chatId } };
    }),
  };
}

maybe('Замечание к посту против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  let tg: ReturnType<typeof fakeTg>;
  let svc: BlogApprovalService;
  let ours = false;   // гард пропустил базу — только тогда её можно чистить

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await prepareDisposableDb(pool);
    ours = true;
  });

  afterAll(async () => {
    if (ours) await pool.query('TRUNCATE blog_post');
    await pool?.end();
  });

  beforeEach(async () => {
    await pool.query('TRUNCATE blog_post');
    tg = fakeTg();
    svc = new BlogApprovalService(
      { query: (sql: string, params?: any[]) => pool.query(sql, params) } as any,
      tg as any,
      { get: jest.fn() } as any,
    );
  });

  /** Пост, показанный владельцу: черновик — сообщение DRAFT в чате CHAT. */
  const insertPost = async (status = 'pending_review'): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key, title, body, status, review_chat_id, review_message_id)
       VALUES ('case', 'manual', 'k', 'Как мы считаем токены', 'Текст черновика', $1, $2, $3)
       RETURNING id`,
      [status, CHAT, DRAFT],
    );
    return r.rows[0].id;
  };

  const load = async (id: string) => (await pool.query('SELECT * FROM blog_post WHERE id = $1', [id])).rows[0];

  const press = (id: string) =>
    svc.handleCallback({
      id: `cb-${id}`, data: `blog:note:${id}`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: DRAFT },
    });

  /** Нажать «Замечание» и вернуть id присланного приглашения. */
  const pressForPrompt = async (id: string): Promise<number> => {
    await press(id);
    return tg.sent[tg.sent.length - 1].id;
  };

  const answer = (replyTo: number, text = 'короче и без канцелярита', chat = CHAT) =>
    svc.handleReplyEdit({ chat: { id: chat, type: 'private' }, message_id: 9000, text, reply_to_message: { message_id: replyTo } });

  it('ответ на приглашение принят как замечание', async () => {
    const id = await insertPost();
    const prompt = await pressForPrompt(id);

    expect(await answer(prompt)).toBe(true);

    const row = await load(id);
    expect(row.status).toBe('drafting');
    expect(row.editor_notes).toEqual(['короче и без канцелярита']);
  });

  it('ответ на первое из двух приглашений принят', async () => {
    const id = await insertPost();
    const first = await pressForPrompt(id);
    const second = await pressForPrompt(id);
    expect(second).not.toBe(first);

    expect(await answer(first)).toBe(true);

    expect((await load(id)).editor_notes).toEqual(['короче и без канцелярита']);
  });

  it('ответ на переписываемый черновик не уходит ассистенту', async () => {
    const id = await insertPost('drafting');

    expect(await answer(DRAFT, 'и ещё короче')).toBe(true);

    const row = await load(id);
    expect(row.status).toBe('drafting');
    expect(row.editor_notes).toEqual([]);
    expect(tg.sent[tg.sent.length - 1].text).toMatch(/переписывается/);
  });

  it('ответ на приглашение к уже опубликованному посту не уходит ассистенту', async () => {
    const id = await insertPost();
    const prompt = await pressForPrompt(id);
    await pool.query(`UPDATE blog_post SET status = 'published' WHERE id = $1`, [id]);

    expect(await answer(prompt)).toBe(true);

    const row = await load(id);
    expect(row.status).toBe('published');
    expect(row.editor_notes).toEqual([]);
    expect(tg.sent[tg.sent.length - 1].text).toMatch(/опубликован/);
  });

  it('ответ на чужое сообщение в том же чате уходит ассистенту', async () => {
    const id = await insertPost();
    await pressForPrompt(id);

    expect(await answer(999)).toBe(false);
    expect((await load(id)).editor_notes).toEqual([]);
  });

  /** id сообщений в Telegram свои у каждого чата: тот же номер в чужом чате — чужое сообщение. */
  it('тот же номер сообщения в другом чате — не наш', async () => {
    const id = await insertPost();
    const prompt = await pressForPrompt(id);

    expect(await answer(DRAFT, 'привет', CHAT + 1)).toBe(false);
    expect(await answer(prompt, 'привет', CHAT + 1)).toBe(false);
  });

  /**
   * Двойное касание — два обработчика, прочитавших пост раньше, чем любой из
   * них записал id. Отправки придержаны, пока не дойдут обе: окно открыто
   * явно, а не по воле планировщика.
   */
  it('два нажатия одновременно — узнаются оба приглашения', async () => {
    const id = await insertPost();
    tg.holdSends(2);
    await Promise.all([press(id), press(id)]);
    const [a, b] = tg.sent.map((m) => m.id);

    expect(await answer(a, 'первое')).toBe(true);   // принято
    expect(await answer(b, 'второе')).toBe(true);   // узнано: пост уже переписывается, но ассистенту не ушло
    expect((await load(id)).editor_notes).toEqual(['первое']);
  });

  /**
   * Сверх предела выпадает САМОЕ СТАРОЕ приглашение, свежие узнаются. Ответ на
   * выпавшее уйдёт ассистенту — поэтому предел и взят с большим запасом (см.
   * MAX_NOTE_PROMPTS).
   */
  it('сверх предела выпадает самое старое приглашение, свежие узнаются', async () => {
    const id = await insertPost();
    const prompts: number[] = [];
    for (let i = 0; i < MAX_NOTE_PROMPTS + 1; i++) prompts.push(await pressForPrompt(id));

    expect((await load(id)).note_prompt_ids).toHaveLength(MAX_NOTE_PROMPTS);
    expect(await answer(prompts[0])).toBe(false);
    expect(await answer(prompts[1])).toBe(true);
    expect(await answer(prompts[prompts.length - 1])).toBe(true);
  });

  /**
   * По updated_at админка ловит правку из соседней вкладки (409). Запомнить id
   * приглашения — не правка поста, и ронять из-за него сохранение текста в
   * админке нельзя. Статус тоже прежний: пост по-прежнему ждёт решения.
   */
  it('нажатие не трогает ни статус, ни updated_at', async () => {
    const id = await insertPost();
    const before = await load(id);

    await press(id);

    const after = await load(id);
    expect(after.status).toBe('pending_review');
    expect(new Date(after.updated_at).getTime()).toBe(new Date(before.updated_at).getTime());
  });
});

/** Вернуть переменную окружения как было: `process.env.X = undefined` записал бы строку 'undefined'. */
function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** Настройки блога для блоков ниже: пн/ср/пт в 10:00 МСК. */
const SCHEDULE = { channelChatId: '-100', slotDays: [1, 3, 5], slotHourMsk: 10, imageStyle: '' };

const iso = (v: any): string | null => (v ? new Date(v).toISOString() : null);

/**
 * pg для сервисов: настоящий пул плюс `hold(pattern, n)` — первые n запросов
 * по образцу ждут друг друга и уходят в базу вместе. Окно гонки открывается
 * явно, а не по воле планировщика.
 */
function gatedPg(pool: Pool) {
  let gate: { pattern: RegExp; n: number; parked: Array<() => void> } | null = null;
  return {
    hold(pattern: RegExp, n: number) {
      gate = { pattern, n, parked: [] };
    },
    async query(sql: string, params?: any[]) {
      const g = gate;
      if (g && g.pattern.test(String(sql).replace(/\s+/g, ' ').trim())) {
        await new Promise<void>((resolve) => {
          g.parked.push(resolve);
          if (g.parked.length >= g.n) {
            gate = null;
            g.parked.forEach((go) => go());
          }
        });
      }
      return pool.query(sql, params);
    },
  };
}

/** Код и тело ответа контроллера — ровно то, что уйдёт фронту. */
async function adminCall(controller: BlogController, body: any): Promise<{ status: number; body: any }> {
  const r: any = {};
  r.status = jest.fn().mockReturnValue(r);
  r.json = jest.fn().mockReturnValue(r);
  try {
    await controller.action(body, r);
    return { status: r.status.mock.calls[0][0], body: r.json.mock.calls[0][0] };
  } catch (e: any) {
    if (typeof e?.getStatus !== 'function') throw e;
    return { status: e.getStatus(), body: e.getResponse() };
  }
}

/**
 * Один пост на слот — гарантия в базе, а не только в коде.
 *
 * Две гонки, которые код, прочитав «свободно», не закрывает: владелец жмёт
 * «Опубликовать», пока в админке одобряют другой пост; API поднят в
 * cluster_mode, и два процесса считают свободный слот одновременно. Держит
 * частичный уникальный индекс (004_one_post_per_slot.sql), проигравший
 * получает 23505 и берёт следующий свободный слот. Заглушка Postgres этого не
 * воспроизведёт — только здесь.
 */
maybe('Один пост на слот против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  const settings = { get: async () => ({ ...SCHEDULE }), update: jest.fn() } as any;
  let ours = false;   // гард пропустил базу — только тогда её можно чистить

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 6 });
    await prepareDisposableDb(pool);
    ours = true;
  });

  afterAll(async () => {
    if (ours) await pool.query('TRUNCATE blog_post');
    await pool?.end();
  });

  beforeEach(async () => {
    if (!ours) throw new Error('база не прошла гард — не трогаю');
    await pool.query('TRUNCATE blog_post');
  });

  const insert = async (status: string, over: { title?: string; slotAt?: any; imageUrl?: string } = {}): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key, title, body, status, slot_at, image_url, review_chat_id, review_message_id)
       VALUES ('case', 'manual', 'k', $1, 'Текст', $2, $3, $4, $5, $6)
       RETURNING id`,
      [over.title ?? 'Пост', status, over.slotAt ?? null, over.imageUrl ?? null, CHAT, DRAFT],
    );
    return r.rows[0].id;
  };

  const load = async (id: string) => (await pool.query('SELECT * FROM blog_post WHERE id = $1', [id])).rows[0];

  /** Ближайшие n слотов расписания от «сейчас». */
  const next = (n: number) => upcomingSlots(new Date(), SCHEDULE.slotDays, SCHEDULE.slotHourMsk, n).map((d) => d.toISOString());

  const make = () => {
    const pg = gatedPg(pool);
    const tg = fakeTg();
    const bot = new BlogApprovalService(pg as any, tg as any, settings);
    const admin = new BlogController(pg as any, { addTopic: jest.fn() } as any, settings, { render: jest.fn() } as any);
    const press = (id: string) => bot.handleCallback({
      id: `cb-${id}`, data: `blog:ok:${id}`, from: { id: CHAT }, message: { chat: { id: CHAT }, message_id: DRAFT },
    });
    const popups = () => tg.answerCallbackQuery.mock.calls.map((c: any[]) => String(c[1]?.text ?? ''));
    return { pg, tg, bot, admin, press, popups };
  };

  // --- сам индекс ---

  it.each(['approved', 'publishing'])('второй пост в слот, который держит %s, база не пускает', async (holder) => {
    const [slot] = next(1);
    await insert(holder, { slotAt: slot });

    await expect(insert('approved', { slotAt: slot })).rejects.toMatchObject({ code: '23505', constraint: SLOT_INDEX });
    await expect(insert('publishing', { slotAt: slot })).rejects.toMatchObject({ code: '23505', constraint: SLOT_INDEX });
  });

  it('опубликованные, отклонённые и сорвавшиеся посты слот не держат', async () => {
    const [slot] = next(1);
    for (const status of ['published', 'rejected', 'failed', 'pending_review']) await insert(status, { slotAt: slot });

    await expect(insert('approved', { slotAt: slot })).resolves.toEqual(expect.any(String));
  });

  // --- одобрение ---

  it('два одобрения кнопкой подряд — два разных слота', async () => {
    const { press } = make();
    const p1 = await insert('pending_review');
    const p2 = await insert('pending_review');

    await press(p1);
    await press(p2);

    expect([iso((await load(p1)).slot_at), iso((await load(p2)).slot_at)]).toEqual(next(2));
  });

  /**
   * Кнопка в личке и админка одновременно: оба прочли «ближайший слот
   * свободен» раньше, чем любой записал. Без ретрая на 23505 проигравший
   * упал бы — а пост остался бы на проверке.
   */
  it('кнопка в личке и «approve» в админке одновременно — разные слоты, никто не падает', async () => {
    const { pg, press, admin } = make();
    const p1 = await insert('pending_review');
    const p2 = await insert('pending_review');
    pg.hold(/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY/, 2);

    const [, viaAdmin] = await Promise.all([press(p1), adminCall(admin, { action: 'approve', id: p2 })]);

    expect(viaAdmin.status).toBe(200);
    const rows = [await load(p1), await load(p2)];
    expect(rows.map((r) => r.status)).toEqual(['approved', 'approved']);
    expect(rows.map((r) => iso(r.slot_at)).sort()).toEqual(next(2));
  });

  it('двойное касание «Опубликовать» — одно одобрение, слот не переезжает', async () => {
    const { pg, press, popups } = make();
    const p1 = await insert('pending_review');
    pg.hold(/^SELECT \* FROM blog_post WHERE id/, 2);

    await Promise.all([press(p1), press(p1)]);

    expect(iso((await load(p1)).slot_at)).toBe(next(1)[0]);
    expect(popups().filter((t) => t.startsWith('Одобрено'))).toHaveLength(1);
  });

  it('пока пост уходит в канал, его слот занят', async () => {
    const { admin } = make();
    const [first, second] = next(2);
    await insert('publishing', { slotAt: first, title: 'Уходит в канал' });
    const p = await insert('pending_review');

    const explicit = await adminCall(admin, { action: 'approve', id: p, slotAt: first });
    expect(explicit.status).toBe(409);
    expect(explicit.body).toMatchObject({ error: 'slot_taken' });
    expect(explicit.body.message).toContain('«Уходит в канал»');

    expect((await adminCall(admin, { action: 'approve', id: p })).status).toBe(200);
    expect(iso((await load(p)).slot_at)).toBe(second);
  });

  it('отклонённый пост свой слот освобождает', async () => {
    const { admin } = make();
    const [first] = next(1);
    const old = await insert('approved', { slotAt: first });
    expect((await adminCall(admin, { action: 'reject', id: old })).status).toBe(200);

    const p = await insert('pending_review');
    expect((await adminCall(admin, { action: 'approve', id: p })).status).toBe(200);
    expect(iso((await load(p)).slot_at)).toBe(first);
  });

  // --- перенос ---

  it('перенос на занятый слот — 409 slot_taken; гонка переносов — тоже 409, а не 500', async () => {
    const { pg, admin } = make();
    const [a, b, c] = next(3);
    const first = await insert('approved', { slotAt: a, title: 'Первый' });
    const second = await insert('approved', { slotAt: b, title: 'Второй' });

    const taken = await adminCall(admin, { action: 'reschedule', id: first, slotAt: b });
    expect(taken).toMatchObject({ status: 409, body: { error: 'slot_taken' } });
    expect(taken.body.message).toContain('«Второй»');

    // Оба прочли слот c свободным раньше, чем любой записал: держит индекс.
    pg.hold(/^SELECT id, title, slot_at FROM blog_post WHERE status = ANY\(\$1::text\[\]\) AND slot_at = /, 2);
    const results = await Promise.all([
      adminCall(admin, { action: 'reschedule', id: first, slotAt: c }),
      adminCall(admin, { action: 'reschedule', id: second, slotAt: c }),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(results.find((x) => x.status === 409)!.body).toMatchObject({ error: 'slot_taken' });
    const onC = (await pool.query('SELECT count(*)::int AS n FROM blog_post WHERE slot_at = $1', [c])).rows[0].n;
    expect(onC).toBe(1);
  });

  // --- ретрай публикации: одна строка переходит между двумя статусами индекса ---

  /**
   * После неудачной отправки пост возвращается из `publishing` в `approved`
   * со своим же `slot_at`. Оба статуса в предикате индекса, но это одна и та
   * же строка: UPDATE строки, который не меняет ключ, со своей прежней версией
   * не конфликтует. А чужой пост в этот слот, пока наш в `publishing`, не
   * пустит сам индекс (см. «пока пост уходит в канал») — так что вернуться
   * есть куда.
   */
  it('сорвавшаяся отправка возвращает пост в approved с тем же слотом — индекс не мешает', async () => {
    const pg = gatedPg(pool);
    const past = new Date(Date.now() - 60_000).toISOString();
    // Картинка по не-http ссылке не скачивается — это тот же путь «подход к
    // каналу сорвался», что и таймаут Telegram, только без сети.
    const id = await insert('approved', { slotAt: past, imageUrl: 'minio-offline' });
    await insert('approved', { slotAt: next(1)[0] });
    const publisher = new BlogPublisherService(pg as any, fakeTg() as any, settings);

    const result = await publisher.publish(rowToPost(await load(id)));

    expect(result.ok).toBe(false);
    const row = await load(id);
    expect(row.status).toBe('approved');
    expect(iso(row.slot_at)).toBe(iso(past));
    expect(row.attempts).toBe(1);
    expect(row.last_error).toMatch(/картинка не скачалась/);
  });

  it('сторож зависших возвращает publishing в approved с тем же слотом', async () => {
    const OLD = process.env.BLOG_ENABLED;
    process.env.BLOG_ENABLED = 'true';
    try {
      const pg = gatedPg(pool);
      const past = new Date(Date.now() - 60 * 60_000).toISOString();
      const id = await insert('publishing', { slotAt: past });
      await pool.query(`UPDATE blog_post SET updated_at = now() - interval '1 hour' WHERE id = $1`, [id]);
      const cron = new BlogCron(
        pg as any, {} as any, {} as any, {} as any, {} as any, {} as any, settings, {} as any,
      );

      await cron.rearmStuck();

      const row = await load(id);
      expect(row.status).toBe('approved');
      expect(iso(row.slot_at)).toBe(iso(past));
    } finally {
      restoreEnv('BLOG_ENABLED', OLD);
    }
  });
});

/**
 * Что держит очередь черновиков — на настоящем SQL: охрана `prepareDrafts`,
 * выборка `takeNextIdea` и захват исполняются базой, а не заглушкой.
 */
maybe('Очередь черновиков против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  const OLD = { enabled: process.env.BLOG_ENABLED, approver: process.env.BLOG_APPROVER_TG_ID };
  let ours = false;   // гард пропустил базу — только тогда её можно чистить

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });
    await prepareDisposableDb(pool);
    ours = true;
    process.env.BLOG_ENABLED = 'true';
    process.env.BLOG_APPROVER_TG_ID = String(CHAT);
  });

  afterAll(async () => {
    restoreEnv('BLOG_ENABLED', OLD.enabled);
    restoreEnv('BLOG_APPROVER_TG_ID', OLD.approver);
    if (ours) await pool.query('TRUNCATE blog_post');
    await pool?.end();
  });

  beforeEach(async () => {
    if (!ours) throw new Error('база не прошла гард — не трогаю');
    await pool.query('TRUNCATE blog_post');
  });

  /** @param startedMinutesAgo отметка захвата: null — пустая. */
  const insert = async (status: string, rubric = 'case', startedMinutesAgo: number | null = null): Promise<string> => {
    const r = await pool.query(
      `INSERT INTO blog_post (rubric, source, topic_key, status, drafting_started_at)
       VALUES ($1, 'manual', 'k', $2,
               CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(mins => $3::int) END)
       RETURNING id`,
      [rubric, status, startedMinutesAgo],
    );
    return r.rows[0].id;
  };

  /** Один тик prepareDrafts. @returns id постов, отданных редактору. */
  const tick = async (): Promise<string[]> => {
    const pg = { query: (sql: string, params?: any[]) => pool.query(sql, params) };
    const editor = { draft: jest.fn(async () => ({ title: 'З', body: 'Т', imagePrompt: 'сцена' })) };
    const cron = new BlogCron(
      pg as any,
      new BlogTopicService(pg as any),
      editor as any,
      { render: jest.fn(async () => 'https://minio/i.png') } as any,
      { publish: jest.fn() } as any,
      { sendForReview: jest.fn(), notify: jest.fn() } as any,
      { get: async () => ({ ...SCHEDULE }) } as any,
      { weeklyTopics: jest.fn() } as any,
    );
    await cron.prepareDrafts();
    return editor.draft.mock.calls.map((c: any[]) => c[0].id);
  };

  it('одобренный пост не держит очередь: срочная новость идёт в работу', async () => {
    await insert('approved');
    const news = await insert('idea', 'news');
    expect(await tick()).toEqual([news]);
  });

  it('пост на проверке держит очередь', async () => {
    await insert('pending_review');
    await insert('idea', 'news');
    expect(await tick()).toEqual([]);
  });

  it('черновик, который пишется прямо сейчас, держит очередь', async () => {
    await insert('drafting', 'case', 1);
    await insert('idea', 'news');
    expect(await tick()).toEqual([]);
  });

  it('запрошенная переработка (пустая отметка) не блокирует сама себя', async () => {
    const redo = await insert('drafting', 'case', null);
    expect(await tick()).toEqual([redo]);
  });

  it('брошенный черновик (отметка старше порога) не держит очередь — его берут заново', async () => {
    const abandoned = await insert('drafting', 'case', STALE_DRAFTING_MINUTES + 1);
    expect(await tick()).toEqual([abandoned]);
  });
});

/**
 * Темы кейсов — на настоящем SQL: кто попадает в топ ассистентов недели.
 *
 * Всё, что решает выборка, решает запрос: чьи реплики считаются (тестовые
 * аккаунты отсекаются по префиксу session_id, и в этом участвует регулярка),
 * кто вообще кандидат (профиль в agents.description, is_active). Заглушка в
 * blog-topic.service.spec.ts видит только текст запроса.
 *
 * Таблицы `agents` и `custom_chat_history` — ВРЕМЕННЫЕ, на отдельном
 * соединении: временная схема ищется первой, так что запрос сервиса видит
 * именно их, а постоянные таблицы (если BLOG_PG_URL вдруг смотрит не туда) не
 * тронуты ни записью, ни TRUNCATE. Гард на чужую базу всё равно зовётся —
 * тем же порядком, что у соседних блоков.
 */
maybe('Темы кейсов против живого Postgres', () => {
  jest.setTimeout(60_000);

  let pool: Pool;
  let db: Client;
  let ours = false;   // гард пропустил базу — только тогда её можно трогать

  const KIRA = { id: 22, name: 'Кира', description: 'Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации' };
  const OLYA = { id: 2, name: 'Оля', description: 'Психолог и фасилитатор самоисследования — состояния, отношения, выгорание' };
  const LAWYER = { id: 10, name: 'Алексей', description: 'Юрист — право, договоры, оферта, согласия, риски и требования регуляторов' };
  const MISHA = { id: 1, name: 'Миша', description: 'Коуч по стандартам ICF — цели, решения, работа с собственными ограничениями' };
  const ROMAN = { id: 12, name: 'Роман', description: null as string | null };   // профиля нет
  const LIANA = { id: 13, name: 'Лиана', description: '   ' };                    // пробелы — тоже не профиль
  const ANNA = { id: 9, name: 'Анна', description: 'Бухгалтер' };                  // ярлык, а не профиль
  const YULIA = {                                                                 // снята с продукта 06.09.2026
    id: 15, name: 'Юлия', description: 'SMM-продюсер — сценарии коротких роликов, контент для соцсетей', active: false,
  };

  const REAL_PHONE = '79161234567';
  const REAL_PHONE_2 = '79261112233';
  const REAL_PHONE_3 = '79035550011';                            // 790355…, не маска 790300xxxxx
  const REAL_UUID = '3f2b8c1e-9d4a-4e6b-8f0c-2a7d5e1b9c34';      // вход по почте/OAuth: userId = UUID

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 1 });
    await prepareDisposableDb(pool);
    ours = true;

    db = new Client({ connectionString: PG });
    await db.connect();
    await db.query(`
      CREATE TEMP TABLE agents (
        id integer NOT NULL, name text, system_prompt text, description text,
        category varchar DEFAULT 'business', display_name text,
        is_active boolean NOT NULL DEFAULT true
      )`);
    await db.query(`
      CREATE TEMP TABLE custom_chat_history (
        id serial, session_id text NOT NULL, sender_type varchar(10) NOT NULL,
        agent integer, content text NOT NULL,
        created_at timestamptz DEFAULT CURRENT_TIMESTAMP,
        message_type varchar(20) NOT NULL DEFAULT 'text', tokens_used integer DEFAULT 0
      )`);
  });

  afterAll(async () => {
    await db?.end();     // временные таблицы уходят вместе с соединением
    await pool?.end();
  });

  beforeEach(async () => {
    if (!ours) throw new Error('база не прошла гард — не трогаю');
    await db.query('TRUNCATE pg_temp.agents, pg_temp.custom_chat_history');
    for (const a of [KIRA, OLYA, LAWYER, MISHA, ROMAN, LIANA, ANNA, YULIA]) {
      await db.query(
        `INSERT INTO pg_temp.agents (id, name, display_name, description, is_active) VALUES ($1, $2, $2, $3, $4)`,
        [a.id, a.name, a.description, (a as any).active ?? true],
      );
    }
  });

  /** `n` реплик в сессию `session`; `daysAgo` — насколько давно. */
  const say = async (session: string, agent: number, n: number, sender = 'human', daysAgo = 1) => {
    await db.query(
      `INSERT INTO pg_temp.custom_chat_history (session_id, sender_type, agent, content, created_at)
       SELECT $1, $2, $3, 'реплика', now() - make_interval(days => $4) FROM generate_series(1, $5)`,
      [session, sender, agent, daysAgo, n],
    );
  };

  const top = (limit = 5) =>
    new BlogTopicService({ query: (sql: string, params?: any[]) => db.query(sql, params) } as any).topAssistants(limit);

  it('считаются живые реплики людей за неделю; тестовые аккаунты, ответы ассистента и старое — нет', async () => {
    // Кира: живые люди — по телефону, по почте (UUID) и в «чистом листе».
    await say(`${REAL_PHONE}_22`, 22, 3);
    await say(`${REAL_UUID}_22`, 22, 2);
    await say(`${REAL_PHONE}_22_fresh_1758000000000`, 22, 1);
    await say(`${REAL_PHONE}_22`, 22, 100, 'human', 8);      // за окном недели
    // Оля: четыре реплики человека и ответы ассистента, которые не в счёт.
    await say(`${REAL_PHONE_2}_2`, 2, 4);
    await say(`${REAL_PHONE_2}_2`, 2, 10, 'ai');
    // Юрист: одна живая реплика и гора тестовых — со всех тестовых аккаунтов.
    await say(`${REAL_PHONE_3}_10`, 10, 1);
    await say('70000000000_10', 10, 50);
    await say('79030169187_10', 10, 30);
    await say('79169403771_10', 10, 15);
    await say('79656445804_10', 10, 20);
    await say('79656445804_10_fresh_1758000000000', 10, 5);
    await say('79030012345_10', 10, 10);                     // маска нагрузочных 790300xxxxx
    // Миша: только тестовые — живого спроса нет вовсе.
    await say('70000000000_1', 1, 40);

    expect(await top()).toEqual([
      { agentId: '22', agentName: 'Кира', description: KIRA.description, turns: 6 },
      { agentId: '2', agentName: 'Оля', description: OLYA.description, turns: 4 },
      { agentId: '10', agentName: 'Алексей', description: LAWYER.description, turns: 1 },
    ]);
  });

  it('ассистент без внятного профиля не кандидат, сколько бы к нему ни писали', async () => {
    await say(`${REAL_PHONE}_12`, 12, 500);     // Роман: описания нет
    await say(`${REAL_PHONE}_13`, 13, 300);     // Лиана: одни пробелы
    await say(`${REAL_PHONE}_9`, 9, 200);       // Анна: ярлык «Бухгалтер»
    await say(`${REAL_PHONE_2}_22`, 22, 2);

    expect((await top()).map((a) => a.agentName)).toEqual(['Кира']);
  });

  it('снятый с продукта ассистент не кандидат: история у него живая, а читатель его не найдёт', async () => {
    await say(`${REAL_PHONE}_15`, 15, 200);     // Юлия: is_active = false
    await say(`${REAL_PHONE_2}_2`, 2, 3);

    expect((await top()).map((a) => a.agentName)).toEqual(['Оля']);
  });

  it('limit режет уже отфильтрованный список, порядок — по живым репликам', async () => {
    await say(`${REAL_PHONE}_12`, 12, 500);     // без профиля — не занимает места в топе
    await say(`${REAL_PHONE}_22`, 22, 5);
    await say(`${REAL_PHONE}_2`, 2, 4);
    await say(`${REAL_PHONE}_10`, 10, 3);

    expect((await top(2)).map((a) => a.agentName)).toEqual(['Кира', 'Оля']);
  });
});
