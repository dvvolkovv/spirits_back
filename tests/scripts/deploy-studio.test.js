/**
 * deploy.sh: студия роликов (studio/) — свой package.json, без сборки (tsx),
 * браузеры съёмки (Playwright) и сборки (Remotion), процесс pm2 linkeon-studio.
 *
 * Команды сборки бэкенда (back_build_cmds) выполняются здесь по-настоящему —
 * в каталоге, похожем на сервер, а npm, npx, node и git подменены заглушками,
 * которые пишут журнал вызовов с каталогом, где их позвали.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');

/** Тело функции скрипта: от `имя() {` до первой `}` в начале строки. */
function scriptFunction(name) {
  const lines = fs.readFileSync(DEPLOY, 'utf8').split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`в deploy.sh нет функции ${name}`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

const STUB = (name) => `#!/usr/bin/env bash
echo "${name}($(basename "$PWD")) $*" >> "$WORK/log"
# FAIL_ON — подстрока вызова вместе с каталогом: «npm(studio) ci» роняет только npm ci студии.
if [ -n "$FAIL_ON" ]; then
  case "${name}($(basename "$PWD")) $*" in *"$FAIL_ON"*) exit 1 ;; esac
fi
exit 0
`;

/**
 * Каталог «сервера»: корень бэкенда со studio/ (и .env, если studio=env).
 * git diff --quiet отвечает «без изменений», если LOCK_SAME=1.
 */
function runBuildCmds({ studio = 'env', env = {} } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-studio-'));
  const root = path.join(work, 'back');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(root);
  if (studio) fs.mkdirSync(path.join(root, 'studio'));
  if (studio === 'env') fs.writeFileSync(path.join(root, 'studio', '.env'), 'X=1\n');
  for (const name of ['npm', 'npx', 'node']) {
    fs.writeFileSync(path.join(bin, name), STUB(name), { mode: 0o755 });
  }
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
echo "git($(basename "$PWD")) $*" >> "$WORK/log"
[ "$1" = diff ] && [ "$LOCK_SAME" = 1 ] && exit 0
[ "$1" = diff ] && exit 1
exit 0
`, { mode: 0o755 });
  const harness = path.join(work, 'harness.sh');
  fs.writeFileSync(harness, [
    scriptFunction('back_build_cmds'),
    'cmds=$(back_build_cmds)',
    'printf "%s" "$cmds" > "$WORK/cmds.sh"',
    `cd ${JSON.stringify(root)}`,
    'set -eo pipefail',
    'eval "$cmds"',
  ].join('\n'));
  const res = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { PATH: `${bin}:${process.env.PATH}`, WORK: work, FAIL_ON: '', LOCK_SAME: '', ...env },
  });
  const log = fs.existsSync(path.join(work, 'log')) ? fs.readFileSync(path.join(work, 'log'), 'utf8').split('\n').filter(Boolean) : [];
  const syntax = spawnSync('bash', ['-n', path.join(work, 'cmds.sh')], { encoding: 'utf8' });
  fs.rmSync(work, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, log, syntaxOk: syntax.status === 0 };
}

const inStudio = (log) => log.filter((l) => /^\w+\(studio\) /.test(l));

describe('deploy.sh: студия роликов в сборке бэкенда', () => {
  it('studio/.env есть — npm ci студии, браузеры Playwright и Remotion, по порядку', () => {
    const r = runBuildCmds();
    expect(r.status).toBe(0);
    expect(r.syntaxOk).toBe(true);
    expect(inStudio(r.log)).toEqual([
      'npm(studio) ci --no-audit --no-fund',
      'npx(studio) playwright install chromium',
      expect.stringMatching(/^node\(studio\) --input-type=module -e .*ensureBrowser/),
    ]);
  });

  it('studio/.env нет — студия не настроена: ни npm ci, ни браузеров, сообщение', () => {
    const r = runBuildCmds({ studio: 'dir' });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: \.env отсутствует — студия не настроена, рабочий процесс пропущен/);
  });

  it('каталога studio/ нет (старый коммит) — молча мимо', () => {
    const r = runBuildCmds({ studio: null });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/studio/);
  });

  it('тот же package-lock.json (возврат сборки) — npm ci студии пропущен, браузеры — всё равно', () => {
    const r = runBuildCmds({ env: { LOCK_SAME: '1', CI_SAME_AS: 'abc' } });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/studio: npm ci пропущен: package-lock\.json тот же/);
    expect(inStudio(r.log).some((l) => / ci /.test(`${l} `))).toBe(false);
    expect(inStudio(r.log).some((l) => /playwright install chromium/.test(l))).toBe(true);
  });

  it('npm ci студии упал — сборка падает с понятной строкой, браузеры не ставятся', () => {
    const r = runBuildCmds({ env: { FAIL_ON: 'npm(studio) ci' } });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: npm ci FAILED/);
    expect(inStudio(r.log).some((l) => /playwright/.test(l))).toBe(false);
  });

  it('браузеры не встали — сборка падает: иначе первая же съёмка упала бы на проде', () => {
    for (const fail of ['npx(studio) playwright install', 'node(studio) --input-type=module']) {
      const r = runBuildCmds({ env: { FAIL_ON: fail } });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/studio: браузеры не установились/);
    }
  });
});

describe('deploy.sh: рабочий процесс студии в откате прода', () => {
  it('откат бэкенда возвращает и студию: npm ci, браузеры и pm2 startOrReload — только при studio/.env', () => {
    const fn = scriptFunction('rollback_backend');
    const block = fn.slice(fn.indexOf('[ -f studio/.env ]'));
    expect(block).toMatch(/cd studio/);
    expect(block).toMatch(/npm ci --no-audit --no-fund > \/tmp\/studio-install\.log/);
    expect(block).toMatch(/npx playwright install chromium/);
    expect(block).toMatch(/pm2 startOrReload ecosystem\.config\.cjs > \/tmp\/studio-pm2\.log/);
    const n = spawnSync('bash', ['-n'], { input: fn, encoding: 'utf8' });
    expect(n.status).toBe(0);
  });
});
