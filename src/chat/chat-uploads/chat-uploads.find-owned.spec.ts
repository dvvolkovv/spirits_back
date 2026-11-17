import { ChatUploadTooLargeError, ChatUploadsService } from './chat-uploads.service';

/**
 * findOwnedOriginal — байты исходника для инструментов картинок и видео.
 * Только владельцу: владелец — условие SQL, чужая строка не читается вовсе, и
 * «чужая» неотличима от «нет такой» (как 404 у GET /webhook/chat-uploads/:id).
 */

const OWN_ID = '77777777-7777-4777-8777-777777777777';

/** Строка chat_uploads со всеми колонками 001 и 002. */
function uploadRow(over: Record<string, unknown> = {}) {
  return {
    id: OWN_ID, user_id: 'u-1', session_id: 'u-1_12', original_name: 'гостиная.jpg',
    mime: 'image/jpeg', size_bytes: 10, sha256: 'c'.repeat(64), storage_key: `${OWN_ID}/gostinaya.jpg`,
    created_at: new Date('2026-11-10T10:00:00Z'), source: 'web', thumb_key: null,
    note: null, note_updated_at: null, note_assistant_id: null,
    ...over,
  };
}

function make(row: Record<string, any> | null = uploadRow()) {
  const pg = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (/FROM chat_uploads/.test(sql) && row && params[0] === row.id && params[1] === row.user_id) return { rows: [row] };
      return { rows: [] };
    }),
  };
  const storage = { download: jest.fn(async () => Buffer.from('jpeg-bytes')) };
  return { svc: new ChatUploadsService(pg as any, storage as any), pg, storage };
}

describe('ChatUploadsService.findOwnedOriginal', () => {
  it('владельцу отдаёт запись и байты из приватного бакета', async () => {
    const { svc, storage, pg } = make();
    const r = await svc.findOwnedOriginal({ id: OWN_ID, userId: 'u-1' });
    expect(r?.record).toMatchObject({ id: OWN_ID, userId: 'u-1', mime: 'image/jpeg', originalName: 'гостиная.jpg' });
    expect(r?.body.toString()).toBe('jpeg-bytes');
    expect(storage.download).toHaveBeenCalledWith({ bucket: 'linkeon-chat-uploads', key: `${OWN_ID}/gostinaya.jpg` });
    expect(String(pg.query.mock.calls[0][0])).toMatch(/WHERE id = \$1 AND user_id = \$2/);
    expect(pg.query.mock.calls[0][1]).toEqual([OWN_ID, 'u-1']);
  });

  it('чужому — null, байты не читаются', async () => {
    const { svc, storage } = make();
    await expect(svc.findOwnedOriginal({ id: OWN_ID, userId: 'u-2' })).resolves.toBeNull();
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('несуществующий id — null; не-UUID и пустой userId не доходят до базы', async () => {
    const { svc, pg } = make();
    await expect(svc.findOwnedOriginal({ id: '88888888-8888-4888-8888-888888888888', userId: 'u-1' })).resolves.toBeNull();
    pg.query.mockClear();
    await expect(svc.findOwnedOriginal({ id: '../etc/passwd', userId: 'u-1' })).resolves.toBeNull();
    await expect(svc.findOwnedOriginal({ id: OWN_ID, userId: '' })).resolves.toBeNull();
    expect(pg.query).not.toHaveBeenCalled();
  });

  it('больше maxBytes по реестру — ChatUploadTooLargeError до скачивания', async () => {
    const { svc, storage } = make(uploadRow({ size_bytes: 9 * 1024 * 1024 }));
    await expect(svc.findOwnedOriginal({ id: OWN_ID, userId: 'u-1', maxBytes: 8 * 1024 * 1024 }))
      .rejects.toBeInstanceOf(ChatUploadTooLargeError);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it('фактические байты больше maxBytes (реестр разошёлся с хранилищем) — тоже отказ', async () => {
    const { svc, storage } = make(uploadRow({ size_bytes: 3 }));
    storage.download.mockResolvedValueOnce(Buffer.alloc(16));
    await expect(svc.findOwnedOriginal({ id: OWN_ID, userId: 'u-1', maxBytes: 8 }))
      .rejects.toBeInstanceOf(ChatUploadTooLargeError);
  });

  it('без maxBytes размер не ограничен', async () => {
    const { svc } = make(uploadRow({ size_bytes: 50 * 1024 * 1024 }));
    await expect(svc.findOwnedOriginal({ id: OWN_ID, userId: 'u-1' })).resolves.not.toBeNull();
  });
});
