const { execFileSync, spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'scripts', 'deploy-relay.sh');
const BASE_SHA = 'd4786e918d6df2420daccaa2da67cfd651f37ac1';

function write(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}
function executable(file, content) { write(file, content, 0o755); }
function text(command, args, options = {}) { return execFileSync(command, args, { encoding: 'utf8', ...options }).trim(); }

function makeBin(work, home) {
  const bin = path.join(work, 'bin');
  executable(path.join(bin, 'ssh'), `#!/usr/bin/env bash
while [[ $# -gt 0 ]]; do
  if [[ "$1" == -o ]]; then shift 2; else shift; break; fi
done
exec bash -c "$1"
`);
  executable(path.join(bin, 'rm'), `#!/usr/bin/env bash
if [[ "$*" == *file-agent-stage* && -n "$PAUSE_STAGING" ]]; then
  touch "$WORK/staging-started"
  while [[ ! -e "$PAUSE_STAGING" ]]; do /bin/sleep 0.05; done
fi
exec /bin/rm "$@"
`);
  executable(path.join(bin, 'pm2'), `#!/usr/bin/env bash
if [[ "$1" == pid ]]; then echo 4242; exit 0; fi
if [[ "$1" == restart ]]; then echo restart >> "$WORK/restarts.log"; exit 0; fi
exit 2
`);
  executable(path.join(bin, 'ps'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$1" == diff && "$2" == --cached ]]; then exit 0; fi
if [[ "$1" == add || "$1" == commit ]]; then exit 0; fi
if [[ "$1" == log ]]; then echo rollout-commit; exit 0; fi
exec /usr/bin/git "$@"
`);
  executable(path.join(bin, 'curl'), `#!/usr/bin/env bash
echo '{"status":"ok","inflight":0}'
exit 0
`);
  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');
  executable(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n');
  executable(path.join(bin, 'nginx'), '#!/usr/bin/env bash\nexit 0\n');
  return bin;
}

function runFull(home, work, lockFile, pauseFile, async) {
  const bin = makeBin(work, home);
  const nginxConf = path.join(work, 'parking.conf');
  write(nginxConf, 'server { location /chat { return 403; } }\n');
  const env = {
    ...process.env,
    HOME: home,
    WORK: work,
    PATH: `${bin}:${process.env.PATH}`,
    RELAY_HOST: 'fake',
    RELAY_DRAIN_FILE: path.join(home, 'drain.marker'),
    RELAY_DEPLOY_LOCK_FILE: lockFile,
    RELAY_NGINX_CONF: nginxConf,
    DRAIN_WAIT_SECONDS: '10',
    PAUSE_STAGING: pauseFile || '',
    PAUSE_FILE: '',
    LOCK_FILE: lockFile,
    NGINX_CONF: nginxConf,
  };
  const args = [DEPLOY, BASE_SHA, 'HEAD'];
  if (async) {
    const child = spawn('bash', args, { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
      work,
      done: new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status) => resolve({ status, stdout, stderr }));
      }),
    };
  }
  const result = spawnSync('bash', args, { cwd: ROOT, env, encoding: 'utf8' });
  return { work, ...result };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for staging');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('deploy-relay early staging lock', () => {
  it('второй rollout не удаляет shared STAGE/BASE_DIR и не меняет marker/files, пока первый paused в staging', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-early-home-'));
    const firstWork = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-early-first-'));
    const secondWork = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-early-second-'));
    const lockFile = path.join(home, 'deployment.lock');
    const release = path.join(home, 'release-staging');
    const live = path.join(home, 'file-agent');
    fs.mkdirSync(live, { recursive: true });
    const archive = path.join(home, 'base.tar');
    execFileSync('git', ['archive', BASE_SHA, 'relay-agent'], { cwd: ROOT, stdio: ['ignore', fs.openSync(archive, 'w'), 'inherit'] });
    execFileSync('tar', ['-xf', archive, '-C', live, '--strip-components=1']);
    const modules = fs.existsSync(path.join(ROOT, 'relay-agent', 'node_modules'))
      ? path.join(ROOT, 'relay-agent', 'node_modules')
      : path.join(ROOT, 'node_modules');
    fs.symlinkSync(modules, path.join(live, 'node_modules'), 'dir');
    const targetShort = text('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: ROOT });
    const baseShort = text('git', ['rev-parse', '--short=12', BASE_SHA], { cwd: ROOT });
    const stage = path.join(home, `file-agent-stage-${targetShort}`);
    const base = path.join(home, `file-agent-base-${baseShort}`);
    write(path.join(stage, 'sentinel'), 'keep\n');
    write(path.join(base, 'sentinel'), 'keep\n');

    const first = runFull(home, firstWork, lockFile, release, true);
    let second;
    let firstResult;
    try {
      await waitFor(() => fs.existsSync(path.join(firstWork, 'staging-started')));
      second = runFull(home, secondWork, lockFile, '', false);
      expect(second.status).not.toBe(0);
      expect(fs.existsSync(path.join(stage, 'sentinel'))).toBe(true);
      expect(fs.existsSync(path.join(base, 'sentinel'))).toBe(true);
      expect(fs.readFileSync(path.join(live, 'server.mjs'), 'utf8')).not.toContain('createInflight');
    } finally {
      write(release, 'release\n');
      firstResult = await first.done;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(firstWork, { recursive: true, force: true });
      fs.rmSync(secondWork, { recursive: true, force: true });
    }
    expect({ status: firstResult.status, stderr: firstResult.stderr }).toEqual({ status: 0, stderr: '' });
  }, 60000);
});
