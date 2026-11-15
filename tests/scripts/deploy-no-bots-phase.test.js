const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'scripts', 'deploy.sh');
const DEPLOY_BOTS = path.join(ROOT, 'scripts', 'deploy-bots.sh');

test('deploy.sh не вызывает deploy-bots.sh', () => {
  assert.ok(!fs.readFileSync(DEPLOY, 'utf8').includes('deploy-bots.sh'));
});

test('в deploy.sh нет BOTS_RC, SKIP_BOTS и маркера PHASE 5', () => {
  const src = fs.readFileSync(DEPLOY, 'utf8');
  assert.ok(!src.includes('BOTS_RC'), 'BOTS_RC');
  assert.ok(!src.includes('SKIP_BOTS'), 'SKIP_BOTS');
  assert.ok(!src.includes('PHASE 5'), 'PHASE 5');
});

test('ручной scripts/deploy-bots.sh остаётся в репозитории', () => {
  assert.ok(fs.existsSync(DEPLOY_BOTS));
});

test('bash -n проходит для deploy.sh и deploy-bots.sh', () => {
  for (const file of [DEPLOY, DEPLOY_BOTS]) {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});
