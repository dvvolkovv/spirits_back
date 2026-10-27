/**
 * deploy.sh: студия роликов (studio/) — свой package.json, без сборки (tsx),
 * браузеры съёмки (Playwright) и сборки (Remotion), процесс pm2 linkeon-studio.
 *
 * Команды выполняются по-настоящему — в каталоге, похожем на сервер, а npm,
 * node, git, pm2 и локальный playwright подменены заглушками, которые пишут
 * журнал вызовов с каталогом, где их позвали. Логи шагов — в $TMPDIR теста.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');
const SHA = 'a'.repeat(40);

/** Тело функции скрипта: от `имя() {` до первой `}` в начале строки. */
function scriptFunction(name) {
  const lines = fs.readFileSync(DEPLOY, 'utf8').split('\n');
  const start = lines.indexOf(`${name}() {`);
  if (start < 0) throw new Error(`в deploy.sh нет функции ${name}`);
  const end = lines.indexOf('}', start);
  return lines.slice(start, end + 1).join('\n');
}

// FAIL_ON — подстрока вызова вместе с каталогом: «npm(studio) ci» роняет только npm ci студии.
const STUB = (name) => `#!/usr/bin/env bash
echo "${name}($(basename "$PWD")) $*" >> "$WORK/log"
if [ -n "$FAIL_ON" ]; then
  case "${name}($(basename "$PWD")) $*" in *"$FAIL_ON"*) exit 1 ;; esac
fi
exit 0
`;

/**
 * «Сервер»: корень бэкенда back/ со studio/. studio: 'env' — с .env; config —
 * есть ecosystem.config.cjs; deps — уже стоят node_modules/.bin/{tsx,playwright}.
 * npm ci студии ставит их (как настоящий). git diff --quiet — «без изменений» при LOCK_SAME=1.
 */
function server({ studio = 'env', config = true, deps = false } = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-studio-'));
  const root = path.join(work, 'back');
  const bin = path.join(work, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(work, 'tmp'));
  fs.mkdirSync(root);
  const st = path.join(root, 'studio');
  if (studio) fs.mkdirSync(st);
  if (studio === 'env') fs.writeFileSync(path.join(st, '.env'), 'X=1\n');
  if (studio && config) fs.writeFileSync(path.join(st, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  const localBins = () => {
    fs.mkdirSync(path.join(st, 'node_modules', '.bin'), { recursive: true });
    for (const b of ['tsx', 'playwright']) fs.writeFileSync(path.join(st, 'node_modules', '.bin', b), STUB(b), { mode: 0o755 });
  };
  if (studio && deps) localBins();
  for (const name of ['node', 'pm2', 'npx']) fs.writeFileSync(path.join(bin, name), STUB(name), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'npm'), `${STUB('npm').replace(/exit 0\n$/, '')}
if [ "$(basename "$PWD")" = studio ] && [ "$1" = ci ]; then
  mkdir -p node_modules/.bin
  for b in tsx playwright; do cp "$WORK/bin/.stub-$b" "node_modules/.bin/$b"; chmod +x "node_modules/.bin/$b"; done
fi
exit 0
`, { mode: 0o755 });
  for (const b of ['tsx', 'playwright']) fs.writeFileSync(path.join(bin, `.stub-${b}`), STUB(b), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/usr/bin/env bash
echo "git($(basename "$PWD")) $*" >> "$WORK/log"
[ "$1" = rev-parse ] && { echo ${SHA}; exit 0; }
[ "$1" = diff ] && [ "$LOCK_SAME" = 1 ] && exit 0
[ "$1" = diff ] && exit 1
exit 0
`, { mode: 0o755 });
  return { work, root, bin };
}

function run(srv, body, env = {}) {
  const harness = path.join(srv.work, 'harness.sh');
  fs.writeFileSync(harness, body);
  const res = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: { PATH: `${srv.bin}:${process.env.PATH}`, WORK: srv.work, TMPDIR: path.join(srv.work, 'tmp'), FAIL_ON: '', LOCK_SAME: '', ...env },
  });
  const log = fs.existsSync(path.join(srv.work, 'log')) ? fs.readFileSync(path.join(srv.work, 'log'), 'utf8').split('\n').filter(Boolean) : [];
  const tmpUsed = fs.readdirSync(path.join(srv.work, 'tmp'));
  fs.rmSync(srv.work, { recursive: true, force: true });
  return { status: res.status, out: `${res.stdout}${res.stderr}`, log, tmpUsed };
}

/** Команды функции-генератора (back_build_cmds, studio_restart_cmds) — как их выполнит сервер. */
function runCmds(fn, opts = {}, env = {}) {
  const srv = server(opts);
  const fns = ['studio_build_cmds', 'studio_restart_cmds', 'back_build_cmds'].map(scriptFunction).join('\n');
  const r = run(srv, [
    fns,
    `cmds=$(${fn})`,
    'printf "%s" "$cmds" > "$WORK/cmds.sh"',
    'bash -n "$WORK/cmds.sh" || { echo SYNTAX_ERROR; exit 99; }',
    `cd ${JSON.stringify(srv.root)}`,
    'set -eo pipefail',
    'eval "$cmds"',
  ].join('\n'), env);
  return r;
}

const inStudio = (log) => log.filter((l) => /^\w+\(studio\) /.test(l));
const PLAYWRIGHT = 'playwright(studio) install --only-shell chromium';
const ENSURE = /^node\(studio\) --input-type=module -e .*ensureBrowser/;

describe('deploy.sh: студия роликов в сборке бэкенда', () => {
  it('studio/.env и конфиг pm2 есть, зависимостей нет — npm ci студии, затем браузеры локальным playwright', () => {
    const r = runCmds('back_build_cmds');
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual(['npm(studio) ci --no-audit --no-fund', PLAYWRIGHT, expect.stringMatching(ENSURE)]);
    // npx не зовётся: без локального пакета он молча поставил бы последнюю версию playwright.
    expect(r.log.some((l) => l.startsWith('npx('))).toBe(false);
    // Логи шагов — в $TMPDIR, не в общий /tmp сервера.
    expect(r.tmpUsed).toEqual(expect.arrayContaining(['studio-install.log', 'studio-browsers.log']));
  });

  it('studio/.env нет — студия не настроена: ни npm ci, ни браузеров, сообщение', () => {
    const r = runCmds('back_build_cmds', { studio: 'dir' });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: \.env отсутствует — студия не настроена, рабочий процесс пропущен/);
  });

  it('каталога studio/ нет (старый коммит) — молча мимо', () => {
    const r = runCmds('back_build_cmds', { studio: null });
    expect(r.status).toBe(0);
    expect(r.out).not.toMatch(/studio/);
  });

  it('studio/.env есть, а конфига pm2 в коммите нет (план 2) — ни npm ci, ни браузеров, сообщение', () => {
    const r = runCmds('back_build_cmds', { config: false });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toEqual([]);
    expect(r.out).toMatch(/studio: в этом коммите нет studio\/ecosystem\.config\.cjs/);
  });

  it('lock-файл студии тот же, что у работающего коммита, и зависимости стоят — npm ci пропущен, браузеры проверяются', () => {
    for (const env of [{ STUDIO_SAME_AS: SHA }, { CI_SAME_AS: SHA }]) {
      const r = runCmds('back_build_cmds', { deps: true }, { LOCK_SAME: '1', ...env });
      expect(r.status).toBe(0);
      expect(r.out).toMatch(/studio: npm ci пропущен: package-lock\.json тот же/);
      expect(inStudio(r.log)).toEqual([expect.stringMatching(/^git\(studio\) diff --quiet a+ HEAD -- package-lock\.json$/), PLAYWRIGHT, expect.stringMatching(ENSURE)]);
    }
  });

  it('lock-файл тот же, но зависимостей нет (первый выкат на сервер) — npm ci всё равно', () => {
    const r = runCmds('back_build_cmds', { deps: false }, { LOCK_SAME: '1', STUDIO_SAME_AS: SHA });
    expect(r.status).toBe(0);
    expect(inStudio(r.log)).toContain('npm(studio) ci --no-audit --no-fund');
  });

  it('lock-файл изменился — npm ci', () => {
    const r = runCmds('back_build_cmds', { deps: true }, { STUDIO_SAME_AS: SHA });
    expect(inStudio(r.log)).toContain('npm(studio) ci --no-audit --no-fund');
  });

  it('npm ci студии упал — сборка падает с понятной строкой, браузеры не ставятся', () => {
    const r = runCmds('back_build_cmds', {}, { FAIL_ON: 'npm(studio) ci' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: npm ci FAILED/);
    expect(inStudio(r.log).some((l) => /playwright/.test(l))).toBe(false);
  });

  it('браузеры не встали — сборка падает: иначе первая же съёмка упала бы на проде', () => {
    for (const fail of ['playwright(studio) install', 'node(studio) --input-type=module']) {
      const r = runCmds('back_build_cmds', {}, { FAIL_ON: fail });
      expect(r.status).not.toBe(0);
      expect(r.out).toMatch(/studio: браузеры не установились/);
    }
  });
});

describe('deploy.sh: перезапуск рабочего процесса студии', () => {
  it('конфиг есть — pm2 startOrReload из studio/', () => {
    const r = runCmds('studio_restart_cmds');
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('pm2('))).toEqual(['pm2(studio) startOrReload ecosystem.config.cjs']);
  });

  it('конфига в коммите нет — процесс останавливается и удаляется: не крутить новый код поверх старого дерева', () => {
    const r = runCmds('studio_restart_cmds', { config: false });
    expect(r.status).toBe(0);
    expect(r.log.filter((l) => l.startsWith('pm2('))).toEqual(['pm2(back) delete linkeon-studio']);
    expect(r.out).toMatch(/studio: в этом коммите нет studio\/ecosystem\.config\.cjs — рабочий процесс остановлен/);
  });

  it('студия не настроена — pm2 не трогается', () => {
    for (const opts of [{ studio: 'dir' }, { studio: null }]) {
      expect(runCmds('studio_restart_cmds', opts).log.filter((l) => l.startsWith('pm2('))).toEqual([]);
    }
  });

  it('startOrReload упал — выход не ноль с понятной строкой', () => {
    const r = runCmds('studio_restart_cmds', {}, { FAIL_ON: 'pm2(studio) startOrReload' });
    expect(r.status).not.toBe(0);
    expect(r.out).toMatch(/studio: pm2 startOrReload FAILED/);
  });
});

describe('deploy.sh: студия в откате прода', () => {
  /** Настоящая rollback_backend; ssh_remote выполняет строку здесь же, в «сервере». */
  function rollback(opts, env = {}) {
    const srv = server(opts);
    const fns = ['studio_build_cmds', 'studio_restart_cmds', 'rollback_backend'].map(scriptFunction).join('\n');
    return run(srv, [
      'red() { echo "RED: $1"; }; green() { echo "GREEN: $1"; }',
      'ssh_remote() { bash -c "$*"; }',
      fns,
      `BACK_PATH=${JSON.stringify(srv.root)}; PRE_BACK_SHA=${SHA}; ENV_NAME=prod`,
      'rollback_backend',
    ].join('\n'), env);
  }

  it('откат на коммит с конфигом — npm ci студии по lock-файлу, браузеры и startOrReload после API', () => {
    const r = rollback({ deps: true }, { LOCK_SAME: '1' });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/GREEN: .*backend rolled back/);
    expect(r.out).toMatch(/studio: npm ci пропущен/);
    const pm2 = r.log.filter((l) => l.startsWith('pm2('));
    expect(pm2[0]).toMatch(/^pm2\(back\) restart linkeon-api/);
    expect(pm2[pm2.length - 1]).toBe('pm2(studio) startOrReload ecosystem.config.cjs');
    expect(inStudio(r.log)).toContain(PLAYWRIGHT);
  });

  it('откат на коммит без конфига (прод сейчас на таком) — студия остановлена, откат API не объявлен проваленным', () => {
    const r = rollback({ config: false });
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/GREEN: .*backend rolled back/);
    expect(r.out).not.toMatch(/ROLLBACK BACKEND FAILED/);
    expect(r.log).toContain('pm2(back) delete linkeon-studio');
    expect(inStudio(r.log)).toEqual([]);
  });
});
