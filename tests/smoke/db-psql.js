/**
 * DB-чек смоука: SQL исполняет psql на самом сервере, куда смотрит SSH_TARGET.
 * База слушает только loopback (на проде порт 5433 снаружи закрыт фаерволом).
 *
 * СТРОКА ПОДКЛЮЧЕНИЯ БЕРЁТСЯ НА СЕРВЕРЕ — DATABASE_URL из .env бэкенда этой
 * среды, то есть из того же файла, из которого её читает API. Отсюда:
 *   - пароля базы нет в репозитории (он публичный);
 *   - смена пароля смоук не ломает: правят .env — смоук читает новый.
 * Значение читает и подставляет удалённый шелл. В аргументах локального ssh
 * его нет — значит, нет ни в ps, ни в тексте ошибки, который уходит в лог
 * деплоя. (Прежняя версия держала строку с паролем прямо в команде ssh, и
 * любой отказ шага печатал её в лог.)
 *
 * Строку разбираем по правилам dotenv 16, которым .env читает API
 * (@nestjs/config): из нескольких DATABASE_URL побеждает ПОСЛЕДНЯЯ — так при
 * смене пароля строку дописывают в конец, не стерев старую, и API берёт новую;
 * допустимы `export ` и пробелы вокруг `=`; обёртывающие кавычки снимаются.
 * (ph_registry_probe в deploy.sh берёт первую строку — там это пока не важно.)
 *
 * Каталог бэкенда — BACK_PATH (deploy.sh экспортирует его для своей фазы),
 * иначе ~/spirits_back: на проде это /home/dvolkov/spirits_back, на
 * тест-стенде — /home/dv/spirits_back.
 *
 * PG_DSN — ручное переопределение строки. Едет первой строкой stdin, а не
 * аргументом ssh, — по той же причине.
 */
const { execFileSync } = require('child_process');

const DEFAULT_SSH_TARGET = 'dvolkov@212.113.106.202';

/** Путь к .env бэкенда на сервере; $HOME раскрывает удалённый шелл. */
function backEnvFile(backPath) {
  const dir = (backPath || '$HOME/spirits_back').replace(/^~(?=\/|$)/, '$HOME');
  return `${dir}/.env`;
}

/**
 * Команда для удалённого шелла. Секретов в ней нет: строка подключения либо
 * читается из .env там же, либо приходит первой строкой stdin (withDsn).
 * Остаток stdin — SQL для psql.
 */
function remotePsqlCommand({ envFile, withDsn }) {
  if (withDsn) return 'IFS= read -r U; psql "$U" -tAX';
  return [
    `U=$(sed -n -E 's/^[[:space:]]*(export[[:space:]]+)?DATABASE_URL[[:space:]]*=[[:space:]]*//p' "${envFile}"` +
      ` | tail -n 1 | sed -E -e 's/[[:space:]]+$//' -e 's/^"(.*)"$/\\1/' -e "s/^'(.*)'\\$/\\1/")`,
    `[ -n "$U" ] || { echo "нет DATABASE_URL в ${envFile} на $(hostname)" >&2; exit 2; }`,
    'psql "$U" -tAX',
  ].join('; ');
}

/** Аргументы ssh. SSH_TARGET режется по пробелам, как его прежде резал шелл. */
function sshArgs(target, remoteCmd) {
  return [
    '-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes',
    ...String(target).split(/\s+/).filter(Boolean),
    remoteCmd,
  ];
}

/**
 * Выполнить SQL на сервере и вернуть вывод `psql -tA`. SQL идёт через stdin —
 * без вложенных кавычек. ssh запускается без локального шелла (execFileSync),
 * поэтому слой кавычек один — удалённый. Отказ — исключение с причиной,
 * которую напечатала удалённая сторона.
 */
function sshPsql(sql, {
  target = process.env.SSH_TARGET || DEFAULT_SSH_TARGET,
  backPath = process.env.BACK_PATH,
  pgDsn = process.env.PG_DSN,
  timeout = 20000,
  env = process.env,
} = {}) {
  const withDsn = Boolean(pgDsn);
  const cmd = remotePsqlCommand({ envFile: backEnvFile(backPath), withDsn });
  try {
    return execFileSync('ssh', sshArgs(target, cmd), {
      input: withDsn ? `${pgDsn}\n${sql}` : sql,
      timeout,
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    const why = String(e.stderr || '').trim() || e.code || `exit ${e.status}`;
    throw new Error(`psql через ssh ${target}: ${why}`);
  }
}

module.exports = { sshPsql, sshArgs, remotePsqlCommand, backEnvFile, DEFAULT_SSH_TARGET };
