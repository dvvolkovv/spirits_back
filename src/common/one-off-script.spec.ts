import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { appendPrivateLine, requireRelayFsSalt, scriptErrorText, writePrivateFile } from './one-off-script';

/**
 * Разовые скрипты спеки 2026-11-02-pii-out-of-prompts-design.md (ревью ветки):
 * журналы и списки — только владельцу (600), солёный хэш — только на
 * RELAY_FS_SALT, ошибки в консоль — без запроса и метаданных.
 */
const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe('файлы разовых скриптов — только владельцу', () => {
  let dir: string;
  let oldMask: number;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'one-off-'));
    // Как у обычной оболочки: без явных прав файл вышел бы 644.
    oldMask = process.umask(0o022);
  });
  afterEach(() => {
    process.umask(oldMask);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writePrivateFile: новый файл — 600', () => {
    const f = path.join(dir, 'list.missing.txt');
    writePrivateFile(f, 'a\n');
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe('a\n');
  });

  it('writePrivateFile: прежний файл с 644 — тоже 600', () => {
    const f = path.join(dir, 'old.txt');
    fs.writeFileSync(f, 'x', { mode: 0o644 });
    writePrivateFile(f, 'y');
    expect(mode(f)).toBe(0o600);
  });

  it('appendPrivateLine: журнал — 600, строки дописываются', () => {
    const f = path.join(dir, 'journal.jsonl');
    appendPrivateLine(f, '{"a":1}');
    appendPrivateLine(f, '{"b":2}');
    expect(mode(f)).toBe(0o600);
    expect(fs.readFileSync(f, 'utf8')).toBe('{"a":1}\n{"b":2}\n');
  });

  it('appendPrivateLine: дописывание в прежний журнал с 644 делает его 600', () => {
    const f = path.join(dir, 'prev.jsonl');
    fs.writeFileSync(f, '{"a":1}\n', { mode: 0o644 });
    appendPrivateLine(f, '{"b":2}');
    expect(mode(f)).toBe(0o600);
  });
});

describe('requireRelayFsSalt', () => {
  const OLD = { salt: process.env.RELAY_FS_SALT, jwt: process.env.JWT_SECRET };
  const put = (k: string, v: string | undefined) => {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  };
  afterEach(() => {
    put('RELAY_FS_SALT', OLD.salt);
    put('JWT_SECRET', OLD.jwt);
  });

  it('без RELAY_FS_SALT — отказ, даже если есть JWT_SECRET', () => {
    put('RELAY_FS_SALT', undefined);
    put('JWT_SECRET', 'jwt-one-off-spec');
    expect(() => requireRelayFsSalt()).toThrow(/RELAY_FS_SALT/);
  });

  it('пустая соль — тоже отказ', () => {
    put('RELAY_FS_SALT', '   ');
    expect(() => requireRelayFsSalt()).toThrow(/RELAY_FS_SALT/);
  });

  it('с RELAY_FS_SALT — без отказа', () => {
    put('RELAY_FS_SALT', 'salt-one-off-spec');
    expect(() => requireRelayFsSalt()).not.toThrow();
  });
});

describe('scriptErrorText', () => {
  it('ошибка S3: сообщение и код — без метаданных запроса', () => {
    const e = Object.assign(new Error('Access Denied.'), {
      name: 'AccessDenied',
      Code: 'AccessDenied',
      $metadata: { httpStatusCode: 403, requestId: 'REQ-SECRET-ID' },
      $response: { headers: { authorization: 'AWS4-HMAC-SHA256 Credential=KEYID' } },
    });
    const text = scriptErrorText(e);
    expect(text).toBe('Access Denied. (AccessDenied)');
    expect(text).not.toContain('REQ-SECRET-ID');
    expect(text).not.toContain('Credential');
  });

  it('ошибка axios: без заголовков запроса', () => {
    const e = Object.assign(new Error('Request failed with status code 401'), {
      code: 'ERR_BAD_REQUEST',
      config: { headers: { 'xi-api-key': 'KEY-SHOULD-NOT-PRINT' } },
    });
    expect(scriptErrorText(e)).toBe('Request failed with status code 401 (ERR_BAD_REQUEST)');
  });

  it('обычная ошибка — только сообщение; не ошибка — строкой', () => {
    expect(scriptErrorText(new Error('нет RELAY_FS_SALT'))).toBe('нет RELAY_FS_SALT');
    expect(scriptErrorText('сбой')).toBe('сбой');
  });
});

// Сторож исходников: скрипты запускаются руками на проде, и тесты сами их не
// гоняют (jest ищет спеки только в src/).
describe('разовые скрипты спеки', () => {
  const read = (name: string) => fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', name), 'utf8');
  const SCRIPTS = ['rename-elevenlabs-voices.ts', 'migrate-voice-document-keys.ts', 'backfill-chat-files.ts'];

  it.each(SCRIPTS)('%s: umask 077 в начале, файлы — только через помощники 600, ошибка — без объекта', (name) => {
    const src = read(name);
    const umaskAt = src.indexOf('process.umask(0o077)');
    expect(umaskAt).toBeGreaterThan(-1);
    expect(umaskAt).toBeLessThan(src.indexOf('async function main'));
    expect(src).not.toMatch(/fs\.(appendFileSync|writeFileSync)\(/);
    expect(src).toContain('console.error(scriptErrorText(e))');
    expect(src).not.toMatch(/console\.error\(e\)/);
  });

  it.each(['migrate-voice-document-keys.ts', 'backfill-chat-files.ts'])('%s: соль — только RELAY_FS_SALT', (name) => {
    expect(read(name)).toContain('requireRelayFsSalt()');
  });
});
