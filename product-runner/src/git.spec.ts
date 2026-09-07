import { Git } from './git';

function makeGit(responses: Record<string, string> = {}) {
  const runs: string[][] = [];
  const run = jest.fn(async (args: string[]) => {
    runs.push(args);
    const key = args.join(' ');
    for (const [pattern, out] of Object.entries(responses)) {
      if (key.startsWith(pattern)) return out;
    }
    return '';
  });
  return { git: new Git('/srv/app', run), runs, run };
}

describe('Git.headSha', () => {
  it('возвращает текущий sha', async () => {
    const { git } = makeGit({ 'rev-parse HEAD': 'abc123\n' });

    await expect(git.headSha()).resolves.toBe('abc123');
  });
});

describe('Git.commitPendingChanges', () => {
  it('коммитит грязное дерево до начала хода', async () => {
    const { git, runs } = makeGit({ 'status --porcelain': ' M src/index.ts\n' });

    await git.commitPendingChanges();

    // Без этого git reset --hard при откате уничтожит чужие ручные правки:
    // кто-то полезет на VM руками, это вопрос времени.
    expect(runs.some((r) => r[0] === 'add')).toBe(true);
    expect(runs.some((r) => r[0] === 'commit')).toBe(true);
  });

  it('на чистом дереве не создаёт пустой коммит', async () => {
    const { git, runs } = makeGit({ 'status --porcelain': '' });

    await git.commitPendingChanges();

    expect(runs.some((r) => r[0] === 'commit')).toBe(false);
  });
});

describe('Git.resetHard', () => {
  it('возвращает дерево на указанный sha', async () => {
    const { git, runs } = makeGit();

    await git.resetHard('aaa111');

    expect(runs).toContainEqual(['reset', '--hard', 'aaa111']);
  });
});

describe('Git.push', () => {
  it('без remote не пушит и не падает', async () => {
    const { git, runs } = makeGit({ remote: '' });

    await git.push();

    expect(runs.some((r) => r[0] === 'push')).toBe(false);
  });

  it('с remote пушит', async () => {
    const { git, runs } = makeGit({ remote: 'origin\n' });

    await git.push();

    expect(runs.some((r) => r[0] === 'push')).toBe(true);
  });
});
