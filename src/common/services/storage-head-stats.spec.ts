import { StorageService } from './storage.service';

const svcWith = (send: jest.Mock) => {
  const s = new StorageService();
  (s as any).s3 = { send };
  return s;
};

describe('StorageService.head', () => {
  it('отдаёт размер и тип', async () => {
    const s = svcWith(jest.fn().mockResolvedValue({ ContentLength: 1234, ContentType: 'image/png' }));
    expect(await s.head('b', 'k')).toEqual({ size: 1234, contentType: 'image/png' });
  });

  it('объекта нет — null', async () => {
    const err = Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
    expect(await svcWith(jest.fn().mockRejectedValue(err)).head('b', 'k')).toBeNull();
  });

  it('другая ошибка — бросает', async () => {
    const err = Object.assign(new Error('Access Denied.'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
    await expect(svcWith(jest.fn().mockRejectedValue(err)).head('b', 'k')).rejects.toThrow('Access Denied.');
  });

  it('abortSignal уходит в send — проверку можно оборвать', async () => {
    const send = jest.fn().mockResolvedValue({ ContentLength: 1 });
    const s = svcWith(send);
    const ctl = new AbortController();
    await s.head('b', 'k', ctl.signal);
    expect(send.mock.calls[0][1]?.abortSignal).toBe(ctl.signal);
  });

  it('без abortSignal send зовётся как раньше — одним аргументом', async () => {
    const send = jest.fn().mockResolvedValue({ ContentLength: 1 });
    await svcWith(send).head('b', 'k');
    expect(send.mock.calls[0]).toHaveLength(1);
  });
});

describe('StorageService.bucketStats', () => {
  it('суммирует все страницы списка', async () => {
    const send = jest.fn()
      .mockResolvedValueOnce({ Contents: [{ Size: 10 }, { Size: 20 }], IsTruncated: true, NextContinuationToken: 't2' })
      .mockResolvedValueOnce({ Contents: [{ Size: 5 }], IsTruncated: false });
    expect(await svcWith(send).bucketStats('b')).toEqual({ objects: 3, bytes: 35 });
    expect(send.mock.calls[1][0].input.ContinuationToken).toBe('t2');
  });

  it('пустой бакет — нули', async () => {
    expect(await svcWith(jest.fn().mockResolvedValue({ IsTruncated: false })).bucketStats('b')).toEqual({ objects: 0, bytes: 0 });
  });
});
