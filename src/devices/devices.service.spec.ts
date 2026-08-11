import { DevicesService } from './devices.service';

function fakePg(behaviour: { throws?: boolean } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  return {
    calls,
    async query(sql: string, params: any[] = []) {
      calls.push({ sql, params });
      if (behaviour.throws) throw new Error('база недоступна');
      return { rows: [] };
    },
  };
}

describe('запись устройства', () => {
  it('пишет разобранные поля и подпись', async () => {
    const pg = fakePg();
    await new DevicesService(pg as any).record(
      '79088644408',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
    );

    expect(pg.calls).toHaveLength(1);
    expect(pg.calls[0].sql).toContain('user_devices');
    expect(pg.calls[0].params[0]).toBe('79088644408');
    expect(pg.calls[0].params).toContain('desktop');
    expect(pg.calls[0].params).toContain('Windows');
    expect(pg.calls[0].params).toContain('Chrome');
  });

  it('повторная запись обновляет, а не плодит строки', async () => {
    const pg = fakePg();
    await new DevicesService(pg as any).record('u1', 'Dart/3.10 (dart:io)');

    expect(pg.calls[0].sql).toContain('ON CONFLICT');
    expect(pg.calls[0].sql).toContain('last_seen');
  });

  // Вход по SMS в этом проекте уже ломался. Цеплять к нему необязательную
  // аналитику без страховки нельзя.
  it('падение базы НЕ пробрасывается наружу', async () => {
    const pg = fakePg({ throws: true });
    await expect(new DevicesService(pg as any).record('u1', 'Dart/3.10')).resolves.toBeUndefined();
  });

  // Клиент, который вообще не представляется, должен быть виден, а не пропущен.
  it('пустой User-Agent пишется как unknown, а не пропускается', async () => {
    const pg = fakePg();
    await new DevicesService(pg as any).record('u1', undefined);

    expect(pg.calls).toHaveLength(1);
    expect(pg.calls[0].params).toContain('unknown');
  });

  it('без userId не пишет ничего', async () => {
    const pg = fakePg();
    await new DevicesService(pg as any).record('', 'Dart/3.10');

    expect(pg.calls).toHaveLength(0);
  });
});
