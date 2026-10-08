import { ChatFilesService, USER_FILES_SQL } from './chat-files.service';
import { parseFindFilesInput } from './find-files';

const MINIO = 'https://my.linkeon.io/smm-media';
const RELAY = 'https://r.linkeon.io/files/u1_12_ru';
const CUSTOM = '0f8e6a1c-1111-4222-8333-444455556666';

/** Строки истории от новых к старым — как их отдаёт USER_FILES_SQL. */
const ROWS = [
  { id: 5, session_id: 'u1_12', content: `Готово, [Скачать dogovor.docx](${MINIO}/linkeon-chat-files/a/dogovor.docx) — договор аренды квартиры`, created_at: '2026-10-05T10:00:00Z' },
  { id: 4, session_id: `u1_custom:${CUSTOM}`, content: `![](${MINIO}/linkeon-assets/images/logo.png) логотип для кофейни`, created_at: '2026-10-03T10:00:00Z' },
  { id: 3, session_id: 'u1_7_fresh_1728000000000', content: `[Скачать Отчёт.pdf](${MINIO}/linkeon-chat-files/b/Отчёт.pdf) отчёт за квартал`, created_at: '2026-09-25T10:00:00Z' },
  { id: 2, session_id: 'u1_12', content: `[Скачать Договор поставки.docx](${RELAY}/Договор поставки.docx)`, created_at: '2026-09-10T10:00:00Z' },
];

function makePg() {
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === USER_FILES_SQL) return { rows: ROWS };
    if (/FROM agents a/.test(sql)) {
      return {
        rows: [
          { id: 12, display: 'Ирина', name: 'irina', aliases: ['Irina'] },
          { id: 7, display: 'Роман', name: 'roman', aliases: ['Roman'] },
        ].filter((r) => params[0].includes(r.id)),
      };
    }
    if (/FROM custom_agents/.test(sql)) {
      return { rows: params[1] === 'u1' && params[0].includes(CUSTOM) ? [{ id: CUSTOM, name: 'Мой бариста' }] : [] };
    }
    return { rows: [] };
  });
  return { query, calls };
}

beforeEach(() => {
  process.env.MINIO_PUBLIC_URL = MINIO;
  delete process.env.AGENT_URL;
});

const search = async (raw: any) => {
  const pg = makePg();
  const r = await new ChatFilesService(pg as any).searchForUser('u1', parseFindFilesInput(raw));
  return { r, pg };
};

describe('ChatFilesService.searchForUser', () => {
  it('читает все переписки пользователя: LIKE с экранированным «_» и фильтр дней параметром', async () => {
    const { pg } = await search({ days: 30 });
    expect(pg.calls[0].sql).toBe(USER_FILES_SQL);
    expect(pg.calls[0].params).toEqual(['u1', 30]);
    expect(USER_FILES_SQL).toContain(`session_id LIKE $1 || '\\_%' ESCAPE '\\'`);
    expect(USER_FILES_SQL).toMatch(/sender_type = 'ai'/);
    expect(USER_FILES_SQL).toMatch(/\$2::int IS NULL OR created_at >= now\(\) - make_interval\(days => \$2::int\)/);
  });

  it('без слов — последние файлы с ассистентом, датой и подписью', async () => {
    const { r } = await search({});
    expect(r.ok).toBe(true);
    expect(r.total).toBe(4);
    expect(r.files[0]).toEqual({
      name: 'dogovor.docx', kind: 'document', date: '2026-10-05', assistant: 'Ирина',
      url: `${MINIO}/linkeon-chat-files/a/dogovor.docx`, stored: true,
      note: 'Готово, Скачать dogovor.docx — договор аренды квартиры',
    });
    expect(r.files.map((f) => f.assistant)).toEqual(['Ирина', 'Мой бариста', 'Роман', 'Ирина']);
  });

  it('слово ищется и в тексте ответа: «договор» находит dogovor.docx по описанию', async () => {
    const { r } = await search({ query: 'договор' });
    expect(r.files.map((f) => f.name)).toEqual(['Договор поставки.docx', 'dogovor.docx']);
  });

  it('у не сохранившегося файла нет адреса', async () => {
    const { r } = await search({ query: 'поставки' });
    expect(r.files[0]).toMatchObject({ name: 'Договор поставки.docx', stored: false });
    expect(r.files[0].url).toBeUndefined();
  });

  it('фильтр по виду и по ассистенту (любое его имя, без учёта регистра)', async () => {
    expect((await search({ kind: 'image' })).r.files.map((f) => f.name)).toEqual(['logo.png']);
    expect((await search({ assistant: 'roman' })).r.files.map((f) => f.name)).toEqual(['Отчёт.pdf']);
    expect((await search({ assistant: 'бариста' })).r.files.map((f) => f.name)).toEqual(['logo.png']);
  });

  it('кастомные ассистенты — только свои', async () => {
    const { pg } = await search({});
    const q = pg.calls.find((c) => /FROM custom_agents/.test(c.sql))!;
    expect(q.sql).toMatch(/owner_user_id = \$2/);
    expect(q.params).toEqual([[CUSTOM], 'u1']);
  });

  it('ничего не нашлось — пустой список, total 0', async () => {
    const { r } = await search({ query: 'квантовый' });
    expect(r).toEqual({ ok: true, total: 0, files: [] });
  });

  it('limit режет выдачу, total — сколько нашлось всего', async () => {
    const { r } = await search({ limit: 2 });
    expect(r.total).toBe(4);
    expect(r.files).toHaveLength(2);
  });
});
