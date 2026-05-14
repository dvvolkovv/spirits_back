// worker/src/render/temp-dir.ts
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export class TempDir {
  constructor(readonly root: string) {}

  static async create(jobId: string): Promise<TempDir> {
    const root = path.join(os.tmpdir(), `smm-job-${jobId}`);
    await fs.mkdir(root, { recursive: true });
    return new TempDir(root);
  }

  file(name: string): string {
    return path.join(this.root, name);
  }

  async cleanup(): Promise<void> {
    await fs.rm(this.root, { recursive: true, force: true });
  }
}
