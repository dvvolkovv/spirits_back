import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export type GitRunner = (args: string[]) => Promise<string>;

export class Git {
  private readonly run: GitRunner;

  constructor(
    private readonly cwd: string,
    run?: GitRunner,
  ) {
    this.run =
      run ??
      (async (args: string[]) => {
        // execFile, а не exec: аргументы не проходят через шелл, поэтому
        // сообщение коммита с кавычками или $(...) не может выполниться как
        // команда. Это важно, так как сообщение в commitAll собирается из
        // промпта пользователя.
        const { stdout } = await execFileAsync('git', args, { cwd: this.cwd, maxBuffer: 16 * 1024 * 1024 });
        return stdout;
      });
  }

  async headSha(): Promise<string> {
    return (await this.run(['rev-parse', 'HEAD'])).trim();
  }

  async isDirty(): Promise<boolean> {
    return (await this.run(['status', '--porcelain'])).trim().length > 0;
  }

  /**
   * Кто-то полезет на VM руками — это вопрос времени. Если не закоммитить их
   * работу ДО начала хода, sha_before укажет на состояние без неё, и откат её
   * уничтожит.
   */
  async commitPendingChanges(): Promise<void> {
    if (!(await this.isDirty())) return;
    await this.run(['add', '-A']);
    await this.run(['commit', '-m', 'ручные правки на сервере (сохранено раннером)']);
  }

  async commitAll(message: string): Promise<string> {
    if (await this.isDirty()) {
      await this.run(['add', '-A']);
      await this.run(['commit', '-m', message]);
    }
    return this.headSha();
  }

  async resetHard(sha: string): Promise<void> {
    await this.run(['reset', '--hard', sha]);
  }

  /** У продукта может не быть remote — это нормально, ход не должен падать. */
  async push(): Promise<void> {
    const remotes = (await this.run(['remote'])).trim();
    if (!remotes) return;
    await this.run(['push']);
  }
}
