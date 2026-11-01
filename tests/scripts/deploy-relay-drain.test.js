const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy-relay.sh');
const source = fs.readFileSync(DEPLOY, 'utf8');
const remote = source.match(/<<'REMOTE'\n([\s\S]*)\nREMOTE\s*$/);
if (!remote) throw new Error('REMOTE payload not found');

function write(file, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

function executable(file, content) {
  write(file, content, 0o755);
}

function runRollout(health, options = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-relay-drain-'));
  const home = path.join(work, 'home');
  const live = path.join(home, 'file-agent');
  const stage = path.join(home, 'stage');
  const base = path.join(home, 'base');
  const bin = path.join(work, 'bin');
  const drainFile = path.join(work, 'drain.marker');
  const lockFile = options.lockFile || path.join(work, 'deployment.lock');
  const baseServer = 'import "./helper.mjs";\nconsole.log("base");\n';
  const targetServer = 'import "./helper.mjs";\nconsole.log("target");\n';
  const helper = 'export const ok = true;\n';
  const passingTest = 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("ok", () => assert.ok(true));\n';
  for (const dir of [live, stage, base]) {
    write(path.join(dir, 'helper.mjs'), helper);
    write(path.join(dir, 'a.test.mjs'), passingTest);
  }
  write(path.join(live, 'server.mjs'), baseServer);
  write(path.join(base, 'server.mjs'), baseServer);
  write(path.join(stage, 'server.mjs'), targetServer);
  fs.mkdirSync(path.join(live, 'node_modules'));

  executable(path.join(bin, 'pm2'), `#!/usr/bin/env bash
if [[ "$1" == pid ]]; then echo 4242; exit 0; fi
if [[ "$1" == restart ]]; then
  if [[ -e "$DRAIN_FILE" ]]; then gate=yes; else gate=no; fi
  echo "restart gate=$gate" >> "$WORK/restarts.log"
  exit 0
fi
exit 2
`);
  executable(path.join(bin, 'ps'), `#!/usr/bin/env bash
if [[ -e "$DRAIN_FILE" ]]; then gate=yes; else gate=no; fi
echo "ps gate=$gate" >> "$WORK/ps.log"
exit 0
`);
  executable(path.join(bin, 'git'), `#!/usr/bin/env bash
if [[ "$1" == diff ]]; then exit 0; fi
if [[ "$1" == log ]]; then echo rollout-commit; exit 0; fi
exit 0
`);
  executable(path.join(bin, 'curl'), `#!/usr/bin/env bash
if [[ -n "$PAUSE_FILE" && ! -e "$WORK/health.started" ]]; then
  touch "$WORK/health.started"
  while [[ ! -e "$PAUSE_FILE" ]]; do /bin/sleep 0.05; done
fi
if [[ -f "$WORK/restarts.log" ]]; then restarts=$(wc -l < "$WORK/restarts.log"); else restarts=0; fi
if [[ -e "$DRAIN_FILE" ]]; then gate=yes; else gate=no; fi
echo "curl restart=$restarts gate=$gate" >> "$WORK/curl.log"
case "${health}" in
  inflight-then-zero)
    calls=$(cat "$WORK/inflight-calls" 2>/dev/null || echo 0)
    calls=$((calls + 1))
    echo "$calls" > "$WORK/inflight-calls"
    if [[ "$calls" -eq 1 ]]; then echo '{"status":"ok","inflight":1}'; else echo '{"status":"ok","inflight":0}'; fi
    exit 0 ;;
  target-fails)
    if [[ "$restarts" -eq 0 || "$restarts" -ge 2 ]]; then echo '{"status":"ok","inflight":0}'; exit 0; fi
    exit 1 ;;
  all-fail)
    if [[ "$restarts" -eq 0 ]]; then echo '{"status":"ok","inflight":0}'; exit 0; fi
    exit 1 ;;
  legacy) echo '{"status":"ok"}'; exit 0 ;;
  *) echo '{"status":"ok","inflight":0}'; exit 0 ;;
esac
`);
  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  const harness = path.join(work, 'remote.sh');
  write(harness, remote[1]);
  const env = {
    ...process.env,
    HOME: home,
    WORK: work,
    PATH: `${bin}:${process.env.PATH}`,
    STAGE: 'stage',
    BASE_DIR: 'base',
    TARGET_SHORT: 'target123',
    FILES_CSV: 'server.mjs',
    PUT_CSV: 'server.mjs',
    DEL_CSV: '',
    ADD_CSV: '',
    DRAIN_FILE: drainFile,
    DRAIN_WAIT_SECONDS: '1',
    LOCK_FILE: lockFile,
    PAUSE_FILE: options.pauseFile || '',
  };
  const finish = (result) => {
    if (process.env.DEBUG_ROLLOUT) {
      console.error({
        stdout: result.stdout,
        stderr: result.stderr,
        restarts: fs.existsSync(path.join(work, 'restarts.log')) ? fs.readFileSync(path.join(work, 'restarts.log'), 'utf8') : '',
        curls: fs.existsSync(path.join(work, 'curl.log')) ? fs.readFileSync(path.join(work, 'curl.log'), 'utf8') : '',
      });
    }
    return {
      ...result,
      work,
      lockFile,
      drainFile,
      liveServer: fs.readFileSync(path.join(live, 'server.mjs'), 'utf8'),
      restarts: fs.existsSync(path.join(work, 'restarts.log')) ? fs.readFileSync(path.join(work, 'restarts.log'), 'utf8') : '',
      curls: fs.existsSync(path.join(work, 'curl.log')) ? fs.readFileSync(path.join(work, 'curl.log'), 'utf8') : '',
      drainExists: fs.existsSync(drainFile),
      cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
    };
  };
  const args = [...(process.env.DEBUG_ROLLOUT ? ['-x'] : []), harness];
  if (options.async) {
    const child = spawn('bash', args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    return {
      work,
      lockFile,
      done: new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (status) => resolve(finish({ status, stdout, stderr })));
      }),
    };
  }
  return finish(spawnSync('bash', args, { encoding: 'utf8', env }));
}

async function waitFor(predicate, timeoutMs = 5000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for rollout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('deploy-relay drain/admission gate', () => {
  it('держит gate до успешного health и снимает его только после него', () => {
    const r = runRollout('ok');
    try {
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.restarts).toContain('restart gate=yes');
      expect(r.curls).toContain('gate=yes');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('при target health failure восстанавливает base и открывает chat только после rollback health', () => {
    const r = runRollout('target-fails');
    try {
      expect(r.status).not.toBe(0);
      expect(r.liveServer).toContain('base');
      expect(r.liveServer).not.toContain('target');
      expect(r.restarts.match(/restart gate=yes/g) || []).toHaveLength(2);
      expect(r.curls).toContain('restart=2 gate=yes');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('при failed rollback health оставляет admission закрытым', () => {
    const r = runRollout('all-fail');
    try {
      expect(r.status).not.toBe(0);
      expect(r.liveServer).toContain('base');
      expect(r.restarts.match(/restart gate=yes/g) || []).toHaveLength(2);
      expect(r.drainExists).toBe(true);
    } finally {
      r.cleanup();
    }
  });

  it('ждёт и in-flight counter, и PM2 children до replacement/restart', () => {
    const r = runRollout('inflight-then-zero');
    try {
      expect(r.status).toBe(0);
      expect(r.curls.trim().split('\n')).toHaveLength(3);
      expect(r.curls.match(/restart=0 gate=yes/g) || []).toHaveLength(2);
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('принимает legacy health без inflight при первом обновлении релея', () => {
    const r = runRollout('legacy');
    try {
      expect(r.status).toBe(0);
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('второй overlapping rollout не меняет marker/files и ждёт первый flock', async () => {
    const sharedLock = path.join(os.tmpdir(), `relay-lock-${process.pid}-${Date.now()}`);
    const release = path.join(os.tmpdir(), `relay-release-${process.pid}-${Date.now()}`);
    const first = runRollout('ok', { async: true, pauseFile: release, lockFile: sharedLock });
    let second;
    let firstResult;
    try {
      await waitFor(() => fs.existsSync(path.join(first.work, 'health.started')));
      second = runRollout('ok', { lockFile: sharedLock });
      expect(second.status).not.toBe(0);
      expect(second.liveServer).toContain('base');
      expect(second.liveServer).not.toContain('target');
      expect(second.drainExists).toBe(false);
    } finally {
      write(release, 'release\n');
      firstResult = await first.done;
      firstResult.cleanup();
      second?.cleanup();
      fs.rmSync(sharedLock, { force: true });
      fs.rmSync(release, { force: true });
    }
    expect(firstResult.status).toBe(0);
    expect(firstResult.liveServer).toContain('target');
    expect(firstResult.drainExists).toBe(false);
  });
});
