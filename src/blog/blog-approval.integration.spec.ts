import * as fs from 'fs';
import * as path from 'path';
import { Pool } from 'pg';
import { BlogApprovalService } from './blog-approval.service';
import { MAX_NOTE_PROMPTS } from './blog.types';

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
 */

const PG = process.env.BLOG_PG_URL;
const maybe = PG ? describe : describe.skip;

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

  beforeAll(async () => {
    pool = new Pool({ connectionString: PG, max: 4 });

    // ГАРД НА ЧУЖУЮ БАЗУ — до миграций. База приложения узнаётся по его
    // главной таблице, даже если постов в ней ещё нет.
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
  });

  afterAll(async () => {
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
