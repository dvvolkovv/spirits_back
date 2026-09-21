#!/usr/bin/env bash
# Ставит агента хоста продуктов: раскладывает product-runner в
# /opt/linkeon-host-agent, собирает, подставляет путь к node в юнит, поднимает
# его под systemd и ДОКАЗЫВАЕТ, что он работает.
#
# Использование:
#   scripts/product-host-agent-install.sh <ssh-цель>
#   scripts/product-host-agent-install.sh root@139.59.210.42
#
# Почему скриптом, а не абзацем в README. В юните стоит плейсхолдер __NODE__:
# захардкоженный /usr/bin/node есть не на всякой машине. Пока подставлять его
# некому, установка — это `sed | tee | daemon-reload | enable` руками, а
# промах в sed даёт ExecStart с несуществующим путём, status=203/EXEC и
# перезапуск раз в пять секунд. Ровно этот класс промахов — «отказ выглядит
# успехом» — соседние скрипты (product-provision.sh, product-host-harden.sh)
# и закрывают проверками перед действием и доказательством после.
#
# Почему у ssh-цели НЕТ умолчания, хотя у соседних скриптов оно есть. Те
# скрипты работают с продуктом на уже настроенной машине, а этот настраивает
# саму машину — и ставится не на одну: боевой хост продуктов, тестовая нода,
# будущий второй хост. Умолчание `root@139.59.210.42` означало бы, что запуск
# без аргумента идёт на машину с двумя живыми продуктами. Цель называется
# явно.
#
# Переменные:
#   NAME=linkeon-host-agent   имя юнита, каталога и конфига (совпадают)
#   AGENT_SRC=каталог         откуда брать код агента. По умолчанию —
#                             product-runner рядом со скриптом, то есть РАБОЧЕЕ
#                             ДЕРЕВО: ручной запуск ставит то, что сейчас в
#                             чекауте, и это поведение не менялось.
#                             deploy.sh (PHASE 4) передаёт сюда выкладку
#                             КОММИТА, ВЫКАЧЕННОГО НА ПРОДЕ: агент не должен
#                             быть новее сервера, а рабочее дерево общего
#                             репозитория почти никогда не равно продовому —
#                             туда параллельные сессии коммитят своё.
#   ALLOW_INCOMPLETE_HOST=1   поставить на машину, не готовую заводить продукты
#                             (стенд: нет product-vhost, /srv/products, образа).
#                             Список того, что пропущено, печатается.
#   FORCE=1                   перезапустить агента, даже если он, возможно,
#                             прямо сейчас разворачивает продукт
#   VERIFY_WINDOW=30          сколько секунд наблюдать за юнитом на проверке
set -euo pipefail

NAME="${NAME:-linkeon-host-agent}"
VERIFY_WINDOW="${VERIFY_WINDOW:-30}"
UNIT="$NAME.service"
DIR="/opt/$NAME"
ENVFILE="/etc/$NAME.env"

bold() { printf "\033[1m%s\033[0m\n" "$1"; }
ok()   { printf "\033[32m  ✓ %s\033[0m\n" "$1"; }
warn() { printf "\033[33m  ! %s\033[0m\n" "$1"; }
die()  { printf "\033[31m  ✗ %s\033[0m\n" "$1" >&2; exit 1; }

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <ssh-цель>   например root@139.59.210.42" >&2
  exit 2
fi
TARGET="$1"

# Источник кода агента — после die(), чтобы неверный AGENT_SRC давал внятный
# отказ, а не «cd: no such file» из подстановки. Ручной запуск берёт рабочее
# дерево рядом со скриптом; deploy.sh передаёт выкладку прод-коммита.
if [[ -n "${AGENT_SRC:-}" ]]; then
  SRC="$(cd "$AGENT_SRC" 2>/dev/null && pwd)" || die "AGENT_SRC=$AGENT_SRC — такого каталога нет"
else
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/../product-runner" && pwd)"
fi

[[ -f "$SRC/package.json" ]] || die "не нахожу product-runner: $SRC"
# Юнит собирается из шаблона на шаге [5/7] — то есть ПОСЛЕ того, как код
# разложен по машине и собран. Нет шаблона — установка упала бы ровно там,
# оставив на хосте новый код под старым юнитом. Проверяем здесь, до первого
# изменения: это тот же класс промахов, ради которого написан весь шаг [1/7].
[[ -f "$SRC/linkeon-host-agent.service" ]] \
  || die "в $SRC нет linkeon-host-agent.service — юнит собирать не из чего"

# Всё удалённое идёт через одну функцию: снаружи виден только текст шага, а
# не десять разных строк ssh с разным кавычением.
remote() {
  ssh -o BatchMode=yes "$TARGET" \
    "SUDO='${SUDO:-}' NAME='$NAME' UNIT='$UNIT' DIR='$DIR' ENVFILE='$ENVFILE' bash -s"
}

bold "[0/7] цель"
RUID=$(ssh -o BatchMode=yes "$TARGET" 'id -u') || die "не могу зайти по ssh на $TARGET"
# sudo нужен не всегда: на хост продуктов мы ходим root'ом, на тестовую ноду —
# обычным пользователем с NOPASSWD.
if [[ "$RUID" == "0" ]]; then SUDO=""; else SUDO="sudo -n"; fi
[[ -z "$SUDO" ]] || ssh -o BatchMode=yes "$TARGET" 'sudo -n true' 2>/dev/null \
  || die "на $TARGET нет ни root, ни sudo без пароля"
ok "$TARGET, uid=$RUID, юнит $UNIT, каталог $DIR"

bold "[1/7] проверяю машину"
# Проверки ДО первого изменения, и разделены по цене промаха: без node агент не
# стартует вовсе, а без product-vhost и образа он стартует и молча проваливает
# каждое задание — то есть поломка вылезет на клиенте, а не здесь.
NODE=$(remote <<'EOS'
set -euo pipefail
# `|| continue` и `if`, а не цепочка `a && b && { … }`. Цепочка здесь тоже
# работает — проверено на стенде с PATH без node, перебор доходит до
# /usr/local/bin — но работает она за счёт неочевидного исключения в `set -e`
# (падение любого звена `&&`, кроме последнего, не завершает скрипт). Цена
# ошибки в чтении этого места — «node не найден» на машине с живым node,
# поэтому оно написано так, чтобы читаться без оглядки на исключения.
for c in node /usr/local/bin/node /usr/bin/node; do
  p=$(command -v "$c" 2>/dev/null) || continue
  if [ -x "$p" ]; then echo "$p"; exit 0; fi
done
# nvm — последним: агент пойдёт от root, и путь в чужой домашний каталог хуже
# системного, но лучше несуществующего.
for p in /root/.nvm/versions/node/*/bin/node /home/*/.nvm/versions/node/*/bin/node; do
  if [ -x "$p" ]; then echo "$p"; exit 0; fi
done
exit 1
EOS
) || die "node на хосте не найден — ставить нечем"
# Проверяем не «файл существует», а «его запустит тот, от кого пойдёт юнит».
# Путь из /home/<кто-то>/.nvm бывает и нечитаемым, и тогда юнит падает с
# 203/EXEC уже после установки.
NODEV=$(remote <<EOS
set -euo pipefail
\$SUDO '$NODE' -v
EOS
) || die "$NODE не запускается от пользователя юнита"
ok "node $NODEV ($NODE)"

# npm ищется ОТДЕЛЬНО, и это не педантизм: на тестовой ноде /usr/local/bin/node
# оказался симлинком в ~/.nvm, а npm рядом с ним никто не положил. Каталог
# найденного node в PATH сборки не помогает — `env: npm: No such file or
# directory` прилетает уже ПОСЛЕ того, как код разложен по хосту. Проверяем до.
NPMBIN=$(remote <<EOS
set -euo pipefail
# readlink -f: /usr/local/bin/node сплошь и рядом симлинк, а npm лежит рядом с
# НАСТОЯЩИМ бинарём, а не рядом с ссылкой.
real=\$(readlink -f '$NODE')
d=\$(dirname "\$real")
if [ -x "\$d/npm" ]; then echo "\$d"; exit 0; fi
if p=\$(command -v npm 2>/dev/null); then dirname "\$p"; exit 0; fi
for p in /root/.nvm/versions/node/*/bin/npm /home/*/.nvm/versions/node/*/bin/npm; do
  if [ -x "\$p" ]; then dirname "\$p"; exit 0; fi
done
exit 1
EOS
) || die "npm на хосте не найден — собрать агента нечем"
ok "npm в $NPMBIN"

MISSING=$(remote <<'EOS'
set -uo pipefail
miss=""
for c in docker git chown rm systemctl curl; do command -v "$c" >/dev/null 2>&1 || miss="$miss $c"; done
command -v product-vhost >/dev/null 2>&1 || miss="$miss product-vhost"
[ -d /srv/products ] || miss="$miss /srv/products"
[ -d /etc/nginx/sites-products ] || miss="$miss /etc/nginx/sites-products"
$SUDO test -s /root/.secrets/claude-oauth-token || miss="$miss /root/.secrets/claude-oauth-token"
$SUDO docker image inspect linkeon-product:base >/dev/null 2>&1 || miss="$miss образ:linkeon-product:base"
echo "${miss# }"
EOS
)
if [[ -n "$MISSING" ]]; then
  # Список ровно из того, что зовёт src/host/provision.ts. Нет чего-то из
  # этого — агент поднимется, заберёт задание и провалит его; владелец увидит
  # отказ заведения, а не отказ установки.
  if [[ "${ALLOW_INCOMPLETE_HOST:-}" == "1" ]]; then
    warn "машина не готова заводить продукты, пропущено по ALLOW_INCOMPLETE_HOST: $MISSING"
  else
    die "на хосте нет: $MISSING — агент стартует, но провалит каждое задание.
      Хост продуктов готовит scripts/product-host-harden.sh и образ linkeon-product:base.
      Если агент ставится ради проверки самой установки — ALLOW_INCOMPLETE_HOST=1"
  fi
else
  ok "docker, git, product-vhost, /srv/products, образ, токен Claude — на месте"
fi

# Два агента на одной машине разложат nginx-конфиги наперегонки. claimJob на
# сервере от двойной выдачи защищён (FOR UPDATE SKIP LOCKED), а хост — нет.
OTHER=$(remote <<'EOS'
set -uo pipefail
$SUDO grep -ls "dist/host/index.js" /etc/systemd/system/*.service 2>/dev/null \
  | grep -v "/$UNIT\$" || true
EOS
)
[[ -z "$OTHER" ]] || die "на машине уже есть другой агент хоста: $OTHER — два агента будут мешать друг другу"

# Занятость агента проверяется ЗДЕСЬ, до первого изменения на машине, а не
# перед самим restart.
#
# Стояла эта проверка шагом [6/7] и отрабатывала честно — но к моменту отказа
# машина была уже переделана: код разложен (шаг 3), `rm -rf dist` + `npm ci` +
# сборка выполнены (шаг 4), юнит на диске заменён и daemon-reload сделан
# (шаг 5). Воспроизведено на стенде: после отказа «агент, возможно,
# разворачивает продукт» dist/host/index.js оказался пересобран (mtime сдвинут
# на три минуты), в /etc/systemd/system лежал новый юнит, а в памяти работал
# СТАРЫЙ процесс — то есть отказ, придуманный ради сохранности идущего задания,
# сохранял только его память.
#
# Хуже того, между `rm -rf dist` и концом сборки (десятки секунд) ExecStart
# работающего агента указывает на несуществующий файл: любое падение или
# перезагрузка в этом окне дают пять перезапусков и `failed`. Измерено на
# стенде: снесённый dist — `failed` через 30 с. На хосте с двумя живыми
# продуктами это окно открывать нельзя вообще, а не «нежелательно».
BUSY=$(remote <<'EOS'
set -uo pipefail
$SUDO systemctl is-active --quiet "$UNIT" || { echo ""; exit 0; }
$SUDO journalctl -u "$UNIT" --since "-10 min" -o cat 2>/dev/null | grep -c '\[host\] задание ' || true
EOS
)
if [[ -n "$BUSY" && "$BUSY" != "0" ]]; then
  # Десять минут — это серверный срок заведения (PROVISION_DEADLINE_MIN).
  [[ "${FORCE:-}" == "1" ]] \
    || die "агент за последние 10 минут брал задание ($BUSY шт.) и, возможно, разворачивает продукт прямо сейчас.
      Переустановка снесёт dist из-под живого процесса, а restart убьёт его docker run вместе с control-group:
      подчистка не отработает, на хосте останется полусозданный продукт.
      Дождаться (journalctl -u $UNIT -f) или FORCE=1"
  warn "ставлю поверх возможного задания по FORCE=1"
fi

bold "[2/7] проверяю конфиг $ENVFILE"
# Конфиг мы НЕ создаём и не правим: в нём HOST_TOKEN, а токены заводит
# владелец. Проверяем форму — ту же, что проверяет HostGuard на сервере
# (src/products/host.guard.ts), чтобы «токен короче 32 символов» всплыло здесь,
# а не вечным 401 через неделю. Само значение никуда не печатается.
CFG=$(remote <<'EOS'
set -euo pipefail
$SUDO test -f "$ENVFILE" || { echo "НЕТ_ФАЙЛА"; exit 0; }
# Конфиг с host-токеном, читаемый кем угодно, — это host-токен, читаемый кем
# угодно. Права приводим к 600 root; это единственное, что скрипт в файле
# меняет, содержимое он не трогает.
$SUDO chown root:root "$ENVFILE"
$SUDO chmod 600 "$ENVFILE"
# Разбор на bash, а не на awk: awk на Ubuntu по умолчанию mawk, и \x-классы,
# которыми удобно записать «печатный ASCII», он понимает не так, как gawk.
# Молча: проверка формы токена просто перестала бы что-либо проверять.
val() { $SUDO sed -n "s/^[[:space:]]*$1=//p" "$ENVFILE" | tail -1; }
# Разбор обязан совпадать с systemd, а не «быть строже на всякий случай»: файл
# читает EnvironmentFile, и решает, что доедет до процесса, только он.
#
# Измерено на systemd 255 (ubuntu 24.04) юнитом, который печатает ${#HOST_TOKEN}
# из своего окружения: пробелы вокруг значения и \r из CRLF systemd СРЕЗАЕТ —
# токен из 64 символов доезжает 64-символьным во всех четырёх видах записи (без
# кавычек, в двойных, в одинарных, с хвостовыми пробелами, в CRLF). Прежняя
# редакция этого места срезала только кавычки, поэтому видела 67 и 65 символов
# и заваливала установку на конфиге, с которым агент работает: файл, сохранённый
# редактором с CRLF, давал «HOST_TOKEN содержит пробел — такой токен нашему же
# агенту не отправить», и оператор шёл перевыпускать исправный токен.
#
# Порядок как у systemd: сначала обрамляющие пробелы, потом одна пара кавычек.
trim() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  printf '%s' "$v"
}
strip() { local v; v=$(trim "$1"); v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"; printf '%s' "$v"; }
u=$(strip "$(val LINKEON_URL)")
t=$(strip "$(val HOST_TOKEN)")
echo "URL=$u"
echo "TOKLEN=${#t}"
# [:graph:] — печатные без пробела, ровно TOKEN_SHAPE из host.guard.ts. После
# trim здесь ловится то, что systemd действительно отдаст процессу: пробел
# ВНУТРИ значения (в кавычках он сохраняется) и неASCII.
# Без `case`: этот кусок едет внутри $(…), а bash 3.2 на маке спотыкается о
# закрывающую скобку шаблона `*)` внутри heredoc в подстановке команды.
if printf '%s' "$t" | LC_ALL=C grep -q '[^[:graph:]]'; then
  echo "TOKSHAPE=плохая"
else
  echo "TOKSHAPE=ok"
fi
EOS
)
[[ "$CFG" != "НЕТ_ФАЙЛА" ]] || die "$ENVFILE не заведён.
      Создать его должен владелец, значение токена берётся из PRODUCT_HOST_TOKEN бэкенда:
        LINKEON_URL=https://my.linkeon.io
        HOST_TOKEN=<то же самое, что PRODUCT_HOST_TOKEN в .env бэкенда>"
LINKEON_URL=$(sed -n 's/^URL=//p' <<<"$CFG")
TOKLEN=$(sed -n 's/^TOKLEN=//p' <<<"$CFG")
TOKSHAPE=$(sed -n 's/^TOKSHAPE=//p' <<<"$CFG")

[[ -n "$LINKEON_URL" ]] || die "LINKEON_URL в $ENVFILE пуст"
# http отправил бы host-токен по сети открытым текстом, а за ним лежат
# расшифрованные секреты ВСЕХ продуктов. Исключение ровно одно и оно не
# «послабление для удобства»: на петле трафик машину не покидает, и без этого
# исключения установку нечем проверить на стенде, где настоящего Linkeon нет.
case "$LINKEON_URL" in
  https://*) ;;
  http://127.0.0.1*|http://localhost*) warn "LINKEON_URL на петле без TLS — это допустимо только на стенде" ;;
  *) die "LINKEON_URL=$LINKEON_URL — только https (host-токен по http уходит открытым текстом)" ;;
esac
(( TOKLEN >= 32 )) || die "HOST_TOKEN длиной $TOKLEN — гвард сервера требует не меньше 32 символов и отвергнет его"
[[ "$TOKSHAPE" == "ok" ]] || die "HOST_TOKEN содержит пробел, управляющий символ или неASCII — такой токен нашему же агенту не отправить"
ok "конфиг: $LINKEON_URL, токен $TOKLEN символов, права 600 root"
# Печатается крупно намеренно: агент, поставленный на боевой хост с
# LINKEON_URL тестового стенда, выглядит исправным и разворачивает чужие
# задания рядом с живыми продуктами.
bold "      агент будет ходить за заданиями на $LINKEON_URL"

bold "[3/7] раскладываю код"
remote <<'EOS'
set -euo pipefail
$SUDO mkdir -p "$DIR"
EOS
# `--rsync-path=rsync` в ветке root — это умолчание rsync, то есть заведомо
# безвредный аргумент. Так обе ветки остаются одной строкой запуска: массив
# аргументов здесь не годится, скрипт запускают с мака, где bash 3.2 и пустой
# массив под `set -u` — «unbound variable».
RPATH="rsync"; [[ -z "$SUDO" ]] || RPATH="sudo -n rsync"
# Без --delete: с ним rsync на этом проекте уже сносил .env воркера.
# .env исключён отдельно — dotenv в агенте читает его из WorkingDirectory, и
# случайно приехавший файл стал бы вторым источником правды рядом с
# EnvironmentFile.
rsync -az --rsync-path="$RPATH" \
  --exclude node_modules --exclude .git --exclude .env --exclude dist \
  "$SRC/" "$TARGET:$DIR/"
# Источник печатается намеренно: из deploy.sh это каталог-выкладка прод-коммита,
# и оператор должен видеть, что на машину уехало НЕ его рабочее дерево.
ok "исходники в $DIR (из $SRC)"

bold "[4/7] собираю"
remote <<EOS
set -euo pipefail
cd "\$DIR"
# Старый dist сносится ДО сборки. Иначе провалившаяся сборка оставляет
# работоспособный артефакт прошлой установки, проверка ниже зеленеет, а агент
# крутит позапрошлый код — сироты прошлых выкатов на этом проекте уже зеленили
# проверку не раз.
\$SUDO rm -rf dist
# \`sudo env PATH=…\`, а не \`export PATH\`: sudo подменяет PATH своим
# secure_path, и npm под ним не находится вовсе, а найденный npm не находит
# node (у него шебанг \`env node\`). На root-цели \$SUDO пуст и env безвреден.
# --include=dev: при NODE_ENV=production в окружении машины \`npm ci\` молча
# пропустит typescript, и сборка упадёт на \`tsc: not found\`.
\$SUDO env PATH="$NPMBIN:\$PATH" npm ci --include=dev --silent
\$SUDO env PATH="$NPMBIN:\$PATH" npm run build --silent
EOS
remote <<'EOS'
set -euo pipefail
$SUDO test -f "$DIR/dist/host/index.js" || { echo "dist/host/index.js не собрался"; exit 1; }
EOS
ok "dist/host/index.js собран"

bold "[5/7] ставлю юнит"
# Пути в шаблоне написаны боевые, а не плейсхолдерами: юнит должен читаться
# как то, что реально стоит на машине. Переписываются они только при NAME,
# отличном от умолчания, — то есть при установке рядом на стенде.
UNIT_TEXT=$(sed -e "s|__NODE__|$NODE|g" \
                -e "s|/etc/linkeon-host-agent.env|$ENVFILE|g" \
                -e "s|/opt/linkeon-host-agent|$DIR|g" \
                "$SRC/linkeon-host-agent.service")
# Плейсхолдер, переживший подстановку, — это 203/EXEC после enable, то есть
# цикл падений. Проверяем текст ДО того, как он попадёт в systemd.
if grep -q '__NODE' <<<"$UNIT_TEXT"; then die "в юните остался неподставленный плейсхолдер"; fi
grep -q "^ExecStart=$NODE " <<<"$UNIT_TEXT" || die "ExecStart не собрался"
# Текст едет отдельным ssh, потому что у `remote` стдин занят самим скриптом.
# Через base64 не гоняем сознательно: `base64` на маке — не coreutils, и в
# выводе у него оказался символ вне алфавита, который на той стороне давал
# «base64: invalid input» уже после раскладки кода.
printf '%s\n' "$UNIT_TEXT" \
  | ssh -o BatchMode=yes "$TARGET" "$SUDO tee /etc/systemd/system/$UNIT >/dev/null" \
  || die "не смог записать юнит"
remote <<EOS
set -euo pipefail
\$SUDO chmod 644 "/etc/systemd/system/\$UNIT"
\$SUDO systemctl daemon-reload
# Ловит опечатки в директивах, которые systemd иначе проглотит молча.
\$SUDO systemd-analyze verify "\$UNIT" 2>&1 | grep -v '^\$' || true
EOS
ok "/etc/systemd/system/$UNIT"

bold "[6/7] запускаю"
START_TS=$(remote <<'EOS'
set -euo pipefail
date +%s
EOS
)
remote <<'EOS'
set -euo pipefail
$SUDO systemctl enable "$UNIT" >/dev/null 2>&1
$SUDO systemctl restart "$UNIT"
EOS
ok "юнит запущен и включён в автозагрузку"

bold "[7/7] проверяю, что он РАБОТАЕТ, а не просто active"
echo "      наблюдаю $VERIFY_WINDOW с…"
sleep "$VERIFY_WINDOW"

# `active` у вечно перезапускающегося процесса тоже зелёный: systemd поднимает
# его каждые пять секунд, и в любой момент времени он «только что стартовал».
# Отличает одно — счётчик перезапусков.
STATE=$(remote <<'EOS'
set -uo pipefail
echo "ACTIVE=$($SUDO systemctl is-active "$UNIT" 2>/dev/null)"
echo "ENABLED=$($SUDO systemctl is-enabled "$UNIT" 2>/dev/null)"
echo "RESTARTS=$($SUDO systemctl show -p NRestarts --value "$UNIT")"
echo "PID=$($SUDO systemctl show -p MainPID --value "$UNIT")"
EOS
)
ACTIVE=$(sed -n 's/^ACTIVE=//p' <<<"$STATE")
ENABLED=$(sed -n 's/^ENABLED=//p' <<<"$STATE")
RESTARTS=$(sed -n 's/^RESTARTS=//p' <<<"$STATE")
PID=$(sed -n 's/^PID=//p' <<<"$STATE")

JOURNAL=$(remote <<EOS
set -uo pipefail
\$SUDO journalctl -u "\$UNIT" --since "@$START_TS" -o cat 2>/dev/null
EOS
)

if [[ "$ACTIVE" != "active" || -z "$PID" || "$PID" == "0" ]]; then
  printf '%s\n' "$JOURNAL" | tail -20 >&2
  die "юнит не работает: is-active=$ACTIVE. Чаще всего это сломанный $ENVFILE — причина в строке «[host] фатально: …» выше"
fi
(( RESTARTS == 0 )) || {
  printf '%s\n' "$JOURNAL" | tail -20 >&2
  die "агент перезапускался $RESTARTS раз за $VERIFY_WINDOW с — это цикл падений, а не работа"
}
ok "процесс живёт $VERIFY_WINDOW с без перезапусков (pid $PID)"
[[ "$ENABLED" == "enabled" ]] || die "юнит не в автозагрузке (is-enabled=$ENABLED) — перезагрузку не переживёт"
ok "переживёт перезагрузку: is-enabled=enabled"

grep -q '\[host\] старт агента' <<<"$JOURNAL" \
  || die "в журнале нет строки о старте — запустилось что-то другое, не агент"
grep '\[host\] старт агента' <<<"$JOURNAL" | tail -1 | sed 's/^/      /'

# Строка про неудачный опрос печатается на КАЖДОМ неуспешном обороте (раз в
# 9 секунд), в том числе на неверном токене. Её отсутствие за окно наблюдения —
# это и есть «агента пускают»: при исправной работе агент не печатает ничего.
if grep -q 'опрос не удался' <<<"$JOURNAL"; then
  grep 'опрос не удался' <<<"$JOURNAL" | tail -3 | sed 's/^/      /' >&2
  die "агент не может опросить Linkeon — строки выше. HTTP 401 означает, что HOST_TOKEN не совпал с PRODUCT_HOST_TOKEN бэкенда"
fi
ok "за $VERIFY_WINDOW с ни одного неудачного опроса"

# Отсутствие ошибок — улика, но не доказательство. Доказательство — ответ
# сервера на запрос с ТЕМ ЖЕ токеном, который systemd отдал процессу (берём из
# /proc/<pid>/environ, а не из файла: так проверяется то, что реально доехало,
# со всеми кавычками и хвостовыми пробелами).
#
# Проба идёт на маршрут ЗАВЕРШЕНИЯ со случайным uuid, а НЕ на опрос. Опрос
# забирает задание: проба на нём в момент, когда клиент нажал «Новый продукт»,
# увела бы задание в никуда — агент его не получит, отчитаться о нём некому, и
# через десять минут продукт похоронит реаппер. Завершение по неизвестному id
# не меняет ничего (`AND status='running'` не находит строки) и оставляет на
# сервере одну строку в лог: «отчёт об успехе по незапущенному заданию … —
# продукт не тронут». Гвард при этом отрабатывает первым, а именно он и
# проверяется.
CODE=$(remote <<EOS
set -uo pipefail
# \`\$SUDO cat …\`, а не \`… < /proc/…\`: перенаправление делает шелл, и делает
# его ДО sudo — от обычного пользователя это Permission denied на живом
# процессе root'а.
env=\$(\$SUDO cat "/proc/$PID/environ" | tr '\0' '\n')
tok=\$(printf '%s\n' "\$env" | sed -n 's/^HOST_TOKEN=//p')
url=\$(printf '%s\n' "\$env" | sed -n 's/^LINKEON_URL=//p')
[ -n "\$tok" ] || { echo "ПУСТОЙ_ТОКЕН"; exit 0; }
uuid=\$(cat /proc/sys/kernel/random/uuid)
# Токен уходит curl'у через stdin, а не аргументом: argv виден в ps всей машине.
#
# Значения в конфиге В КАВЫЧКАХ — это проверено, а не выбрано по вкусу.
# Без кавычек (\`header = Authorization: Bearer …\`) curl 8.5 отправляет
# что-то другое и сервер отвечает 401 на ЗАВЕДОМО ВЕРНЫЙ токен: первая
# редакция этой пробы заваливала установку, у которой всё было в порядке.
# Внутри кавычек curl разбирает обратный слэш, поэтому \\ и " в токене
# экранируются (форма токена их допускает).
esc=\$(printf '%s' "\$tok" | sed 's/[\\\\"]/\\\\&/g')
printf 'url = "%s/webhook/products/host/jobs/%s/complete"\nheader = "Authorization: Bearer %s"\n' \
  "\${url%/}" "\$uuid" "\$esc" \
  | curl -sS -K - -m 15 -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' -d '{"ok":true}'
EOS
)
case "$CODE" in
  # Nest отвечает на @Post кодом 201, а не 200. Сверка с 200 дала бы ложный
  # отказ на полностью исправном сервере — на этом уже спотыкался сам агент.
  201|200) ok "сервер принял запрос с токеном агента (HTTP $CODE) — агента пускают" ;;
  401) die "HTTP 401: HOST_TOKEN не совпал с PRODUCT_HOST_TOKEN в окружении бэкенда.
      Снаружи это выглядит как «кнопка Новый продукт не работает»: агент жив, а заданий не получает никогда" ;;
  404) die "HTTP 404: на $LINKEON_URL нет маршрутов агента — не тот адрес или бэкенд старой версии" ;;
  000|"") die "до $LINKEON_URL не достучаться с хоста (DNS, сеть, TLS)" ;;
  ПУСТОЙ_ТОКЕН) die "процессу агента не досталось HOST_TOKEN — конфиг $ENVFILE не подхватился" ;;
  *) die "сервер ответил HTTP $CODE на запрос агента" ;;
esac

echo
bold "готово"
echo "  журнал:   ssh $TARGET '${SUDO:+sudo }journalctl -u $UNIT -f'"
echo "  состояние: ssh $TARGET '${SUDO:+sudo }systemctl status $UNIT'"
echo
echo "  Молчание в журнале — это норма: агент печатает строку только когда взял"
echo "  задание или когда опрос не удался. Повторяющееся «опрос не удался:"
echo "  опрос отклонён: HTTP 401» означает, что токен разошёлся с бэкендом."
