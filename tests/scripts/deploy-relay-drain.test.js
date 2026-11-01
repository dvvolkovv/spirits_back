const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy-relay.sh');
const source = fs.readFileSync(DEPLOY, 'utf8');
const remote = source.match(/<<'REMOTE'\n([\s\S]*?)\nREMOTE\n/);
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
  const nginxConf = path.join(work, 'parking.conf');
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
  write(nginxConf, 'server {\n  location /chat { proxy_pass http://127.0.0.1:3033/chat; }\n  location /health { proxy_pass http://127.0.0.1:3033/health; }\n}\n');
  if (['legacy', 'legacy-upload', 'target-fails'].includes(health)) {
    write(path.join(work, 'old-worker-alive'), '4243\n');
  }

  executable(path.join(bin, 'sudo'), '#!/usr/bin/env bash\nexec "$@"\n');
  executable(path.join(bin, 'nginx'), `#!/usr/bin/env bash
if [[ "$1" == -t ]]; then exit 0; fi
if [[ "$1" == -s && "$2" == reload ]]; then
  if grep -q LINKEON-RELAY-DRAIN "$NGINX_CONF"; then
    touch "$WORK/nginx-gate-on"
    echo "reload gate=on" >> "$WORK/nginx.log"
    if [[ "${health}" != legacy-upload ]]; then rm -f "$WORK/old-worker-alive"; fi
  else
    rm -f "$WORK/nginx-gate-on"
    echo "reload gate=off" >> "$WORK/nginx.log"
  fi
  exit 0
fi
exit 2
`);

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
if [[ "$1" == -p ]]; then
  if [[ -e "$WORK/old-worker-alive" ]]; then
    echo "worker-check alive" >> "$WORK/worker.log"
    echo "$2"
    exit 0
  fi
  echo "worker-check exited" >> "$WORK/worker.log"
  exit 1
fi
if [[ "$1" == -eo ]]; then
  if [[ -e "$WORK/old-worker-alive" ]]; then
    master=$(cat /var/run/nginx.pid)
    echo "4243 $master nginx"
  fi
  exit 0
fi
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
url="$*"
if [[ "$url" == */chat ]]; then
  if [[ -e "$WORK/nginx-gate-on" || -e "$DRAIN_FILE" ]]; then code=503; else code=403; fi
  echo "chat restart=$restarts code=$code" >> "$WORK/curl.log"
  printf '%s' "$code"
  exit 0
fi
if [[ -e "$DRAIN_FILE" ]]; then gate=yes; else gate=no; fi
if [[ -e "$WORK/nginx-gate-on" ]]; then nginx=on; else nginx=off; fi
echo "curl restart=$restarts gate=$gate nginx=$nginx" >> "$WORK/curl.log"
case "${health}" in
  inflight-then-zero)
    calls=$(cat "$WORK/inflight-calls" 2>/dev/null || echo 0)
    calls=$((calls + 1))
    echo "$calls" > "$WORK/inflight-calls"
    if [[ "$calls" -eq 1 ]]; then echo '{"status":"ok","inflight":1}'; else echo '{"status":"ok","inflight":0}'; fi
    exit 0 ;;
  target-fails)
    if [[ "$restarts" -eq 0 || "$restarts" -ge 2 ]]; then echo '{"status":"ok"}'; exit 0; fi
    exit 1 ;;
  all-fail)
    if [[ "$restarts" -eq 0 ]]; then echo '{"status":"ok","inflight":0}'; exit 0; fi
    exit 1 ;;
  legacy) echo '{"status":"ok"}'; exit 0 ;;
  legacy-upload) echo '{"status":"ok"}'; exit 0 ;;
  *) echo '{"status":"ok","inflight":0}'; exit 0 ;;
esac
`);
  executable(path.join(bin, 'sleep'), `#!/usr/bin/env bash
if [[ "${health}" == legacy-upload && -e "$WORK/old-worker-alive" ]]; then
  rm -f "$WORK/old-worker-alive"
  echo "upload-finished" >> "$WORK/worker.log"
fi
exit 0
`);

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
    DRAIN_WAIT_SECONDS: '10',
    LOCK_FILE: lockFile,
    NGINX_CONF: nginxConf,
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
      nginx: fs.existsSync(path.join(work, 'nginx.log')) ? fs.readFileSync(path.join(work, 'nginx.log'), 'utf8') : '',
      worker: fs.existsSync(path.join(work, 'worker.log')) ? fs.readFileSync(path.join(work, 'worker.log'), 'utf8') : '',
      oldWorkerAlive: fs.existsSync(path.join(work, 'old-worker-alive')),
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
      expect(r.curls).toContain('chat restart=0 code=503');
      expect(r.curls).toContain('restart=2 gate=yes nginx=on');
      expect(r.nginx).toContain('reload gate=on');
      expect(r.nginx).toContain('reload gate=off');
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
      expect(r.curls.match(/restart=0 gate=yes/g) || []).toHaveLength(1);
      expect(r.curls).toContain('restart=0 gate=no');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('legacy upgrade блокирует /chat через Nginx ещё до replacement', () => {
    const r = runRollout('legacy');
    try {
      expect(r.status).toBe(0);
      expect(r.curls).toContain('chat restart=0 code=503');
      expect(r.curls).toContain('chat restart=1 code=403');
      expect(r.nginx).toContain('reload gate=on');
      expect(r.nginx).toContain('reload gate=off');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('legacy upload до drain завершается старым Nginx worker до replacement', () => {
    const r = runRollout('legacy-upload');
    try {
      expect(r.status).toBe(0);
      expect(r.worker.match(/worker-check alive/g) || []).toHaveLength(1);
      expect(r.worker).toContain('upload-finished');
      expect(r.worker).toContain('worker-check exited');
      expect(r.oldWorkerAlive).toBe(false);
      expect(r.curls).toContain('chat restart=0 code=503');
      expect(r.curls).toContain('chat restart=1 code=403');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

});
