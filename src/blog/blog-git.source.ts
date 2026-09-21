import { Injectable, Logger } from '@nestjs/common';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface GitCommit { sha: string; subject: string; }

export function parseGitLog(stdout: string): GitCommit[] {
  return String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((c) => c.sha && c.subject);
}

const NOISE = /^(chore|docs|test|tests|ci|build|refactor|style|perf)[(:]/i;

/**
 * Служебные префиксы коммита, по которым текст неинформативен сам по себе:
 * - `Merge `/`fixup! `/`squash! ` — технический довесок к другому коммиту,
 *   самостоятельной новости не несёт;
 * - `Revert "` — особый случай: подстрока внутри (`feat(...)`) выглядит как
 *   обычная фича, но это ровно противоположность новости — фичу откатили.
 *   Если такой коммит попадёт в дайджест, владелец месяц спустя не вспомнит,
 *   что одобрял отмену, и подтвердит пост об уже несуществующей фиче —
 *   а отменить прочитанный пост в канале нельзя.
 */
const SKIP_PREFIXES = ['Merge ', 'Revert "', 'fixup! ', 'squash! '];

export function filterUserFacing(commits: GitCommit[]): GitCommit[] {
  return commits.filter((c) => {
    if (SKIP_PREFIXES.some((p) => c.subject.startsWith(p))) return false;
    return !NOISE.test(c.subject);
  });
}

@Injectable()
export class BlogGitSource {
  private readonly logger = new Logger(BlogGitSource.name);

  /**
   * Пути к чекаутам через BLOG_GIT_REPOS (через запятую), по умолчанию — текущий.
   * Если .git нет — источник молча пуст. Это ожидаемо: на некоторых серверах
   * код раскладывается без истории, и тогда новости идут только из бэклога.
   */
  private repos(): string[] {
    const raw = process.env.BLOG_GIT_REPOS || process.cwd();
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  }

  async weeklyCommits(): Promise<GitCommit[]> {
    const out: GitCommit[] = [];
    for (const repo of this.repos()) {
      if (!fs.existsSync(path.join(repo, '.git'))) {
        this.logger.warn(`${repo}: нет .git, git-источник для него пуст`);
        continue;
      }
      try {
        const { stdout } = await exec(
          'git',
          ['-C', repo, 'log', '--since=7.days', '--no-merges', '--format=%h%x09%s'],
          { timeout: 15_000 },
        );
        out.push(...filterUserFacing(parseGitLog(stdout)));
      } catch (e: any) {
        this.logger.warn(`${repo}: git log не отработал — ${e.message}`);
      }
    }
    return out;
  }
}
