import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-relay-bash32-'));
const bin = path.join(work, 'bin');
fs.mkdirSync(bin);
const sshLog = path.join(work, 'ssh-called');
fs.writeFileSync(path.join(bin, 'ssh'), `#!/bin/sh\ncat >/dev/null\nprintf called > "${sshLog}"\nexit 0\n`, { mode: 0o755 });

try {
  const result = spawnSync('/bin/bash', [
    path.join(root, 'scripts', 'deploy-relay.sh'),
    'd4786e918d6df2420daccaa2da67cfd651f37ac1',
    'HEAD',
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(fs.existsSync(sshLog), 'script stopped before streamed rollout');
  console.log('✓ deploy-relay empty arrays accepted by /bin/bash without remote effects');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

