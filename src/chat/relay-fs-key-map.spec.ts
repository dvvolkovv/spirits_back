import { spawnSync } from 'child_process';
import { createHmac } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { linkeonRelayFields } from './linkeon-relay-fields';
import { relayFsKeyMap } from './relay-fs-key-map';

// Карта «ключ сессии → fs_key» для разовой чистки номера на релее
// (scripts/relay-scrub-phone.mjs; спека 2026-11-02-pii-out-of-prompts-design,
// п. 5). Соль есть только на проде — карту считает он, той же функцией, что
// даёт fs_key ходам. Номер в ключах — только тестовый.
const KEYS = ['70000000000_14_ru', '70000000000_14', '+70000000000_12_en'];
const SALT = 'тестовая соль';
const hmac = (key: string) => createHmac('sha256', SALT).update(key).digest('hex').slice(0, 32);

describe('relayFsKeyMap', () => {
  const saved = { salt: process.env.RELAY_FS_SALT, jwt: process.env.JWT_SECRET };
  const restore = (name: 'RELAY_FS_SALT' | 'JWT_SECRET', value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  beforeEach(() => {
    process.env.RELAY_FS_SALT = SALT;
    process.env.JWT_SECRET = 'jwt-тест';
  });
  afterEach(() => {
    restore('RELAY_FS_SALT', saved.salt);
    restore('JWT_SECRET', saved.jwt);
  });

  it('строка на ключ: ключ<TAB>fs_key — тот же fs_key, что бэк шлёт релею', () => {
    const r = relayFsKeyMap(KEYS.join('\n') + '\n');
    expect(r.lines).toEqual(KEYS.map((k) => `${k}\t${linkeonRelayFields('u1', k).fs_key}`));
    expect(r.lines).toEqual(KEYS.map((k) => `${k}\t${hmac(k)}`));
    expect(r).toMatchObject({ keys: 3, skipped: 0 });
  });

  it('пустые строки и \\r не мешают; ключ с табом и повтор — пропущены и посчитаны', () => {
    const r = relayFsKeyMap(`\n${KEYS[0]}\r\n\n${KEYS[0]}\nс\tтабом\n`);
    expect(r.lines).toEqual([`${KEYS[0]}\t${hmac(KEYS[0])}`]);
    expect(r).toMatchObject({ keys: 1, skipped: 2 });
  });

  it('без RELAY_FS_SALT и JWT_SECRET fs_key нет — ключи пропущены', () => {
    delete process.env.RELAY_FS_SALT;
    delete process.env.JWT_SECRET;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(relayFsKeyMap(KEYS.join('\n'))).toMatchObject({ lines: [], keys: 0, skipped: 3 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('scripts/relay-fs-key-map.ts', () => {
  const repo = path.resolve(__dirname, '../..');
  const run = (cwd: string, input: string) =>
    spawnSync(
      process.execPath,
      [require.resolve('ts-node/dist/bin'), '-P', path.join(repo, 'tsconfig.json'), path.join(repo, 'scripts/relay-fs-key-map.ts')],
      // Соль — только из .env рабочего каталога, не из окружения теста.
      { cwd, input, encoding: 'utf8', env: { PATH: process.env.PATH, TS_NODE_TRANSPILE_ONLY: '1' } },
    );

  it('stdin → stdout «ключ<TAB>fs_key», соль из .env; в stderr одна строка счётчиков', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fs-key-map-'));
    try {
      fs.writeFileSync(path.join(dir, '.env'), `RELAY_FS_SALT=${SALT}\nJWT_SECRET=jwt-тест\n`);
      const r = run(dir, KEYS.join('\n') + '\n');
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(KEYS.map((k) => `${k}\t${hmac(k)}\n`).join(''));
      expect(r.stderr.trim().split('\n')).toEqual([expect.stringMatching(/ключей 3, пропущено 0; соль — RELAY_FS_SALT$/)]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('без соли — код 2 и ни строки в stdout', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-fs-key-map-'));
    try {
      const r = run(dir, KEYS.join('\n') + '\n');
      expect(r.status).toBe(2);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/нет ни RELAY_FS_SALT, ни JWT_SECRET/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
