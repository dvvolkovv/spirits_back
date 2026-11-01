const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');

function scriptFunctions() {
  const lines = fs.readFileSync(DEPLOY, 'utf8').split('\n');
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (!inside && /^[a-z_][a-z0-9_]*\(\) \{$/.test(line)) inside = true;
    if (inside) out.push(line);
    if (inside && line === '}') inside = false;
  }
  return out.join('\n');
}

const STUBS = String.raw`
LOG="$WORK/log"
bold() { echo "OUT: $1" >> "$LOG"; }
green() { echo "OUT: $1" >> "$LOG"; }
red() { echo "OUT: $1" >> "$LOG"; }
yellow() { echo "OUT: $1" >> "$LOG"; }
preflight_vantage() { :; }
ensure_debug_secret() { :; }
capture_pre_deploy_state() { :; }
deploy_backend() { :; }
deploy_frontend() { :; }
sync_test_basic_auth() { :; }
warm_chat_path() { :; }
smoke_frontend_tma() { :; }
smoke_security_headers() { :; }
rollback_phase() { echo rollback >> "$LOG"; }
bash() {
  if [[ "$1" == smoke/run.sh ]]; then
    echo standard-smoke >> "$LOG"
    return "$SMOKE_STATUS"
  fi
  if [[ "$1" == agent-versions.e2e.mjs ]]; then
    printf 'agent-e2e BASE_URL=%s BASIC_AUTH=%s SSH_TARGET=%s BACK_PATH=%s DEBUG_SECRET=%s RELAY_SSH_TARGET=%s\n' \
      "$BASE_URL" "$BASIC_AUTH" "$SSH_TARGET" "$BACK_PATH" "$DEBUG_SECRET" "$RELAY_SSH_TARGET" >> "$LOG"
    return "$AGENT_E2E_STATUS"
  fi
  echo "unexpected-bash $*" >> "$LOG"
  return 99
}
`;

function runPhase(phase, env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-e2e-deploy-'));
  fs.mkdirSync(path.join(work, 'tests'));
  const harness = path.join(work, 'harness.sh');
  fs.writeFileSync(harness, [
    'set -uo pipefail',
    scriptFunctions(),
    STUBS,
    `run_phase ${phase}`,
  ].join('\n'));
  const result = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      WORK: work,
      LOCAL_BACK_DIR: work,
      BASE_URL: 'https://test.example',
      BASIC_AUTH: 'test-user:test-pass',
      BACK_PATH: '/srv/back',
      SSH_TARGET: 'test-ssh',
      TEST_HOST: 'test-ssh',
      PROD_HOST: 'prod-ssh',
      TEST_BACK_PATH: '/srv/back',
      DEBUG_SECRET: 'dummy-debug-secret',
      SMOKE_STATUS: '0',
      AGENT_E2E_STATUS: '0',
      SMOKE_ATTEMPTS: '1',
      NO_ROLLBACK: '',
      SMOKE_ONLY: '',
      SKIP_SMOKE: '',
      SKIP_TEST_SMOKE: '',
      SKIP_PROD_SMOKE: '',
      FRONT_ONLY: '',
      BACK_ONLY: '',
      ...env,
    },
  });
  if (result.status !== 0) console.error(result.stderr);
  const log = fs.existsSync(path.join(work, 'log'))
    ? fs.readFileSync(path.join(work, 'log'), 'utf8')
    : '';
  fs.rmSync(work, { recursive: true, force: true });
  return { status: result.status, stderr: result.stderr, log };
}

describe('deploy.sh AGENT_VERSION_E2E', () => {
  it('не запускает agent E2E по умолчанию', () => {
    const r = runPhase('test');
    expect(r.status).toBe(0);
    expect(r.log).toContain('standard-smoke');
    expect(r.log).not.toContain('agent-e2e');
  });

  it('передаёт текущие auth/debug/relay значения после зелёного smoke', () => {
    const r = runPhase('test', { AGENT_VERSION_E2E: '1' });
    expect(r.status).toBe(0);
    expect(r.log).toContain('standard-smoke');
    expect(r.log).toContain('agent-e2e BASE_URL=https://test.example');
    expect(r.log).toContain('BASIC_AUTH=test-user:test-pass');
    expect(r.log).toContain('SSH_TARGET=test-ssh');
    expect(r.log).toContain('BACK_PATH=/srv/back');
    expect(r.log).toContain('DEBUG_SECRET=dummy-debug-secret');
    expect(r.log).toContain('RELAY_SSH_TARGET=dv@5.101.115.184');
    expect(r.log.indexOf('standard-smoke')).toBeLessThan(r.log.indexOf('agent-e2e'));
  });

  it('считает отказ E2E smoke failure и откатывает prod', () => {
    const r = runPhase('prod', { AGENT_VERSION_E2E: '1', AGENT_E2E_STATUS: '1' });
    expect(r.status).toBe(1);
    expect(r.log).toContain('agent versions E2E');
    expect(r.log).toContain('rollback');
  });
});
