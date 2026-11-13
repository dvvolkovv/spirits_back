// src/common/services/storage.service.spec.ts
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
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

  it('abortSignal уходит в send — загрузку можно оборвать', async () => {
    const { svc, send } = make();
    const ctl = new AbortController();
    await svc.upload({ bucket: 'b', key: 'k', body: Buffer.from('x'), abortSignal: ctl.signal });
    expect(send.mock.calls[0][1]?.abortSignal).toBe(ctl.signal);
  });

  it('без abortSignal send зовётся как раньше — одним аргументом', async () => {
    const { svc, send } = make();
    await svc.upload({ bucket: 'b', key: 'k', body: Buffer.from('x') });
    expect(send.mock.calls[0]).toHaveLength(1);
  });

  it('publicUrl склеивает базу без двойного слэша', () => {
    const { svc } = make();
    expect(svc.publicUrl('b', 'id/a%20b.pdf')).toBe('https://pub/b/id/a%20b.pdf');
  });
});

/**
 * Task 11 — deleteConfirmed: строгая семантика удаления для account-deletion.
 *
 * Обычный delete() возвращает void и не отличает «объект удалён» от «MinIO
 * ответил 2xx на отсутствующий ключ» от «запрос не прошёл» (S3 DeleteObject
 * идемпотентен на протоколе, но ошибка транспорта/бакета молча глотается
 * только вызывающим кодом). Пёржу нужен подтверждённый исход:
 * 'deleted' | 'absent' — успех (absent = удалять нечего, идемпотентно),
 * любая прочая ошибка — наружу, чтобы job ушёл в retry, а не в done.
 */
describe('StorageService.deleteConfirmed', () => {
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

  function make(send: jest.Mock) {
    const svc = new StorageService();
    svc.onModuleInit();
    (svc as any).s3 = { send };
    return svc;
  }

  it('2xx на DeleteObject — подтверждённый успех "deleted"', async () => {
    const send = jest.fn(async () => ({}));
    const svc = make(send);

    await expect(svc.deleteConfirmed({ bucket: 'b', key: 'k' })).resolves.toBe('deleted');

    const cmd = send.mock.calls[0][0] as DeleteObjectCommand;
    expect(cmd).toBeInstanceOf(DeleteObjectCommand);
    expect(cmd.input).toEqual({ Bucket: 'b', Key: 'k' });
  });

  it('объекта нет (NotFound / NoSuchKey / 404) — тоже успех, "absent"', async () => {
    const cases: Array<{ name?: string; status?: number }> = [
      { name: 'NotFound' },
      { name: 'NoSuchKey' },
      { status: 404 },
    ];
    for (const c of cases) {
      const err: any = new Error('gone');
      if (c.name) err.name = c.name;
      if (c.status) err.$metadata = { httpStatusCode: c.status };
      const svc = make(jest.fn(async () => { throw err; }));
      await expect(svc.deleteConfirmed({ bucket: 'b', key: 'k' })).resolves.toBe('absent');
    }
  });

  it('неизвестная ошибка (timeout, 5xx, NoSuchBucket) — наружу, не "deleted"', async () => {
    const cases: any[] = [
      Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
      Object.assign(new Error('boom'), { name: 'InternalError', $metadata: { httpStatusCode: 503 } }),
      Object.assign(new Error('no bucket'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } }),
    ];
    for (const err of cases) {
      const svc = make(jest.fn(async () => { throw err; }));
      await expect(svc.deleteConfirmed({ bucket: 'b', key: 'k' })).rejects.toBe(err);
    }
  });

  it('старый delete() не тронут — по-прежнему void без проверки исхода', async () => {
    const err: any = new Error('gone');
    err.name = 'NotFound';
    const send = jest.fn(async () => { throw err; });
    const svc = make(send);
    await expect(svc.delete({ bucket: 'b', key: 'k' })).rejects.toBe(err);
  });
});
