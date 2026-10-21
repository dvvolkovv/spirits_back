/**
 * deploy.sh: проверка живых чат-ходов обязана стоять ПРЯМО ПЕРЕД pm2 restart,
 * а не только до сборки.
 *
 * 20.10.2026 выкат проверил «живых ходов нет», потом минуту делал git fetch,
 * npm ci и сборку, и только затем перезапустил API. Пользователь отправил
 * просьбу за 7 секунд до рестарта — ход оборвался молча, файл, который
 * ассистент для него сделал, так и не прикрепился.
 *
 * Тест гоняет настоящую deploy_backend из scripts/deploy.sh: функции скрипта
 * вырезаются из файла и подгружаются в bash, а ssh/curl/sleep подменяются
 * заглушками, которые пишут журнал вызовов. Проверяется порядок действий.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEPLOY = path.join(__dirname, '..', '..', 'scripts', 'deploy.sh');
const RUNNING_SHA = '1111111111111111111111111111111111111111';

/** Все многострочные функции скрипта: от `имя() {` до первой `}` в начале строки. */
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
LOG="$WORK/log"; STREAMS="$WORK/streams"
bold()   { echo "OUT: $1" >> "$LOG"; }
green()  { echo "OUT: $1" >> "$LOG"; }
red()    { echo "OUT: $1" >> "$LOG"; }
yellow() { echo "OUT: $1" >> "$LOG"; }
push_local_repo() { :; }
sleep() { :; }
# Очередь ответов active-streams: каждый вызов снимает первую строку,
# последняя повторяется бесконечно.
next_stream() {
  local n; n=$(head -1 "$STREAMS")
  if [ "$(wc -l < "$STREAMS")" -gt 1 ]; then tail -n +2 "$STREAMS" > "$STREAMS.t" && mv "$STREAMS.t" "$STREAMS"; fi
  echo "$n"
}
curl() {
  local url; for url; do :; done   # адрес — последний аргумент
  case "$url" in
    */webhook/chat/active-streams) local n; n=$(next_stream); echo "STREAMS: $n" >> "$LOG"; printf '{"active":%s}' "$n" ;;
    */webhook/voice-call-status/active) echo "CALLS: 0" >> "$LOG"; printf '{"active":0}' ;;
    *) printf 200 ;;
  esac
}
# Каждая строка для ssh — ещё и в свой файл: тест прогонит её через bash -n.
# Счётчик в файле: часть вызовов идёт из $(...), то есть из подоболочки.
ssh_remote() {
  local k; k=$(( $(cat "$WORK/n" 2>/dev/null || echo 0) + 1 )); echo "$k" > "$WORK/n"
  printf '%s' "$*" > "$WORK/ssh.$k"
  printf 'SSH: %s\n' "$(echo "$*" | tr '\n' ' ')" >> "$LOG"
  if [ "$*" = "cd $BACK_PATH && git rev-parse HEAD" ]; then
    [ -n "$NO_SHA" ] || echo "$RUNNING_SHA"
    return 0
  fi
  case "$*" in
    *"seq 1"*) echo "OK 1" ;;
    *"git reset --hard origin/"*) [ -n "$BUILD_FAILS" ] && return 1 ;;
  esac
  return 0
}
`;

/** Прогон deploy_backend; streams — ответы active-streams по порядку. */
function runDeployBackend(streams, env = {}) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-gate-'));
  fs.writeFileSync(path.join(work, 'streams'), streams.join('\n') + '\n');
  // Файлом, а не `bash -c`: функции скрипта больше 128 КБ — предела длины
  // одного аргумента в Linux (spawn падал бы с E2BIG).
  const harness = path.join(work, 'harness.sh');
  fs.writeFileSync(harness, [
    'set -uo pipefail',
    scriptFunctions(),
    STUBS,
    'deploy_backend',
  ].join('\n'));
  const res = spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      WORK: work,
      RUNNING_SHA,
      ENV_NAME: 'prod',
      BACK_PATH: '/srv/back',
      BRANCH: 'main',
      BASE_URL: 'https://example.test',
      BASIC_AUTH: '',
      LOCAL_BACK_DIR: '/nonexistent',
      HEALTH_WAIT_SECONDS: '3',
      NO_SHA: '',
      BUILD_FAILS: '',
      ...env,
    },
  });
  if (res.error) throw res.error;
  const log = fs.existsSync(path.join(work, 'log'))
    ? fs.readFileSync(path.join(work, 'log'), 'utf8').split('\n').filter(Boolean)
    : [];
  // Строки для ssh — как их получил бы сервер; bash -n ловит ошибки кавычек.
  const payloads = fs.readdirSync(work).filter((f) => /^ssh\.\d+$/.test(f)).map((f) => {
    const n = spawnSync('bash', ['-n', path.join(work, f)], { encoding: 'utf8' });
    return { text: fs.readFileSync(path.join(work, f), 'utf8'), syntaxOk: n.status === 0, err: n.stderr };
  });
  fs.rmSync(work, { recursive: true, force: true });
  return { status: res.status, stderr: res.stderr, log, payloads };
}

const indexOf = (log, re, from = 0) => {
  for (let i = from; i < log.length; i++) if (re.test(log[i])) return i;
  return -1;
};
const BUILD = /^SSH: .*npm run build/;
const RESTART = /^SSH: .*pm2 restart linkeon-api/;
const STREAMS = /^STREAMS: /;
const POLL = /^(STREAMS|CALLS): /;
const REVERT = new RegExp(`^SSH: .*git reset --hard ${RUNNING_SHA}.*npm run build`);

describe('deploy.sh: живые ходы проверяются прямо перед рестартом API', () => {
  it('функции скрипта подгружаются в bash без ошибок', () => {
    const r = runDeployBackend(['0']);
    expect(r.stderr).not.toMatch(/syntax error|command not found/);
  });

  it('первая проверка — до сборки: npm ci не трогает node_modules под живым ходом', () => {
    const { log } = runDeployBackend(['0']);
    const build = indexOf(log, BUILD);
    expect(build).toBeGreaterThan(-1);
    expect(indexOf(log, STREAMS)).toBeGreaterThan(-1);
    expect(indexOf(log, STREAMS)).toBeLessThan(build);
  });

  it('сборка и рестарт — разные шаги, и между ними ещё одна проверка ходов', () => {
    const { status, log } = runDeployBackend(['0']);
    expect(status).toBe(0);
    const build = indexOf(log, BUILD);
    const restart = indexOf(log, RESTART);
    expect(restart).toBeGreaterThan(build);
    expect(log[build]).not.toMatch(/pm2 restart/);
    expect(indexOf(log, STREAMS, build + 1)).toBeGreaterThan(build);
    expect(indexOf(log, STREAMS, build + 1)).toBeLessThan(restart);
  });

  it('ход, начатый во время сборки, дожидаются — рестарт только после него', () => {
    const { status, log } = runDeployBackend(['0', '1', '1', '0']);
    expect(status).toBe(0);
    const build = indexOf(log, BUILD);
    const restart = indexOf(log, RESTART);
    const waits = log.slice(build, restart).filter((l) => STREAMS.test(l));
    expect(waits).toEqual(['STREAMS: 1', 'STREAMS: 1', 'STREAMS: 0']);
    expect(log.slice(build, restart).join('\n')).toMatch(/ходов в полёте 1/);
  });

  it('если и перед рестартом ходы не кончились — рестарта нет, сборка возвращается к работающему коммиту, выход 1', () => {
    const { status, log } = runDeployBackend(['0', '1'], { STREAM_DRAIN_SECONDS: '30' });
    expect(status).toBe(1);
    expect(indexOf(log, RESTART)).toBe(-1);
    const build = indexOf(log, BUILD);
    const revert = indexOf(log, REVERT, build + 1);
    expect(revert).toBeGreaterThan(build);
    expect(log[revert]).not.toMatch(/pm2 (restart|startOrReload)/);
  });

  it('FORCE_RESTART=1 — без проверок, рестарт после сборки', () => {
    const { status, log } = runDeployBackend(['1'], { FORCE_RESTART: '1' });
    expect(status).toBe(0);
    expect(indexOf(log, STREAMS)).toBe(-1);
    expect(indexOf(log, RESTART)).toBeGreaterThan(indexOf(log, BUILD));
  });

  it('последний опрос перед рестартом — ходы: ожидание звонков (до 15 минут) идёт раньше', () => {
    const { log } = runDeployBackend(['0']);
    const restart = indexOf(log, RESTART);
    const polls = log.slice(indexOf(log, BUILD), restart).filter((l) => POLL.test(l));
    expect(polls[polls.length - 1]).toMatch(STREAMS);
    expect(polls.some((l) => /^CALLS: /.test(l))).toBe(true);
  });

  it('голосовой воркер перезапускается в шаге рестарта, а не в сборке', () => {
    const { log } = runDeployBackend(['0']);
    expect(log[indexOf(log, RESTART)]).toMatch(/pm2 startOrReload ecosystem\.config\.cjs/);
    expect(log[indexOf(log, BUILD)]).not.toMatch(/startOrReload/);
  });

  it('не прочитан работающий коммит — не собираем вовсе, выход 1', () => {
    const { status, log } = runDeployBackend(['0'], { NO_SHA: '1' });
    expect(status).toBe(1);
    expect(indexOf(log, BUILD)).toBe(-1);
    expect(indexOf(log, RESTART)).toBe(-1);
  });

  it('сборка упала — рестарта нет, сборка возвращается к работающему коммиту, выход 1', () => {
    const { status, log } = runDeployBackend(['0'], { BUILD_FAILS: '1' });
    expect(status).toBe(1);
    expect(indexOf(log, RESTART)).toBe(-1);
    expect(indexOf(log, REVERT)).toBeGreaterThan(indexOf(log, BUILD));
  });

  it('сборка и её возврат — с pipefail; возврат не гоняет npm ci при том же package-lock.json', () => {
    const { log } = runDeployBackend(['0', '1'], { STREAM_DRAIN_SECONDS: '30' });
    const build = log[indexOf(log, BUILD)];
    const revert = log[indexOf(log, REVERT)];
    expect(build).toMatch(/set -eo pipefail/);
    expect(revert).toMatch(/set -eo pipefail/);
    expect(revert).toMatch(/CI_SAME_AS=\$\(git rev-parse HEAD\)/);
    expect(revert).toMatch(/git diff --quiet "\$CI_SAME_AS" HEAD -- package-lock\.json/);
  });

  it('все строки, уходящие в ssh, — синтаксически верный shell', () => {
    for (const run of [runDeployBackend(['0']), runDeployBackend(['0', '1'], { STREAM_DRAIN_SECONDS: '30' })]) {
      // обычный: коммит, сборка, рестарт, health; с возвратом: коммит, сборка, возврат
      expect(run.payloads.length).toBeGreaterThanOrEqual(3);
      for (const p of run.payloads) expect({ ok: p.syntaxOk, err: p.err }).toEqual({ ok: true, err: '' });
    }
  });

  it('переменная вплотную к нелатинскому символу — только в фигурных скобках (bash 3.2 на маке)', () => {
    // Та же проверка, что в шапке deploy.sh: исправный файл даёт ноль строк.
    const bad = fs.readFileSync(DEPLOY, 'latin1').split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => /\$[A-Za-z_][A-Za-z0-9_]*[\x80-\xff]/.test(l))
      .map(([n]) => n);
    expect(bad).toEqual([]);
  });
});
