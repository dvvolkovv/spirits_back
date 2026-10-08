// src/common/services/storage.service.spec.ts
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { StorageService } from './storage.service';

describe('StorageService.upload', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.MINIO_ENDPOINT = 'http://127.0.0.1:9000';
    process.env.MINIO_ACCESS_KEY = 'k';
    process.env.MINIO_SECRET_KEY = 's';
    process.env.MINIO_PUBLIC_URL = 'https://pub/';
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  function make() {
    const svc = new StorageService();
    svc.onModuleInit();
    const send = jest.fn(async (_cmd: any) => ({}));
    (svc as any).s3 = { send };
    return { svc, send };
  }

  it('передаёт Content-Disposition в PutObject', async () => {
    const { svc, send } = make();
    await svc.upload({
      bucket: 'b',
      key: 'id/a.pdf',
      body: Buffer.from('x'),
      contentType: 'application/pdf',
      contentDisposition: 'attachment; filename="a.pdf"',
    });
    const cmd = send.mock.calls[0][0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input.ContentDisposition).toBe('attachment; filename="a.pdf"');
    expect(cmd.input.ContentType).toBe('application/pdf');
  });

  it('без contentDisposition поле не задаётся — прежние загрузки не меняются', async () => {
    const { svc, send } = make();
    await svc.upload({ bucket: 'b', key: 'k', body: Buffer.from('x') });
    expect((send.mock.calls[0][0] as PutObjectCommand).input.ContentDisposition).toBeUndefined();
  });

  it('publicUrl склеивает базу без двойного слэша', () => {
    const { svc } = make();
    expect(svc.publicUrl('b', 'id/a%20b.pdf')).toBe('https://pub/b/id/a%20b.pdf');
  });
});
