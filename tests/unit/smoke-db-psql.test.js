/**
 * DB-чек смоука (smoke/db-psql.js): строка подключения к базе берётся на
 * сервере — DATABASE_URL из .env бэкенда — и не попадает ни в репозиторий,
 * ни в аргументы ssh.
 *
 * ssh здесь поддельный: пишет свои аргументы в файл и исполняет удалённую
 * команду локальным bash. psql тоже поддельный: сохраняет полученную строку
 * подключения и SQL. Так проверяется ровно то, что исполнит удалённый шелл,
 * вместе с кавычками и спецсимволами в пароле.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { sshPsql, sshArgs, remotePsqlCommand, backEnvFile } = require('../smoke/db-psql');

// Всё, что ломает наивную подстановку в шелл: $, кавычки, пробел, \, ;
const NASTY = "postgresql://linkeon:p$a'ss\" w\\d;x`y@localhost:5433/linkeon";
const PLAIN = 'postgresql://linkeon:s3cret@localhost:5433/linkeon';

let dir;
let saved;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-db-psql-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'home', 'spirits_back'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'bin', 'psql'),
    '#!/bin/sh\nprintf %s "$1" > "$OUT/dsn"\ncat > "$OUT/sql"\necho 42\n',
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(dir, 'bin', 'ssh'),
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$OUT/ssh-args"\nfor last; do :; done\nexec bash -c "$last"\n',
    { mode: 0o755 },
  );
  saved = { PATH: process.env.PATH, OUT: process.env.OUT };
  process.env.PATH = `${path.join(dir, 'bin')}:${saved.PATH}`;
  process.env.OUT = dir;
});

afterEach(() => {
  process.env.PATH = saved.PATH;
  if (saved.OUT === undefined) delete process.env.OUT;
  else process.env.OUT = saved.OUT;
  fs.rmSync(dir, { recursive: true, force: true });
});

const backPath = () => path.join(dir, 'home', 'spirits_back');
const writeEnv = (text) => fs.writeFileSync(path.join(backPath(), '.env'), text);
const got = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
const psqlCalled = () => fs.existsSync(path.join(dir, 'dsn'));

/** Удалённая команда как её исполнит шелл сервера, с HOME = временный каталог. */
function runRemote(cmd, input) {
  return spawnSync('bash', ['-c', cmd], {
    input,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, OUT: dir, HOME: path.join(dir, 'home') },
  });
}

describe('sshPsql: строка подключения из .env сервера', () => {
  test('DATABASE_URL доходит до psql байт в байт, SQL — через stdin', () => {
    writeEnv(`PORT=3001\nDATABASE_URL=${NASTY}\nREDIS_URL=redis://localhost:6379\n`);
    const out = sshPsql('SELECT 1;', { target: 'dv@85.192.61.231', backPath: backPath(), pgDsn: '' });
    expect(out).toBe('42');
    expect(got('dsn')).toBe(NASTY);
    expect(got('sql')).toBe('SELECT 1;');
  });

  test('строки подключения нет в аргументах ssh', () => {
    writeEnv(`DATABASE_URL=${PLAIN}\n`);
    sshPsql('SELECT 1;', { target: 'dv@85.192.61.231', backPath: backPath(), pgDsn: '' });
    const args = got('ssh-args');
    expect(args).not.toContain('s3cret');
    expect(args).not.toContain('postgresql://');
  });

  test('по умолчанию читает ~/spirits_back/.env на сервере', () => {
    writeEnv(`DATABASE_URL=${PLAIN}\n`);
    const r = runRemote(remotePsqlCommand({ envFile: backEnvFile(undefined), withDsn: false }), 'SELECT 1;');
    expect(r.status).toBe(0);
    expect(got('dsn')).toBe(PLAIN);
  });

  test('форма строки — как её понимает dotenv, которым .env читает API', () => {
    const cases = [
      `DATABASE_URL="${PLAIN}"`,
      `DATABASE_URL='${PLAIN}'`,
      `export DATABASE_URL=${PLAIN}`,
      `  DATABASE_URL = ${PLAIN}  `,
    ];
    for (const line of cases) {
      writeEnv(`${line}\n`);
      const r = runRemote(remotePsqlCommand({ envFile: backEnvFile(backPath()), withDsn: false }), 'SELECT 1;');
      expect({ line, status: r.status, dsn: got('dsn') }).toEqual({ line, status: 0, dsn: PLAIN });
    }
  });

  test('из нескольких DATABASE_URL берётся последняя, закомментированная не в счёт — как у dotenv', () => {
    // Сценарий смены пароля: новую строку дописали в конец, старую не стёрли.
    // API (dotenv) возьмёт последнюю — смоук обязан взять её же.
    writeEnv(`DATABASE_URL=postgresql://linkeon:old@localhost:5433/linkeon\nDATABASE_URL=${PLAIN}\n# DATABASE_URL=postgresql://x:y@z/w\n`);
    const r = runRemote(remotePsqlCommand({ envFile: backEnvFile(backPath()), withDsn: false }), 'SELECT 1;');
    expect(r.status).toBe(0);
    expect(got('dsn')).toBe(PLAIN);
  });

  test('нет DATABASE_URL — понятный отказ, psql не вызывается', () => {
    writeEnv('PORT=3001\n');
    const r = runRemote(remotePsqlCommand({ envFile: backEnvFile(backPath()), withDsn: false }), 'SELECT 1;');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('нет DATABASE_URL');
    expect(psqlCalled()).toBe(false);
  });

  test('нет самого .env — тот же понятный отказ', () => {
    const r = runRemote(remotePsqlCommand({ envFile: backEnvFile(path.join(dir, 'nope')), withDsn: false }), 'SELECT 1;');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('нет DATABASE_URL');
    expect(psqlCalled()).toBe(false);
  });

  test('отказ sshPsql — исключение с причиной с сервера и без строки подключения', () => {
    writeEnv(`PORT=3001\n# DATABASE_URL=${PLAIN}\n`);
    let err;
    try {
      sshPsql('SELECT 1;', { target: 'dv@85.192.61.231', backPath: backPath(), pgDsn: '' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.message).toContain('нет DATABASE_URL');
    expect(err.message).toContain('dv@85.192.61.231');
    expect(err.message).not.toContain('s3cret');
  });
});

describe('sshPsql: ручное переопределение PG_DSN', () => {
  test('PG_DSN едет первой строкой stdin, а не аргументом ssh', () => {
    const out = sshPsql('SELECT 2;', { target: 'dv@85.192.61.231', backPath: backPath(), pgDsn: NASTY });
    expect(out).toBe('42');
    expect(got('dsn')).toBe(NASTY);
    expect(got('sql')).toBe('SELECT 2;');
    expect(got('ssh-args')).not.toContain('linkeon:p');
  });
});

describe('аргументы ssh и путь к .env', () => {
  test('SSH_TARGET режется по пробелам, как его прежде резал шелл', () => {
    expect(sshArgs('-p 2222 dv@host', 'CMD')).toEqual([
      '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-p', '2222', 'dv@host', 'CMD',
    ]);
  });

  test('каталог бэкенда: BACK_PATH, иначе ~/spirits_back; ~ раскрывает удалённый шелл', () => {
    expect(backEnvFile(undefined)).toBe('$HOME/spirits_back/.env');
    expect(backEnvFile('')).toBe('$HOME/spirits_back/.env');
    expect(backEnvFile('/home/dvolkov/spirits_back')).toBe('/home/dvolkov/spirits_back/.env');
    expect(backEnvFile('~/spirits_back')).toBe('$HOME/spirits_back/.env');
  });
});
