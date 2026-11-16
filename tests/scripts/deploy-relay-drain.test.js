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
    // staging-фаза deploy-relay.sh обязана запускать живой write-gate;
    // в симуляции его заменяет проходящий заглушечный test.
    write(path.join(dir, 'sandbox-write-live.test.mjs'), passingTest);
  }
  write(path.join(live, 'server.mjs'), baseServer);
  write(path.join(base, 'server.mjs'), baseServer);
  write(path.join(stage, 'server.mjs'), targetServer);
  fs.mkdirSync(path.join(live, 'node_modules'));
  write(nginxConf, `server {
    # Agent output files — direct download
    location /files/ {
        alias /tmp/agent-output/;
        add_header Access-Control-Allow-Origin "*" always;
    }
  location /chat { proxy_pass http://127.0.0.1:3033/chat; }
  location /health { proxy_pass http://127.0.0.1:3033/health; }
}
`);
  if (['legacy', 'legacy-upload', 'target-fails'].includes(health)) {
    write(path.join(work, 'old-worker-alive'), '4243\n');
  }
  // Сценарий inflight-seq: значения inflight в health по очереди, по одному на вызов.
  if (options.inflightSeq) {
    write(path.join(work, 'inflight-seq'), options.inflightSeq.map((n) => `${n}\n`).join(''));
  }
  // Сценарий children-seq: число процессов CLI у file-agent по очереди, по одному на вызов ps --ppid.
  if (options.childrenSeq) {
    write(path.join(work, 'children-seq'), options.childrenSeq.map((n) => `${n}\n`).join(''));
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
if [[ "$1" == pid ]]; then
  # PM2_PID_AFTER_FIRST: PM2 перезапустил file-agent во время ожидания —
  # первый запрос pid видит прежний процесс, следующие — новый.
  if [[ -n "$PM2_PID_AFTER_FIRST" && -e "$WORK/pm2-pid-asked" ]]; then echo "$PM2_PID_AFTER_FIRST"; exit 0; fi
  touch "$WORK/pm2-pid-asked"
  echo 4242
  exit 0
fi
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
if [[ -f "$WORK/children-seq" ]]; then
  c=$(head -n 1 "$WORK/children-seq" 2>/dev/null || true)
  if [[ -n "$c" ]]; then
    tail -n +2 "$WORK/children-seq" > "$WORK/children-seq.next"
    mv "$WORK/children-seq.next" "$WORK/children-seq"
  else
    c=0
  fi
  # В общий журнал с inflight — чтобы видеть порядок проверок; $2 — pid из ps --ppid.
  echo "children=$c ppid=$2 gate=$gate" >> "$WORK/inflight.log"
  for ((i = 0; i < c; i++)); do echo "$((9000 + i))"; done
fi
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
# FOREIGN_MARKER_AT=n: на n-м вызове health кто-то вручную ставит свой
# marker (аварийный drain) — уже после того, как gate этого вызова посчитан.
if [[ -n "$FOREIGN_MARKER_AT" ]]; then
  hc=$(cat "$WORK/health-calls" 2>/dev/null || echo 0)
  hc=$((hc + 1))
  echo "$hc" > "$WORK/health-calls"
  if [[ "$hc" -eq "$FOREIGN_MARKER_AT" ]]; then printf 'foreign\n' > "$DRAIN_FILE"; fi
fi
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
  inflight-seq)
    n=$(head -n 1 "$WORK/inflight-seq" 2>/dev/null || true)
    if [[ -n "$n" ]]; then
      tail -n +2 "$WORK/inflight-seq" > "$WORK/inflight-seq.next"
      mv "$WORK/inflight-seq.next" "$WORK/inflight-seq"
    else
      n=0
    fi
    echo "inflight=$n gate=$gate" >> "$WORK/inflight.log"
    # Элемент fail — health в этот раз не ответил.
    if [[ "$n" == fail ]]; then exit 1; fi
    printf '{"status":"ok","inflight":%s}' "$n"
    exit 0 ;;
  inflight-by-gate)
    if [[ "$gate" == yes ]]; then n=$INFLIGHT_GATED; else n=$INFLIGHT_OPEN; fi
    echo "inflight=$n gate=$gate" >> "$WORK/inflight.log"
    printf '{"status":"ok","inflight":%s}' "$n"
    exit 0 ;;
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
    ...(options.env || {}),
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
      inflight: fs.existsSync(path.join(work, 'inflight.log'))
        ? fs.readFileSync(path.join(work, 'inflight.log'), 'utf8').trim().split('\n')
        : [],
      nginx: fs.existsSync(path.join(work, 'nginx.log')) ? fs.readFileSync(path.join(work, 'nginx.log'), 'utf8') : '',
      nginxConfig: fs.readFileSync(nginxConf, 'utf8'),
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
  it('отдаёт /files/ через relay proxy вместо Nginx alias в закрытые каталоги', () => {
    const r = runRollout('ok');
    try {
      expect(r.status).toBe(0);
      expect(r.nginxConfig).toContain('# LINKEON-RELAY-FILES-PROXY');
      expect(r.nginxConfig).toContain('proxy_pass http://127.0.0.1:3033;');
      expect(r.nginxConfig).toContain('proxy_hide_header Access-Control-Allow-Origin;');
      expect(r.nginxConfig).not.toContain('alias /tmp/agent-output/;');
      expect(r.nginxConfig.match(/add_header Access-Control-Allow-Origin/g) || []).toHaveLength(1);
    } finally {
      r.cleanup();
    }
  });

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

  it('RELAY_DRAIN_MODE=gate: шлагбаум сразу, ждёт и in-flight counter, и PM2 children до replacement/restart', () => {
    const r = runRollout('inflight-then-zero', { env: { RELAY_DRAIN_MODE: 'gate' } });
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

describe('deploy-relay: сначала тишина, потом короткий шлагбаум (RELAY_DRAIN_MODE=quiet)', () => {
  it('ход идёт — ждёт тишины без шлагбаума; шлагбаум ставится, только когда тихо', () => {
    const r = runRollout('inflight-seq', { inflightSeq: [2, 1, 0, 0] });
    try {
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.inflight).toEqual([
        'inflight=2 gate=no', // INITIAL_INFLIGHT: релей не legacy
        'inflight=1 gate=no', // фаза 1: ход идёт, шлагбаума нет
        'inflight=0 gate=no', // фаза 1: тишина
        'inflight=0 gate=yes', // фаза 2: под шлагбаумом по-прежнему тихо
        'inflight=0 gate=yes', // health после рестарта
      ]);
      expect(r.restarts).toBe('restart gate=yes\n');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('ход проскочил под шлагбаум и не кончился за окно — шлагбаум снят, ожидание тишины заново', () => {
    const r = runRollout('inflight-seq', {
      inflightSeq: [0, 0, 1, 0, 0],
      env: { DRAIN_GATE_WINDOW_SECONDS: '0' },
    });
    try {
      expect(r.status).toBe(0);
      expect(r.inflight).toEqual([
        'inflight=0 gate=no',
        'inflight=0 gate=no',
        'inflight=1 gate=yes', // проскочил; окно 0 с — шлагбаум снимается сразу
        'inflight=0 gate=no', // снова фаза 1, шлагбаума нет
        'inflight=0 gate=yes',
        'inflight=0 gate=yes', // health после рестарта
      ]);
      expect(r.stderr).toContain('снова ждём тишины');
      expect(r.restarts).toBe('restart gate=yes\n');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('чужой marker появился, пока ждали тишины, — выход 1, marker не затёрт и не снят, замены нет', () => {
    const r = runRollout('inflight-seq', {
      inflightSeq: [1, 1, 0],
      env: { FOREIGN_MARKER_AT: '2' },
    });
    try {
      expect(r.status).toBe(1);
      expect(r.inflight).toEqual([
        'inflight=1 gate=no', // INITIAL_INFLIGHT
        'inflight=1 gate=no', // фаза 1: ход идёт; в этот момент кто-то ставит свой marker
        'inflight=0 gate=yes', // фаза 1: тихо, но marker уже чужой
      ]);
      expect(r.stderr).toContain('marker');
      expect(r.drainExists).toBe(true);
      expect(fs.readFileSync(r.drainFile, 'utf8').trim()).toBe('foreign');
      expect(r.restarts).toBe('');
      expect(r.liveServer).toContain('base');
    } finally {
      r.cleanup();
    }
  });

  it('под шлагбаумом тихо не становится до конца ожидания — выход 1, замены нет, шлагбаум снят', () => {
    const r = runRollout('inflight-by-gate', {
      env: { INFLIGHT_OPEN: '0', INFLIGHT_GATED: '1', DRAIN_GATE_WINDOW_SECONDS: '0', DRAIN_WAIT_SECONDS: '0' },
    });
    try {
      expect(r.status).toBe(1);
      expect(r.inflight).toEqual(['inflight=0 gate=no', 'inflight=0 gate=no', 'inflight=1 gate=yes']);
      expect(r.stderr).toContain('не дождались');
      expect(r.restarts).toBe('');
      expect(r.liveServer).toContain('base');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('тишины нет совсем — выход 1 без шлагбаума, без рестарта, база живая', () => {
    const r = runRollout('inflight-by-gate', {
      env: { INFLIGHT_OPEN: '1', INFLIGHT_GATED: '1', DRAIN_WAIT_SECONDS: '0' },
    });
    try {
      expect(r.status).toBe(1);
      expect(r.inflight).toEqual(['inflight=1 gate=no', 'inflight=1 gate=no']);
      expect(r.stderr).toContain('не дождались');
      expect(r.restarts).toBe('');
      expect(r.liveServer).toContain('base');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it.each([
    ['RELAY_DRAIN_MODE', 'bogus'],
    ['DRAIN_GATE_WINDOW_SECONDS', '9x'],
    // Ведущий ноль bash в (( )) читает как восьмеричное: 090 — ошибка, 010 — 8 с.
    ['DRAIN_GATE_WINDOW_SECONDS', '090'],
    ['DRAIN_WAIT_SECONDS', 'x5'],
  ])('%s=%s — выход 2 до любых изменений на релее', (name, value) => {
    const r = runRollout('ok', { env: { [name]: value } });
    try {
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(name);
      expect(r.restarts).toBe('');
      expect(r.liveServer).toContain('base');
      expect(r.nginxConfig).toContain('alias /tmp/agent-output/;');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('неверный RELAY_DRAIN_MODE останавливает скрипт ещё на маке — до git и ssh', () => {
    const r = spawnSync('bash', [DEPLOY, 'no-such-base', 'no-such-target'], {
      encoding: 'utf8',
      env: { ...process.env, RELAY_DRAIN_MODE: 'bogus' },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('RELAY_DRAIN_MODE');
  });

  it('режим и окно шлагбаума уезжают на релей в ssh-вызове', () => {
    const line = source.split('\n').find((l) => l.startsWith('tar -cf - -C "$LOCAL_BUNDLE"'));
    expect(line).toContain('RELAY_DRAIN_MODE=$RELAY_DRAIN_MODE');
    expect(line).toContain('DRAIN_GATE_WINDOW_SECONDS=$DRAIN_GATE_WINDOW_SECONDS');
  });

  it('процессы CLI ещё идут — шлагбаума нет; он ставится, только когда их не осталось', () => {
    const r = runRollout('inflight-seq', { childrenSeq: [1, 1, 0] });
    try {
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.inflight).toEqual([
        'inflight=0 gate=no', // INITIAL_INFLIGHT
        'children=1 ppid=4242 gate=no', // фаза 1: процесс CLI идёт, шлагбаума нет
        'children=1 ppid=4242 gate=no',
        'children=0 ppid=4242 gate=no', // фаза 1: процессов нет...
        'inflight=0 gate=no', // ...и принятых запросов нет — тихо
        'children=0 ppid=4242 gate=yes', // фаза 2: под шлагбаумом по-прежнему тихо
        'inflight=0 gate=yes',
        'inflight=0 gate=yes', // health после рестарта
      ]);
      expect(r.restarts).toBe('restart gate=yes\n');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('PM2 перезапустил file-agent во время ожидания — процессы CLI ищутся у нового pid', () => {
    const r = runRollout('inflight-seq', { childrenSeq: [1, 0], env: { PM2_PID_AFTER_FIRST: '4343' } });
    try {
      expect(r.status).toBe(0);
      expect(r.inflight.filter((l) => l.startsWith('children='))).toEqual([
        'children=1 ppid=4343 gate=no',
        'children=0 ppid=4343 gate=no',
        'children=0 ppid=4343 gate=yes',
      ]);
      expect(r.restarts).toBe('restart gate=yes\n');
    } finally {
      r.cleanup();
    }
  });

  it('health не ответил во время ожидания — это не тишина: шлагбаума в этот момент нет, выкат доходит до конца', () => {
    const r = runRollout('inflight-seq', { inflightSeq: [0, 'fail', 0, 0] });
    try {
      expect(r.status).toBe(0);
      expect(r.inflight).toEqual([
        'inflight=0 gate=no', // INITIAL_INFLIGHT
        'inflight=fail gate=no', // фаза 1: health не ответил — не тихо
        'inflight=0 gate=no', // фаза 1: тихо
        'inflight=0 gate=yes', // фаза 2
        'inflight=0 gate=yes', // health после рестарта
      ]);
      expect(r.stderr).toContain('health релея не ответил');
      expect(r.restarts).toBe('restart gate=yes\n');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('ход проскочил под шлагбаум и кончился внутри окна — одна сессия шлагбаума, один рестарт', () => {
    const r = runRollout('inflight-seq', { inflightSeq: [0, 0, 1, 1, 0] });
    try {
      expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
      expect(r.inflight).toEqual([
        'inflight=0 gate=no',
        'inflight=0 gate=no', // фаза 1: тихо
        'inflight=1 gate=yes', // проскочил; окно по умолчанию — ждём под шлагбаумом
        'inflight=1 gate=yes',
        'inflight=0 gate=yes', // закончился внутри окна
        'inflight=0 gate=yes', // health после рестарта
      ]);
      expect(r.restarts).toBe('restart gate=yes\n');
      expect(r.liveServer).toContain('target');
      expect(r.drainExists).toBe(false);
    } finally {
      r.cleanup();
    }
  });

  it('legacy: чужой marker к моменту шлагбаума — выход 1, marker не тронут, nginx не закрыт', () => {
    // Первый вызов health — INITIAL_INFLIGHT, уже после проверки marker в начале.
    const r = runRollout('legacy', { env: { FOREIGN_MARKER_AT: '1' } });
    try {
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('marker');
      expect(r.drainExists).toBe(true);
      expect(fs.readFileSync(r.drainFile, 'utf8').trim()).toBe('foreign');
      expect(r.nginxConfig).not.toContain('LINKEON-RELAY-DRAIN');
      expect(r.restarts).toBe('');
      expect(r.liveServer).toContain('base');
    } finally {
      r.cleanup();
    }
  });

  it.each([
    ['DRAIN_GATE_WINDOW_SECONDS', '090'],
    ['DRAIN_WAIT_SECONDS', 'x5'],
  ])('%s=%s отвергается ещё на маке — выход 2 до git и ssh', (name, value) => {
    const r = spawnSync('bash', [DEPLOY, 'no-such-base', 'no-such-target'], {
      encoding: 'utf8',
      env: { ...process.env, [name]: value },
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain(name);
  });

  it('окно шлагбаума по умолчанию — 45 с, и на маке, и на релее', () => {
    const fallback = 'DRAIN_GATE_WINDOW_SECONDS=${DRAIN_GATE_WINDOW_SECONDS:-45}';
    expect(source.split(fallback).length - 1).toBe(2);
  });
});
