import { createHash } from 'crypto';
import { ChatUploadsService } from './chat-uploads.service';

describe('ChatUploadsService', () => {
  const pg = { query: jest.fn(async () => ({ rows: [] })) };
  const storage = {
    upload: jest.fn(async () => 'https://public.invalid/should-not-be-used'),
    delete: jest.fn(async () => {}),
    createBucketIfAbsent: jest.fn(async () => {}),
  };
  const service = new ChatUploadsService(pg as any, storage as any);

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.JWT_SECRET = 'spec-secret';
    process.env.BACKEND_URL = 'https://my.linkeon.test';
  });

  it('сохраняет байты и запись без публичной ссылки', async () => {
    pg.query.mockResolvedValueOnce({ rows: [{ id: '11111111-1111-4111-8111-111111111111', user_id: 'u1', session_id: 'u1_12', original_name: 'a.pdf', mime: 'application/pdf', size_bytes: 3, sha256: createHash('sha256').update('abc').digest('hex'), storage_key: 'k/a.pdf', created_at: new Date('2026-01-01') }] });
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('abc'), originalname: 'a.pdf', mimetype: 'application/pdf' }] });
    expect(result.saved[0]).toMatchObject({ originalName: 'a.pdf', sizeBytes: 3 });
    expect(result.failed).toEqual([]);
    expect(storage.upload.mock.calls[0][0].bucket).toBe('linkeon-chat-uploads');
    expect(JSON.stringify(result)).not.toContain('public.invalid');
  });

  it('при ошибке записи удаляет объект и возвращает failed', async () => {
    pg.query.mockRejectedValueOnce(new Error('db down'));
    const result = await service.saveOriginals({ userId: 'u1', sessionId: 'u1_12', files: [{ buffer: Buffer.from('x'), originalname: 'x.txt' }] });
    expect(result.failed).toEqual(['x.txt']);
    expect(storage.delete).toHaveBeenCalled();
  });

  it('подпись живёт час и не принимает чужую/просроченную', () => {
    const url = service.assistantUrl('11111111-1111-4111-8111-111111111111', 1000);
    expect(url).toContain('exp=4600');
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 1000)).toBe(true);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', 'bad', 1000)).toBe(false);
    expect(service.verifyAssistant('11111111-1111-4111-8111-111111111111', '4600', url.split('sig=')[1], 4601)).toBe(false);
  });

  it('блок ассистента пуст при выключенном флаге и подписан при включённом', () => {
    const record = {
      id: '11111111-1111-4111-8111-111111111111',
      userId: 'u1',
      sessionId: 'u1_12',
      originalName: 'a.pdf',
      mime: 'application/pdf',
      sizeBytes: 3,
      sha256: 'a'.repeat(64),
      storageKey: 'k/a.pdf',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    process.env.CHAT_UPLOADS_ENABLED = 'false';
    expect(service.assistantBlock([record])).toBe('');

    process.env.CHAT_UPLOADS_ENABLED = 'true';
    const block = service.assistantBlock([record]);
    expect(block).toContain(`Earlier user uploads:\n- a.pdf: https://my.linkeon.test/webhook/chat-uploads/${record.id}`);
    expect(block).toMatch(/\?exp=\d+&sig=[0-9a-f]{64}$/);
  });
});
