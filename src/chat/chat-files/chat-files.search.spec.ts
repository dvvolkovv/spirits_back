import { ChatFilesService, USER_FILES_SQL, USER_LINKS_SQL } from './chat-files.service';
import { ChatUploadsService } from '../chat-uploads/chat-uploads.service';
import { parseFindFilesInput } from './find-files';

const MINIO = 'https://my.linkeon.io/smm-media';
const RELAY = 'https://r.linkeon.io/files/u1_12_ru';
const CUSTOM = '0f8e6a1c-1111-4222-8333-444455556666';
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';

/** Строки истории от новых к старым — как их отдаёт USER_FILES_SQL. */
const ROWS = [
  { id: 5, session_id: 'u1_12', content: `Готово, [Скачать dogovor.docx](${MINIO}/linkeon-chat-files/a/dogovor.docx) — договор аренды квартиры`, created_at: '2026-10-05T10:00:00Z' },
  { id: 4, session_id: `u1_custom:${CUSTOM}`, content: `![](${MINIO}/linkeon-assets/images/logo.png) логотип для кофейни`, created_at: '2026-10-03T10:00:00Z' },
  { id: 3, session_id: 'u1_7_fresh_1728000000000', content: `[Скачать Отчёт.pdf](${MINIO}/linkeon-chat-files/b/Отчёт.pdf) отчёт за квартал`, created_at: '2026-09-25T10:00:00Z' },
  { id: 2, session_id: 'u1_12', content: `[Скачать Договор поставки.docx](${RELAY}/Договор поставки.docx)`, created_at: '2026-09-10T10:00:00Z' },
];

/** Исходная загрузка пользователя — строка chat_uploads, как её отдаёт searchOriginals. */
const UPLOAD_ROWS = [
  {
    id: UPLOAD_ID, user_id: 'u1', session_id: 'u1_7', original_name: 'отчёт.pdf',
    mime: 'application/pdf', size_bytes: 12, sha256: 'aa', storage_key: `${UPLOAD_ID}/otchet.pdf`,
    created_at: '2026-10-06T10:00:00Z',
  },
];

/** Человеческое сообщение с внешней ссылкой — строка USER_LINKS_SQL. */
const LINK_ROWS = [
  { id: 9, session_id: 'u1_12', content: 'Глянь [отчёт](https://example.com/a.pdf) — там цифры', created_at: '2026-10-07T10:00:00Z' },
];

function makePg(opts: { uploads?: any[]; links?: any[] } = {}) {
  const uploads = opts.uploads ?? [];
  const links = opts.links ?? [];
  const calls: { sql: string; params: any[] }[] = [];
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql === USER_FILES_SQL) return { rows: ROWS };
    if (sql === USER_LINKS_SQL) return { rows: links };
    if (/FROM chat_uploads/.test(sql)) return { rows: params[0] === 'u1' ? uploads : [] };
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

// assistantUrl подписывается JWT_SECRET и строится от BACKEND_URL — сохраняем
// и возвращаем окружение, чтобы тесты не протекали в соседние файлы воркера.
const ENV_KEYS = ['JWT_SECRET', 'BACKEND_URL', 'MINIO_PUBLIC_URL'];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key] as string;
  }
});

beforeEach(() => {
  process.env.MINIO_PUBLIC_URL = MINIO;
  delete process.env.AGENT_URL;
  delete process.env.BACKEND_URL;
  process.env.JWT_SECRET = 'spec-secret';
});

// Шпионы (fetch и прочие) снимаем здесь, а не в тесте: при упавшем assert
// они не должны утекать в следующие тесты файла.
afterEach(() => {
  jest.restoreAllMocks();
});

const search = async (raw: any, data: { uploads?: any[]; links?: any[] } = {}) => {
  const pg = makePg(data);
  // Настоящий ChatUploadsService: searchOriginals ходит в тот же pg-мок,
  // ownerUrl/assistantUrl — чистые строители (storage в них не участвует).
  const uploads = new ChatUploadsService(pg as any, {} as any);
  const r = await new ChatFilesService(pg as any, uploads).searchForUser('u1', parseFindFilesInput(raw));
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
      name: 'dogovor.docx', kind: 'document', origin: 'assistant', date: '2026-10-05', assistant: 'Ирина',
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

describe('searchForUser: исходные загрузки пользователя', () => {
  it('возвращает исходную загрузку с owner и assistant URL', async () => {
    const { r } = await search({ query: 'отчёт' }, { uploads: UPLOAD_ROWS });
    const upload = r.files.find((f) => f.origin === 'upload')!;
    expect(upload).toMatchObject({ origin: 'upload', stored: true, kind: 'document', name: 'отчёт.pdf', assistant: 'Роман' });
    expect(upload.url).toBe('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111');
    expect(upload.assistantUrl).toContain('/webhook/chat-uploads/11111111-1111-4111-8111-111111111111?exp=');
    expect(upload.assistantUrl).toContain('sig=');
  });

  it('days уходит параметром и в поиск исходников', async () => {
    const { pg } = await search({ days: 30 }, { uploads: UPLOAD_ROWS });
    expect(pg.calls.find((c) => /FROM chat_uploads/.test(c.sql))!.params).toEqual(['u1', 30]);
  });

  it('имя исходника санитизируется: управляющие, невидимые символы и перевод строки не проходят', async () => {
    const evil = {
      ...UPLOAD_ROWS[0],
      id: '22222222-2222-4222-8222-222222222222',
      // «](» — разводка markdown-ссылки, RLO U+202E (переворачивает хвост имени), \n — разрыв строки
      original_name: `a](b${String.fromCharCode(0x202e)}c\nd.png`,
      created_at: '2026-10-09T10:00:00Z',
    };
    const { r } = await search({}, { uploads: [evil] });
    const upload = r.files.find((f) => f.origin === 'upload')!;
    expect(upload.name).toBe('a](bcd.png');
  });
});

describe('searchForUser: внешние ссылки из человеческих сообщений', () => {
  it('возвращает внешнюю ссылку как адрес без скачивания', async () => {
    const fetchMock = jest.spyOn(global, 'fetch');
    const { r } = await search({ query: 'example.com' }, { links: LINK_ROWS });
    expect(r.files[0]).toMatchObject({ kind: 'link', origin: 'link', url: 'https://example.com/a.pdf', stored: true });
    expect(r.files[0].note).toBe('Глянь отчёт — там цифры');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('USER_LINKS_SQL — та же область сессий, человеческие сообщения, фильтр дней', () => {
    expect(USER_LINKS_SQL).toContain(`session_id LIKE $1 || '\\_%' ESCAPE '\\'`);
    expect(USER_LINKS_SQL).toMatch(/sender_type = 'human'/);
    expect(USER_LINKS_SQL).toMatch(/content ~ 'https\?:\/\//);
    expect(USER_LINKS_SQL).toMatch(/\$2::int IS NULL OR created_at >= now\(\) - make_interval\(days => \$2::int\)/);
  });

  it('внутренние адреса /webhook/chat-uploads/ не дублируются внешней ссылкой', async () => {
    const { r } = await search({}, {
      links: [{ id: 8, session_id: 'u1_12', content: `мой файл https://my.linkeon.io/webhook/chat-uploads/${UPLOAD_ID} лежит`, created_at: '2026-10-08T10:00:00Z' }],
    });
    expect(r.files.filter((f) => f.origin === 'link')).toEqual([]);
  });

  it('kind=link оставляет только внешние ссылки', async () => {
    const { r } = await search({ kind: 'link' }, { uploads: UPLOAD_ROWS, links: LINK_ROWS });
    expect(r.files.map((f) => [f.origin, f.url])).toEqual([['link', 'https://example.com/a.pdf']]);
  });

  it('один адрес в разных сообщениях — одна запись, самая свежая', async () => {
    const { r } = await search({}, {
      links: [
        { id: 10, session_id: 'u1_12', content: 'свежая https://example.com/a.pdf', created_at: '2026-10-07T10:00:00Z' },
        { id: 6, session_id: 'u1_12', content: 'старая https://example.com/a.pdf', created_at: '2026-10-01T10:00:00Z' },
      ],
    });
    const links = r.files.filter((f) => f.origin === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ date: '2026-10-07', note: 'свежая' });
  });

  it('гигантское человеческое сообщение не вешает поиск: контент режется до разбора', async () => {
    const huge = 'https://example.com/big ' + 'а'.repeat(300_000);
    const t0 = Date.now();
    const { r } = await search({ query: 'big' }, {
      links: [{ id: 11, session_id: 'u1_12', content: huge, created_at: '2026-10-07T10:00:00Z' }],
    });
    expect(r.files[0]).toMatchObject({ origin: 'link', url: 'https://example.com/big' });
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe('searchForUser: три источника — один конвейер', () => {
  it('сливаются в одну выдачу от новых к старым', async () => {
    const { r } = await search({}, { uploads: UPLOAD_ROWS, links: LINK_ROWS });
    expect(r.files.map((f) => [f.origin, f.date])).toEqual([
      ['link', '2026-10-07'],
      ['upload', '2026-10-06'],
      ['assistant', '2026-10-05'],
      ['assistant', '2026-10-03'],
      ['assistant', '2026-09-25'],
      ['assistant', '2026-09-10'],
    ]);
  });

  it('limit и total считаются по всем источникам вместе', async () => {
    const { r, pg } = await search({ days: 30, limit: 3 }, { uploads: UPLOAD_ROWS, links: LINK_ROWS });
    expect(pg.calls.find((c) => c.sql === USER_FILES_SQL)!.params).toEqual(['u1', 30]);
    expect(pg.calls.find((c) => c.sql === USER_LINKS_SQL)!.params).toEqual(['u1', 30]);
    expect(pg.calls.find((c) => /FROM chat_uploads/.test(c.sql))!.params).toEqual(['u1', 30]);
    expect(r.total).toBe(6);
    expect(r.files).toHaveLength(3);
  });

  it('фильтр по ассистенту действует на исходники и ссылки', async () => {
    const roman = await search({ assistant: 'роман' }, { uploads: UPLOAD_ROWS, links: LINK_ROWS });
    expect(roman.r.files.map((f) => f.origin)).toEqual(['upload', 'assistant']);
    const irina = await search({ assistant: 'ирина' }, { uploads: UPLOAD_ROWS, links: LINK_ROWS });
    expect(irina.r.files.map((f) => f.origin)).toEqual(['link', 'assistant', 'assistant']);
  });
});
