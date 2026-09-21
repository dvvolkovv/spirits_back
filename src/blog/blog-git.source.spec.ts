import { parseGitLog, filterUserFacing } from './blog-git.source';

describe('parseGitLog', () => {
  it('разбирает строки sha\\tsubject', () => {
    const out = parseGitLog('abc123\tfeat(chat): голосовой ввод\ndef456\tfix: опечатка');
    expect(out).toEqual([
      { sha: 'abc123', subject: 'feat(chat): голосовой ввод' },
      { sha: 'def456', subject: 'fix: опечатка' },
    ]);
  });

  it('пустой вывод — пустой список, не падение', () => {
    expect(parseGitLog('')).toEqual([]);
  });
});

describe('filterUserFacing', () => {
  it('feat остаётся', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'feat(chat): голосовой ввод' }])).toHaveLength(1);
  });

  it('chore, docs, test, ci, refactor отбрасываются', () => {
    const noise = ['chore: бамп', 'docs(spec): дизайн', 'test: моки', 'ci: пайплайн', 'refactor: вынес хелпер']
      .map((subject, i) => ({ sha: String(i), subject }));
    expect(filterUserFacing(noise)).toHaveLength(0);
  });

  it('merge-коммиты отбрасываются', () => {
    expect(filterUserFacing([{ sha: 'a', subject: "Merge branch 'feat/x'" }])).toHaveLength(0);
  });

  it('fix остаётся: починка видимой поломки — это тоже новость', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'fix(auth): вход по почте' }])).toHaveLength(1);
  });

  it('ревёрт отбрасывается: откаченная фича — не новость', () => {
    expect(filterUserFacing([{ sha: 'a', subject: 'Revert "feat(chat): голосовой ввод"' }])).toHaveLength(0);
  });

  it('fixup и squash отбрасываются: это технический довесок к другому коммиту', () => {
    const noise = ['fixup! feat: что-то', 'squash! feat: что-то']
      .map((subject, i) => ({ sha: String(i), subject }));
    expect(filterUserFacing(noise)).toHaveLength(0);
  });
});
