import {
  BlogTopicService, normalizeTopicKey, DEDUP_WINDOW_DAYS, STALE_DRAFTING_MINUTES,
  MIN_PROFILE_CHARS, hasClearProfile,
} from './blog-topic.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
import { AdminService } from '../admin/admin.service';

const pgMock = () => ({ query: jest.fn() });

describe('normalizeTopicKey', () => {
  it('схлопывает регистр и пробелы', () => {
    expect(normalizeTopicKey('  Аренда   Квартиры ')).toBe('аренда-квартиры');
  });

  it('разная пунктуация даёт один ключ', () => {
    expect(normalizeTopicKey('Аренда: квартиры!')).toBe(normalizeTopicKey('аренда квартиры'));
  });
});

describe('BlogTopicService.addTopic', () => {
  it('новая тема вставляется', async () => {
    const pg = pgMock();
    pg.query
      .mockResolvedValueOnce({ rows: [] })                    // проверка дубля
      .mockResolvedValueOnce({ rows: [{ id: 'new-id', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда', topicHint: 'про аренду' });
    expect(post).not.toBeNull();
    expect(pg.query.mock.calls[1][0]).toContain('INSERT INTO blog_post');
  });

  it('кейс с тем же ключом в окне дедупликации не вставляется', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'old' }] });
    const svc = new BlogTopicService(pg as any);
    const post = await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(post).toBeNull();
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('окно дедупликации — 90 дней', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][1]).toContain(DEDUP_WINDOW_DAYS);
  });

  it('отклонённая тема не блокирует повтор: дубль ищется только среди живых и опубликованных', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'аренда' });
    expect(pg.query.mock.calls[0][0]).toContain("status <> 'rejected'");
  });
});

describe('BlogTopicService.addTopic с onceBySourceRef', () => {
  const newsTopic = (over: any = {}) => ({
    rubric: 'news' as const, source: 'git' as const, topicKey: 'meeting-bot-2026-w38',
    sourceRef: 'git:2026-W38:meeting-bot', onceBySourceRef: true, ...over,
  });

  it('тема с уже виденным sourceRef не заводится второй раз', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [{ id: 'old' }] });
    const svc = new BlogTopicService(pg as any);
    expect(await svc.addTopic(newsTopic())).toBeNull();
    expect(pg.query).toHaveBeenCalledTimes(1);
  });

  it('проверка по sourceRef идёт без оглядки на статус: отклонённый анонс недели не воскресает', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'news', source: 'git', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic(newsTopic());

    const [sql, params] = pg.query.mock.calls[0];
    expect(String(sql)).toContain('source_ref = $1');
    expect(String(sql)).not.toContain('rejected');
    expect(params).toContain('git:2026-W38:meeting-bot');
  });

  it('без флага sourceRef не проверяется — кейсы по одному ассистенту повторяются по-прежнему', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'case', source: 'stats', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'case', source: 'stats', topicKey: 'кейс', sourceRef: 'stats:12' });

    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(String(pg.query.mock.calls[0][0])).not.toContain('source_ref');
  });

  it('флаг без sourceRef ничего не ломает: остаётся обычная дедупликация по ключу', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ id: 'x', rubric: 'news', source: 'git', topic_key: 'k', status: 'idea', attempts: 0 }] });
    const svc = new BlogTopicService(pg as any);
    await svc.addTopic({ rubric: 'news', source: 'git', topicKey: 'к', onceBySourceRef: true });

    expect(pg.query).toHaveBeenCalledTimes(2);
    expect(String(pg.query.mock.calls[0][0])).toContain('topic_key = $1');
  });
});

describe('BlogTopicService.takeNextIdea', () => {
  const draftingRow = (over: any = {}) => ({
    id: 'p1', rubric: 'case', source: 'stats', topic_key: 'k', status: 'drafting', attempts: 0, ...over,
  });

  it('зависший drafting возвращается в работу — иначе «переписать» не наступает никогда', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [draftingRow()] });
    const svc = new BlogTopicService(pg as any);

    const post = await svc.takeNextIdea();

    // Главное здесь — что drafting вообще допустим как результат: пост,
    // который владелец отправил на перезапись, обязан вернуться в работу.
    expect(post?.id).toBe('p1');
    expect(post?.status).toBe('drafting');
  });

  it('порог свежести передаётся параметром, а не зашит в текст запроса', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);

    await svc.takeNextIdea();

    // Константа импортирована, а не продублирована числом: если порог зашьют
    // литералом в SQL, параметров не будет и тест покраснеет.
    expect(pg.query.mock.calls[0][1]).toContain(STALE_DRAFTING_MINUTES);
  });

  it('берёт зависший drafting, а не только idea', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toContain('drafting');
  });

  it('свежий drafting не подхватывается — он прямо сейчас в работе', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = pg.query.mock.calls[0][0] as string;
    expect(sql).toMatch(/drafting_started_at|interval/);
  });

  /**
   * Раньше «черновик уже в работе» опознавалось косвенной уликой — заполненным
   * заголовком. Улика врала ровно там, где это дороже всего: у переработки
   * заголовок остаётся от прошлой генерации, так что пост считался готовым к
   * работе всё время, пока его и писали. Теперь есть прямая отметка о начале
   * работы, и порог применяется к ней — по своему прямому смыслу «взяли и
   * бросили».
   */
  it('готовность к работе определяется отметкой о начале, а не заполненным заголовком', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);

    await svc.takeNextIdea();

    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toContain('drafting_started_at IS NULL');
    expect(sql).not.toContain('title IS NOT NULL');
  });

  it('порог применяется к отметке о начале работы', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);

    await svc.takeNextIdea();

    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/drafting_started_at < now\(\)/);
  });

  it('порог не распространяется на idea: свежая идея берётся сразу', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // Не `toContain("status = 'idea' OR")`: такая проверка зеленеет на
    // «status = 'idea' ORDER BY» — на запросе вообще без drafting.
    expect(sql).toMatch(/status = 'idea'\s+OR \(status = 'drafting'/);
  });

  it('новость по-прежнему вытесняет кейс', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    expect(String(pg.query.mock.calls[0][0])).toContain("(rubric = 'news') DESC");
  });

  it('запрошенная перезапись берётся сразу: отправивший её погасил отметку', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    // Условие на отметку намеренно лежит ВНУТРИ ветки status = 'drafting', а
    // не отдельным условием верхнего уровня. Наверху `drafting_started_at IS
    // NULL` было бы истиной для всего, что до черновика не доходило, —
    // включая отклонённые посты, и крон воскрешал бы отправленное в мусор.
    expect(sql).toMatch(/status = 'drafting' AND \(drafting_started_at IS NULL OR drafting_started_at/);
  });

  it('брошенный после захвата черновик по-прежнему ждёт порог', async () => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows: [] });
    const svc = new BlogTopicService(pg as any);
    await svc.takeNextIdea();
    const sql = String(pg.query.mock.calls[0][0]).replace(/\s+/g, ' ');
    expect(sql).toMatch(/drafting_started_at < now\(\) - \(\$1 \|\| ' minutes'\)::interval\)\)/);
  });
});

/**
 * Темы кейсов из статистики.
 *
 * На проде подсказка редактору была «чаще всего обращались к ассистенту
 * «Кира» (44 обращений), придумай кейс по его профилю» — а профиля в ней не
 * было. Редактор выдумал Кире профиль (планирование и тревога вместо
 * дизайна), пересказал в посте внутреннюю статистику, а на Романе и Лиане не
 * собрал пост вовсе. Сама статистика при этом была перекошена тестами: Роман
 * с тысячей обращений — это прогоны владельца и мониторинга.
 *
 * SQL здесь не исполняется (pg подменён) — проверяется, ЧТО уходит в запрос.
 * Исполняется он в blog-approval.integration.spec.ts, блок «Темы кейсов».
 */
describe('BlogTopicService.topAssistants', () => {
  const KIRA_ROW = {
    agent_id: '22',
    agent_name: 'Кира',
    description: 'Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации',
    turns: 44,
  };

  const run = async (rows: any[] = [KIRA_ROW]) => {
    const pg = pgMock();
    pg.query.mockResolvedValueOnce({ rows });
    const out = await new BlogTopicService(pg as any).topAssistants(3);
    const [sql, params] = pg.query.mock.calls[0];
    return { out, sql: String(sql).replace(/\s+/g, ' '), params: params as any[] };
  };

  it('отдаёт вместе с именем описание ассистента — профиль, по которому пишется кейс', async () => {
    const { out } = await run();
    expect(out[0]).toEqual(expect.objectContaining({
      agentId: '22',
      agentName: 'Кира',
      description: 'Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации',
    }));
  });

  it('профиль — это agents.description, и без внятного описания ассистент в выборку не попадает', async () => {
    const { sql, params } = await run();
    expect(sql).toMatch(/char_length\(btrim\(coalesce\(a\.description, ''\)[^)]*\)\) >= \$\d/);
    expect(params).toContain(MIN_PROFILE_CHARS);
  });

  it('снятый с продукта ассистент (is_active = false) в выборку не попадает', async () => {
    const { sql } = await run();
    expect(sql).toMatch(/AND a\.is_active\b/);
  });

  /**
   * Пользователь в `custom_chat_history` — префикс `session_id` до первого
   * подчёркивания: `{userId}_{assistantId}` или `{userId}_{assistantId}_fresh_{ts}`.
   * Так же его достаёт админка (сегменты возврата) и остальная аналитика.
   */
  it('реплики тестовых аккаунтов не считаются: пользователь — префикс session_id', async () => {
    const { sql, params } = await run();
    expect(sql).toMatch(/split_part\(h\.session_id, '_', 1\) <> ALL\(\$\d+::text\[\]\)/);
    expect(sql).toMatch(/split_part\(h\.session_id, '_', 1\) !~ \$\d+/);
    // Тот же объект списка, а не копия с теми же номерами: копия разъедется
    // с оригиналом молча, при первой же правке одного из них.
    expect(params).toContain(TEST_USERS);
    expect(params).toContain(TEST_USER_PATTERN);
  });

  it('тестовые аккаунты — ровно те, что прячет админка: у неё тот же список, а не копия', () => {
    expect((AdminService as any).TEST_USERS).toBe(TEST_USERS);
    expect((AdminService as any).TEST_PATTERN).toBe(TEST_USER_PATTERN);
  });
});

describe('hasClearProfile', () => {
  it('описание, по которому видно, кто это и что умеет, — профиль', () => {
    expect(hasClearProfile('Дизайнер — логотипы, фирменный стиль, макеты, баннеры и презентации')).toBe(true);
  });

  it('пустое, пробельное и отсутствующее описание — не профиль', () => {
    expect(hasClearProfile(null)).toBe(false);
    expect(hasClearProfile(undefined)).toBe(false);
    expect(hasClearProfile('')).toBe(false);
    expect(hasClearProfile(' \n\t ')).toBe(false);
  });

  it('ярлык из одного слова — не профиль: что ассистент умеет, из него не видно', () => {
    expect(hasClearProfile('Юрист')).toBe(false);
    expect(hasClearProfile('  Психолог  ')).toBe(false);
  });
});
