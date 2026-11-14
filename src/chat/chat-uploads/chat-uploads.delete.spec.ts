import { ChatUploadsService } from './chat-uploads.service';

/**
 * Удаление аккаунта (Task 7, spec 2026-11-13-chat-upload-memory).
 *
 * deleteForUser обязан СНЧАЛА удалить из MinIO все объекты владельца
 * (storage_key — единственный указатель на байты), и только потом строки
 * chat_uploads. Обратный порядок при сбое MinIO оставил бы байты навсегда:
 * без строк их ключи некому найти. Допустимость ошибок (NotFound терпится,
 * остальное прокидывается наверх) покрыта в chat-uploads.service.spec.ts —
 * здесь именно порядок и полнота.
 */
describe('deleteForUser: порядок очистки при удалении аккаунта', () => {
  function makeStubs(keys: string[]) {
    const pg = { query: jest.fn(async () => ({ rows: [] })) };
    pg.query.mockResolvedValueOnce({ rows: keys.map((storage_key) => ({ storage_key })) });
    const storage = {
      upload: jest.fn(),
      delete: jest.fn(async () => {}),
      createBucketIfAbsent: jest.fn(),
      downloadStream: jest.fn(),
    };
    return { pg, storage, service: new ChatUploadsService(pg as any, storage as any) };
  }

  it('сначала удаляет ВСЕ объекты владельца из MinIO, потом строки chat_uploads', async () => {
    const keys = ['k/a.pdf', 'k/b.pdf', 'k/c.pdf'];
    const { pg, storage, service } = makeStubs(keys);

    await service.deleteForUser('u1');

    // Выборка ключей — по владельцу.
    expect(String(pg.query.mock.calls[0][0])).toContain('SELECT storage_key FROM chat_uploads');
    expect(pg.query.mock.calls[0][1]).toEqual(['u1']);

    // Каждый ключ удалён из приватного бакета, порядок сохранён.
    expect(storage.delete.mock.calls.map((c) => c[0])).toEqual(
      keys.map((key) => ({ bucket: 'linkeon-chat-uploads', key })),
    );

    // DELETE FROM — последний запрос, и строго ПОСЛЕ всех storage.delete:
    // иначе при сбое MinIO строки потерялись бы раньше байтов.
    const lastCall = pg.query.mock.calls[pg.query.mock.calls.length - 1];
    expect(String(lastCall[0])).toMatch(/^DELETE FROM chat_uploads WHERE user_id = \$1/);
    expect(lastCall[1]).toEqual(['u1']);
    const storageOrders = (storage.delete as any).mock.invocationCallOrder as number[];
    const pgOrders = (pg.query as any).mock.invocationCallOrder as number[];
    expect(Math.max(...storageOrders)).toBeLessThan(pgOrders[pgOrders.length - 1]);
  });

  it('без записей владельца — только DELETE FROM, MinIO не трогается', async () => {
    const { pg, storage, service } = makeStubs([]);

    await service.deleteForUser('u-empty');

    expect(storage.delete).not.toHaveBeenCalled();
    const lastCall = pg.query.mock.calls[pg.query.mock.calls.length - 1];
    expect(String(lastCall[0])).toMatch(/^DELETE FROM chat_uploads WHERE user_id = \$1/);
    expect(lastCall[1]).toEqual(['u-empty']);
  });
});
