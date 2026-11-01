const { spawnSync } = require('child_process');
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

function runRollout(health) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-relay-drain-'));
  const home = path.join(work, 'home');
  const live = path.join(home, 'file-agent');
  const stage = path.join(home, 'stage');
  const base = path.join(home, 'base');
  const bin = path.join(work, 'bin');
  const drainFile = path.join(work, 'drain.marker');
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
restarts=$(wc -l < "$WORK/restarts.log" 2>/dev/null || echo 0)
if [[ -e "$DRAIN_FILE" ]]; then gate=yes; else gate=no; fi
echo "curl restart=$restarts gate=$gate" >> "$WORK/curl.log"
case "${health}" in
  target-fails) [[ "$restarts" -ge 2 ]] && { echo '{"status":"ok"}'; exit 0; }; exit 1 ;;
  all-fail) exit 1 ;;
  *) echo '{"status":"ok"}'; exit 0 ;;
esac
`);
  executable(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n');

  const harness = path.join(work, 'remote.sh');
  write(harness, remote[1]);
  const result = spawnSync('bash', [...(process.env.DEBUG_ROLLOUT ? ['-x'] : []), harness], {
    encoding: 'utf8',
    env: {
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
    },
  });
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
    drainFile,
    liveServer: fs.readFileSync(path.join(live, 'server.mjs'), 'utf8'),
    restarts: fs.existsSync(path.join(work, 'restarts.log')) ? fs.readFileSync(path.join(work, 'restarts.log'), 'utf8') : '',
    curls: fs.existsSync(path.join(work, 'curl.log')) ? fs.readFileSync(path.join(work, 'curl.log'), 'utf8') : '',
    drainExists: fs.existsSync(drainFile),
    cleanup: () => fs.rmSync(work, { recursive: true, force: true }),
  };
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
});
