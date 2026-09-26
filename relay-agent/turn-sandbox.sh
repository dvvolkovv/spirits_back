#!/usr/bin/env bash
# turn-sandbox.sh — изоляция одного веб-хода релея.
#
# Запускается РЕЛЕЕМ через sudo (то есть от root). За один ход:
#   1) синхронизирует OAuth-креденшел (root-копия свежего креда dv),
#   2) готовит пер-сессионный ~/.claude изолированного пользователя в
#      /var/lib/relay-isolation/sessions/<key> (переживает ходы → работает
#      --resume; лежит вне дома изолированного юзера, чтобы релей-от-dv мог
#      читать транскрипты по группе relay-iso),
#   3) отдаёт папку вывода в группу relay-iso (изолированный пишет, dv читает),
#   4) роняет привилегии до изолированного пользователя и делает
#      exec `bwrap … claude "$@"`.
# Промпт приходит на stdin и прозрачно уходит в claude.
#
# Флаг off (RELAY_SANDBOX!=1 в релее) означает, что этот скрипт не вызывается —
# поведение релея байт-в-байт прежнее. Полный RUNBOOK — в
# provision-relay-isolation.sh.
set -euo pipefail

CONF=/etc/relay-isolation/config
# shellcheck disable=SC1090
[ -r "$CONF" ] && . "$CONF"

# ── статические настройки (config переопределяет дефолты, флаги — config) ──────
ISO_USER="${ISO_USER:-relay-isolated}"
ISO_GROUP="${ISO_GROUP:-relay-iso}"          # общая группа: члены — dv и ISO_USER
ISO_HOME="${ISO_HOME:-/home/$ISO_USER}"
STATE_DIR="${STATE_DIR:-/var/lib/relay-isolation}"
CRED_SRC="${CRED_SRC:-/home/dv/.claude/.credentials.json}"       # живой кред dv
CRED_MASTER="${CRED_MASTER:-$STATE_DIR/credentials.json}"
RESOLV="${RESOLV:-/etc/relay-isolation/resolv.conf}"             # публичный DNS
RUNTIME="${RUNTIME:-}"       # каталог версии node (в нём bin/node и bin/claude)
CLAUDE_BIN="${CLAUDE_BIN:-}" # абсолютный путь к claude внутри RUNTIME
# Тулчейн ассистента (питон-venv для картинок, bun) — секретов там нет, монтируем
# ro только если существует; дом dv при этом целиком НЕ раскрывается.
EXTRA_ROBINDS="${EXTRA_ROBINDS:-/home/dv/agent-env /home/dv/.bun}"
MCP_TIMEOUT_V="${MCP_TIMEOUT:-120000}"
MCP_TOOL_TIMEOUT_V="${MCP_TOOL_TIMEOUT:-600000}"

OUT=""; MCP=""; KEY=""; uploads=()
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2;;
    --mcp) MCP="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    --upload) uploads+=("$2"); shift 2;;
    --user) ISO_USER="$2"; ISO_HOME="/home/$2"; shift 2;;
    --home) ISO_HOME="$2"; shift 2;;
    --) shift; break;;
    *) echo "turn-sandbox: unknown arg $1" >&2; exit 2;;
  esac
done
# оставшиеся "$@" — аргументы claude

[ -z "$CLAUDE_BIN" ] && CLAUDE_BIN="$(command -v claude || true)"
[ -z "$RUNTIME" ] && [ -n "$CLAUDE_BIN" ] && RUNTIME="$(dirname "$(dirname "$CLAUDE_BIN")")"
[ -x "$CLAUDE_BIN" ] || { echo "turn-sandbox: claude not found ($CLAUDE_BIN)" >&2; exit 3; }
[ -n "$KEY" ] && [ -n "$OUT" ] || { echo "turn-sandbox: --key and --out required" >&2; exit 4; }
# --key уходит в путь на диске: не пускаем туда слэши и '..'
case "$KEY" in */*|*..*|"") echo "turn-sandbox: bad --key" >&2; exit 4;; esac

ISO_UID="$(id -u "$ISO_USER")"; ISO_GID="$(id -g "$ISO_USER")"

# 1) кред: root-копия свежего креда dv на каждый ход (единственный писатель —
#    dv, чтобы ротация refresh-токена не гонялась в нескольких процессах разом).
install -d -o root -g "$ISO_GROUP" -m 2755 "$STATE_DIR"
[ -r "$CRED_SRC" ] && install -o "$ISO_UID" -g "$ISO_GID" -m 600 "$CRED_SRC" "$CRED_MASTER"
[ -r "$CRED_MASTER" ] || { echo "turn-sandbox: no credential at $CRED_MASTER" >&2; exit 5; }

# 2) пер-сессионный ~/.claude (переживает ходы → --resume видит транскрипт).
#    setgid + группа relay-iso → релей-от-dv потом прочитает транскрипт.
install -d -o root      -g "$ISO_GROUP" -m 2755 "$STATE_DIR/sessions"
install -d -o "$ISO_UID" -g "$ISO_GROUP" -m 2750 "$STATE_DIR/sessions/$KEY"
SDIR="$STATE_DIR/sessions/$KEY/.claude"
install -d -o "$ISO_UID" -g "$ISO_GROUP" -m 2750 "$SDIR"

# 3) папку вывода релей создаёт от dv — отдаём её в группу, чтобы изолированный
#    писал, а dv (владелец) читал для сборки outputFiles и отдачи через /files/.
if [ -d "$OUT" ]; then chgrp "$ISO_GROUP" "$OUT"; chmod 2770 "$OUT"; fi

# 4) сборка bind-набора bwrap
binds=(
  --unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup-try
  --die-with-parent --new-session
  --ro-bind /usr /usr
  --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/sbin /sbin
  --ro-bind /etc /etc
  --proc /proc --dev /dev --tmpfs /tmp --tmpfs /run
  --ro-bind "$RUNTIME" "$RUNTIME"
)
[ -r "$RESOLV" ] && binds+=(--ro-bind "$RESOLV" /etc/resolv.conf)
for d in $EXTRA_ROBINDS; do [ -e "$d" ] && binds+=(--ro-bind "$d" "$d"); done
# HOME — свежий tmpfs, внутри примонтирован пер-сессионный .claude, поверх — кред ro
binds+=(--tmpfs "$ISO_HOME" --bind "$SDIR" "$ISO_HOME/.claude"
  --ro-bind "$CRED_MASTER" "$ISO_HOME/.claude/.credentials.json")
# вывод (rw, утекает на хост для /files/), MCP-конфиг (ro), загрузки (ro)
binds+=(--bind "$OUT" "$OUT")
[ -n "$MCP" ] && [ -r "$MCP" ] && binds+=(--ro-bind "$MCP" "$MCP")
for u in "${uploads[@]:-}"; do [ -n "$u" ] && [ -e "$u" ] && binds+=(--ro-bind "$u" "$u"); done
# окружение внутри песочницы
binds+=(--setenv HOME "$ISO_HOME" --setenv USER "$ISO_USER"
  --setenv PATH "$RUNTIME/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  --setenv MCP_TIMEOUT "$MCP_TIMEOUT_V" --setenv MCP_TOOL_TIMEOUT "$MCP_TOOL_TIMEOUT_V"
  --setenv LANG "C.UTF-8"
  --chdir /tmp)

# umask 027 → файлы транскрипта и вывода группо-читаемы (relay-iso), релей-от-dv
# их прочитает. Наследуется дочерним claude через bwrap.
umask 027

# 5) роняем привилегии до изолированного пользователя и exec bwrap.
#    bwrap запускается НЕ от root → unprivileged userns (разрешён apparmor-профилем)
#    → сокеты хода принадлежат ISO_UID → nft skuid ловит их (проверено на стенде).
exec setpriv --reuid="$ISO_UID" --regid="$ISO_GID" --init-groups \
  bwrap "${binds[@]}" "$CLAUDE_BIN" "$@"
