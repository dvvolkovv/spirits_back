import * as fs from 'fs';
import { NeoSnapshotHealthService } from './neo-snapshot-health.service';

describe('NeoSnapshotHealthService: ошибка inspection новейшего снапшота', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NEO4J_DR_HOST;
    delete process.env.BACKUP_DIR;
  });

  it('не подменяет недоступный новейший каталог предыдущим healthy снапшотом', async () => {
    process.env.NEO4J_DR_HOST = 'node-3';
    process.env.BACKUP_DIR = '/backups';
    const service = new NeoSnapshotHealthService();
    const oldDir = '/backups/20261103-010000';
    const newDir = '/backups/20261104-010000';

    jest.spyOn(fs, 'existsSync').mockReturnValue(true);
    jest.spyOn(fs, 'readdirSync').mockReturnValue(['20261103-010000', '20261104-010000'] as any);
    jest.spyOn(fs, 'statSync').mockImplementation((p: any) => {
      if (String(p) === newDir) throw new Error('EACCES newest snapshot');
      if (String(p) === oldDir) return { isDirectory: () => true } as any;
      return { isDirectory: () => false, size: 100, mtime: new Date() } as any;
    });
    jest.spyOn(service as any, 'localMd5').mockResolvedValue('same-md5');
    jest.spyOn(service as any, 'probeRemote').mockResolvedValue({
      reachable: true,
      error: null,
      files: {
        'neo4j.dump.gz': { present: true, size: 100, mtimeEpoch: Date.now() / 1000, md5: 'same-md5' },
        'neo4j.schema.txt': { present: true, size: 100, mtimeEpoch: Date.now() / 1000, md5: 'same-md5' },
      },
    });

    const overview = await service.getOverview();

    expect(overview.healthy).toBe(false);
    expect(overview.error).toContain('EACCES newest snapshot');
  });
});
