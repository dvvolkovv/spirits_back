import { ChatUploadsService, PANEL_UPLOADS_LIMIT } from './chat-uploads.service';

const ID_NEW = '11111111-1111-4111-8111-111111111111';
const ID_OLD = '22222222-2222-4222-8222-222222222222';

/** Строка chat_uploads после миграции 002 — как её отдаёт pg. */
const uploadRow = (p: Record<string, unknown> = {}) => ({
  id: ID_NEW,
  user_id: 'u1',
  session_id: 'u1_12',
  original_name: 'гостиная.jpg',
  mime: 'image/jpeg',
  size_bytes: 10,
  sha256: 'a'.repeat(64),
  storage_key: `${ID_NEW}/гостиная.jpg`,
  created_at: new Date('2026-11-16T10:00:00Z'),
  source: 'web',
  thumb_key: `thumbs/${ID_NEW}/гостиная.jpg.webp`,
  note: 'Фото гостиной: выбрали светлые обои',
  note_updated_at: new Date('2026-11-16T10:05:00Z'),
  note_assistant_id: '12',
  ...p,
});

describe('ChatUploadsService.listForSessionPanel', () => {
  const pg = { query: jest.fn(async (_sql: string, _params: any[] = []) => ({ rows: [] as any[] })) };
  const service = new ChatUploadsService(pg as any, {} as any);

  beforeEach(() => jest.clearAllMocks());

  it('одна выборка: свои загрузки этой переписки, от новых к старым, не больше 500', async () => {
    pg.query.mockResolvedValueOnce({
      rows: [
        uploadRow(),
        uploadRow({
          id: ID_OLD,
          original_name: 'Договор.pdf',
          mime: 'application/pdf',
          storage_key: `${ID_OLD}/Договор.pdf`,
          created_at: new Date('2026-11-01T10:00:00Z'),
          source: 'scan',
          thumb_key: null,
          note: null,
          note_updated_at: null,
          note_assistant_id: null,
        }),
      ],
    });

    const out = await service.listForSessionPanel('u1', 'u1_12');

    expect(pg.query).toHaveBeenCalledTimes(1);
    const [sql, params] = pg.query.mock.calls[0];
    // user_id в условии обязателен: ключ сессии собирает контроллер, а
    // реестр отдаёт строки только их владельцу.
    expect(sql).toMatch(/FROM chat_uploads\s+WHERE user_id = \$1 AND session_id = \$2/);
    expect(sql).toMatch(/ORDER BY created_at DESC\s+LIMIT \$3/);
    expect(params).toEqual(['u1', 'u1_12', 500]);
    expect(PANEL_UPLOADS_LIMIT).toBe(500);

    expect(out.map((r) => r.id)).toEqual([ID_NEW, ID_OLD]);
    expect(out[0]).toMatchObject({
      originalName: 'гостиная.jpg',
      source: 'web',
      thumbKey: `thumbs/${ID_NEW}/гостиная.jpg.webp`,
      note: 'Фото гостиной: выбрали светлые обои',
      createdAt: '2026-11-16T10:00:00.000Z',
    });
    expect(out[1]).toMatchObject({ originalName: 'Договор.pdf', source: 'scan', thumbKey: null, note: null });
  });

  it('limit выше потолка режется до 500, меньше — уходит как есть', async () => {
    await service.listForSessionPanel('u1', 'u1_12', 10_000);
    await service.listForSessionPanel('u1', 'u1_12', 20);
    expect(pg.query.mock.calls.map((c) => c[1][2])).toEqual([500, 20]);
  });

  it('пустая переписка — пустой список', async () => {
    await expect(service.listForSessionPanel('u1', 'u1_99')).resolves.toEqual([]);
  });
});
