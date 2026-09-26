#!/usr/bin/env bash
###############################################################################
# provision-relay-isolation.sh — обвязка изоляции веб-хода релея на ХОСТЕ.
#
# Идемпотентно ставит: bubblewrap, apparmor-профиль для bwrap (иначе unpriv
# userns запрещён на Ubuntu 24.04), отдельного OS-пользователя relay-isolated и
# общую группу relay-iso, обёртку turn-sandbox.sh, sudoers-правило, публичный
# resolv.conf для песочницы и АДДИТИВНУЮ nft-таблицу egress-фильтра по uid.
# Сам код релея НЕ трогает и НЕ деплоит.
#
# Подкоманды:  provision (по умолчанию) | verify | rollback [--purge]
#
#╔══════════════════════════════════════════════════════════════════════════╗
#║ RUNBOOK — что делает ЧЕЛОВЕК на боевом релее (dv@5.101.115.184)            ║
#╠══════════════════════════════════════════════════════════════════════════╣
#║                                                                            ║
#║ 0. СНАЧАЛА СВЕРИТЬ КОД. Живой /home/dv/file-agent/server.mjs может         ║
#║    отставать от репо. Сверить и примирить ПЕРЕД деплоем:                   ║
#║       md5sum /home/dv/file-agent/server.mjs                               ║
#║       md5sum relay-agent/server.mjs      # из этой ветки                  ║
#║    Различаются — примирить вручную (в живой版 могли быть правки мимо git), ║
#║    только потом катить версию из ветки в /home/dv/file-agent/server.mjs.   ║
#║                                                                            ║
#║ 1. Разложить артефакты рядом с server.mjs (или из чекаута ветки):         ║
#║       scp relay-agent/turn-sandbox.sh \                                    ║
#║           relay-agent/provision-relay-isolation.sh \                       ║
#║           relay-agent/isolation/*  dv@RELAY:/home/dv/file-agent/relay-iso/ ║
#║                                                                            ║
#║ 2. Прогнать провижининг (ставит всё, кроме включения флага):              ║
#║       sudo bash provision-relay-isolation.sh provision                    ║
#║    Скрипт напечатает обнаруженный CLAUDE_BIN/RUNTIME — СВЕРИТЬ их с        ║
#║    реальностью (на релее claude бывает в ~/.local/bin, не в nvm). Если     ║
#║    не так — задать через env и перезапустить:                            ║
#║       CLAUDE_BIN=/home/dv/.local/bin/claude sudo -E bash \                 ║
#║           provision-relay-isolation.sh provision                          ║
#║                                                                            ║
#║ 3. Проверить обвязку БЕЗ релея (канарейки + egress-пробы):                ║
#║       sudo bash provision-relay-isolation.sh verify                       ║
#║    Все строки должны быть PASS.                                            ║
#║                                                                            ║
#║ 4. Дать процессу релея группу relay-iso (иначе он не прочитает            ║
#║    транскрипты/вывод изолированного юзера) и включить флаг. ПОД pm2:      ║
#║       # relay уже запускается от dv; dv добавлен в relay-iso провижинингом ║
#║       pm2 set ... / либо в ecosystem: env RELAY_SANDBOX=1                  ║
#║       pm2 delete file-agent && RELAY_SANDBOX=1 pm2 start server.mjs \      ║
#║           --name file-agent --update-env                                   ║
#║    ВАЖНО: именно delete+start (или выход из сессии dv и заход заново),     ║
#║    чтобы новый процесс получил supplementary-группу relay-iso. Простой     ║
#║    `pm2 restart` группу НЕ подхватит.                                      ║
#║    НЕ рестартить посреди живых стримов (см. память проекта).               ║
#║                                                                            ║
#║ 5. Проверить на живом ходе: отправить сообщение ассистенту в вебе;        ║
#║    убедиться, что ответ идёт, картинка/файл отдаётся через /files/,        ║
#║    а в песочнице egress закрыт:                                            ║
#║       sudo -u relay-isolated bwrap --unshare-user --ro-bind /usr /usr \    ║
#║         --symlink usr/bin /bin --ro-bind /etc /etc --proc /proc \          ║
#║         --dev /dev --tmpfs /tmp -- curl -m5 http://169.254.169.254/ ; \    ║
#║         echo "^ должно быть blocked"                                       ║
#║       nft list table inet relay_isolation   # счётчики drop растут         ║
#║                                                                            ║
#║ ОТКАТ (быстрый, без потери кода):                                          ║
#║    a) снять флаг: перезапустить релей БЕЗ RELAY_SANDBOX=1 (delete+start) — ║
#║       поведение мгновенно прежнее, код не откатывается;                    ║
#║    b) убрать nft-правила:  sudo bash provision-relay-isolation.sh rollback ║
#║    c) (по желанию) полный снос обвязки:  ... rollback --purge              ║
#║                                                                            ║
#║ ⚠ НЕПРОВЕРЕНО НА СТЕНДЕ, СВЕРИТЬ ПРИ ДЕПЛОЕ:                               ║
#║  • Живой OAuth-кред. Обёртка на каждый ход копирует свежий                 ║
#║    /home/dv/.claude/.credentials.json в root-мастер и монтирует его ro.    ║
#║    Но под флагом claude БОЛЬШЕ НЕ запускается от dv, значит кред dv никто   ║
#║    не обновляет по refresh-токену → он протухнет. НУЖНО решить обновление  ║
#║    креда dv (напр. systemd-timer раз в ~30 мин: `sudo -u dv -i claude -p   ║
#║    ok --model claude-haiku-4-5 --max-turns 1`), иначе через несколько      ║
#║    часов все ходы упадут на OAuth. На стенде кред был валиден и один ход    ║
#║    отработал; долгоживучесть refresh НЕ проверялась.                       ║
#║  • CLAUDE_BIN/RUNTIME на релее (nvm vs ~/.local/bin, self-contained бинарь).║
#║  • Тир-даун преэмпта под pm2 (kill sudo → --die-with-parent+pidns снимает  ║
#║    песочницу; на стенде подтверждено, на живом релее сверить).             ║
#╚══════════════════════════════════════════════════════════════════════════╝
###############################################################################
set -euo pipefail

# ── настройки (можно переопределить через env перед запуском) ─────────────────
ISO_USER="${ISO_USER:-relay-isolated}"
ISO_GROUP="${ISO_GROUP:-relay-iso}"
ISO_HOME="${ISO_HOME:-/home/$ISO_USER}"
STATE_DIR="${STATE_DIR:-/var/lib/relay-isolation}"
INSTALL_DIR="${INSTALL_DIR:-/opt/relay-isolation}"
CONF_DIR="${CONF_DIR:-/etc/relay-isolation}"
RELAY_USER="${RELAY_USER:-dv}"                 # от кого работает релей
CRED_SRC="${CRED_SRC:-/home/$RELAY_USER/.claude/.credentials.json}"
NFT_DROPIN_DIR="${NFT_DROPIN_DIR:-/etc/nftables.d}"
NFT_FILE="$NFT_DROPIN_DIR/relay-isolation.nft"
NFT_MAIN="${NFT_MAIN:-/etc/nftables.conf}"
CLAUDE_BIN="${CLAUDE_BIN:-}"                    # автодетект ниже, если пусто
RUNTIME="${RUNTIME:-}"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # где лежит этот скрипт
say(){ printf '\033[1m== %s\033[0m\n' "$*"; }
need_root(){ [ "$(id -u)" = 0 ] || { echo "нужен root (sudo)"; exit 1; }; }

detect_claude(){
  [ -n "$CLAUDE_BIN" ] || CLAUDE_BIN="$(sudo -u "$RELAY_USER" bash -lc 'command -v claude' 2>/dev/null || true)"
  [ -n "$CLAUDE_BIN" ] || { echo "не нашёл claude у $RELAY_USER — задайте CLAUDE_BIN=..."; exit 2; }
  local real; real="$(readlink -f "$CLAUDE_BIN" || echo "$CLAUDE_BIN")"
  [ -n "$RUNTIME" ] || RUNTIME="$(dirname "$(dirname "$CLAUDE_BIN")")"   # …/vX/bin/claude → …/vX
}

# ─────────────────────────────── provision ──────────────────────────────────
do_provision(){
  need_root
  say "1/9 bubblewrap"
  if ! command -v bwrap >/dev/null; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq bubblewrap
  fi
  bwrap --version

  say "2/9 группа $ISO_GROUP + пользователь $ISO_USER"
  groupadd -f "$ISO_GROUP"
  if ! id "$ISO_USER" >/dev/null 2>&1; then
    useradd -r -m -d "$ISO_HOME" -s /usr/sbin/nologin "$ISO_USER"
  fi
  usermod -aG "$ISO_GROUP" "$ISO_USER"
  usermod -aG "$ISO_GROUP" "$RELAY_USER"   # релей-от-dv должен читать вывод по группе
  echo "   $(getent group "$ISO_GROUP")"

  say "3/9 apparmor-профиль для bwrap (разрешить unpriv userns)"
  install -m 644 "$SRC_DIR/isolation/bwrap-userns.apparmor" /etc/apparmor.d/bwrap
  if command -v apparmor_parser >/dev/null; then apparmor_parser -r /etc/apparmor.d/bwrap; fi
  # быстрый само-тест: unpriv bwrap от изолированного юзера должен создать userns
  if sudo -u "$ISO_USER" bwrap --unshare-user --bind / / true 2>/dev/null; then
    echo "   unpriv bwrap работает ✓"
  else
    echo "   ВНИМАНИЕ: unpriv bwrap НЕ работает — проверьте apparmor/sysctl"; exit 3
  fi

  say "4/9 детект claude/node runtime (от $RELAY_USER)"
  detect_claude
  echo "   CLAUDE_BIN=$CLAUDE_BIN"
  echo "   RUNTIME=$RUNTIME   (СВЕРИТЬ ГЛАЗАМИ, что внутри bin/node и bin/claude)"

  say "5/9 конфиг + публичный resolv для песочницы"
  install -d -m 755 "$CONF_DIR"
  cat > "$CONF_DIR/config" <<EOF
# автогенерировано provision-relay-isolation.sh — читается turn-sandbox.sh
ISO_USER=$ISO_USER
ISO_GROUP=$ISO_GROUP
ISO_HOME=$ISO_HOME
STATE_DIR=$STATE_DIR
CRED_SRC=$CRED_SRC
CRED_MASTER=$STATE_DIR/credentials.json
RESOLV=$CONF_DIR/resolv.conf
CLAUDE_BIN=$CLAUDE_BIN
RUNTIME=$RUNTIME
EOF
  chmod 644 "$CONF_DIR/config"
  printf 'nameserver 1.1.1.1\nnameserver 8.8.8.8\n' > "$CONF_DIR/resolv.conf"
  chmod 644 "$CONF_DIR/resolv.conf"

  say "6/9 обёртка turn-sandbox.sh → $INSTALL_DIR"
  install -d -m 755 "$INSTALL_DIR"
  install -m 755 "$SRC_DIR/turn-sandbox.sh" "$INSTALL_DIR/turn-sandbox.sh"

  say "7/9 sudoers: $RELAY_USER может запускать обёртку от root без пароля"
  local sd=/etc/sudoers.d/relay-isolation
  echo "$RELAY_USER ALL=(root) NOPASSWD: $INSTALL_DIR/turn-sandbox.sh" > "$sd"
  chmod 440 "$sd"
  visudo -cf "$sd" >/dev/null && echo "   sudoers OK"

  say "8/9 state-каталог $STATE_DIR"
  install -d -o root -g "$ISO_GROUP" -m 2755 "$STATE_DIR"
  install -d -o root -g "$ISO_GROUP" -m 2755 "$STATE_DIR/sessions"

  say "9/9 nft egress-таблица (аддитивно, не трогая существующие)"
  install -d -m 755 "$NFT_DROPIN_DIR"
  install -m 644 "$SRC_DIR/isolation/relay-isolation.nft" "$NFT_FILE"
  # загрузить СЕЙЧАС (аддитивно, без flush — чужие таблицы целы)
  nft -f "$NFT_FILE"
  # сделать постоянным: include в основном конфиге, если ещё нет
  if ! grep -qF "include \"$NFT_FILE\"" "$NFT_MAIN" 2>/dev/null; then
    printf '\n# relay-isolation: egress-фильтр изолированного веб-хода\ninclude "%s"\n' "$NFT_FILE" >> "$NFT_MAIN"
    echo "   добавлен include в $NFT_MAIN"
  else
    echo "   include уже есть в $NFT_MAIN"
  fi
  nft list table inet relay_isolation >/dev/null && echo "   таблица загружена ✓"

  echo
  say "ГОТОВО. Дальше — п.4 RUNBOOK: перезапустить релей с группой relay-iso и RELAY_SANDBOX=1."
  echo "   Проверка: sudo bash $0 verify"
}

# ──────────────────────────────── verify ────────────────────────────────────
do_verify(){
  need_root
  detect_claude 2>/dev/null || true
  local fail=0
  ok(){ echo "PASS: $1"; }; bad(){ echo "FAIL: $1"; fail=1; }

  say "verify: apparmor / unpriv bwrap"
  sudo -u "$ISO_USER" bwrap --unshare-user --bind / / true 2>/dev/null && ok "unpriv bwrap userns" || bad "unpriv bwrap userns"

  say "verify: FS-канарейки (dv home скрыт, вывод пишется)"
  echo "CANARY_$$"> /home/"$RELAY_USER"/.relayiso-canary || true
  local vout=/tmp/relayiso-verify.$$; mkdir -p "$vout"; chgrp "$ISO_GROUP" "$vout"; chmod 2770 "$vout"
  sudo -u "$ISO_USER" bwrap --unshare-user --unshare-pid --die-with-parent \
    --ro-bind /usr /usr --symlink usr/bin /bin --symlink usr/lib /lib --symlink usr/lib64 /lib64 \
    --ro-bind /etc /etc --proc /proc --dev /dev --tmpfs /tmp \
    --bind "$vout" "$vout" \
    -- sh -c '
      cat /home/'"$RELAY_USER"'/.relayiso-canary 2>/dev/null && echo LEAK || echo hidden
      echo escaped > '"$vout"'/probe.txt
    ' | grep -q '^hidden$' && ok "dv home canary hidden" || bad "dv home canary hidden"
  [ -f "$vout/probe.txt" ] && ok "output escapes sandbox" || bad "output escapes sandbox"
  rm -f /home/"$RELAY_USER"/.relayiso-canary; rm -rf "$vout"

  say "verify: nft egress-таблица"
  nft list table inet relay_isolation >/dev/null 2>&1 && ok "nft table loaded" || bad "nft table loaded"

  say "verify: egress из-под bwrap (skuid) — external OK, приватка/метадата blocked, DNS OK"
  local B=(bwrap --unshare-user --die-with-parent --ro-bind /usr /usr --symlink usr/bin /bin
    --symlink usr/lib /lib --symlink usr/lib64 /lib64 --ro-bind /etc /etc
    --ro-bind "$CONF_DIR/resolv.conf" /etc/resolv.conf --proc /proc --dev /dev --tmpfs /tmp)
  sudo -u "$ISO_USER" "${B[@]}" -- sh -c 'getent hosts example.com >/dev/null' && ok "DNS resolves" || bad "DNS resolves"
  sudo -u "$ISO_USER" "${B[@]}" -- curl -s -m10 -o /dev/null https://example.com/ && ok "external reachable" || bad "external reachable"
  sudo -u "$ISO_USER" "${B[@]}" -- curl -s -m4 -o /dev/null http://169.254.169.254/ && bad "metadata blocked" || ok "metadata blocked"
  sudo -u "$ISO_USER" "${B[@]}" -- curl -s -m4 -o /dev/null http://10.0.0.1/ && bad "rfc1918 blocked" || ok "rfc1918 blocked"

  echo; [ "$fail" = 0 ] && say "VERIFY: всё PASS" || { say "VERIFY: есть FAIL"; exit 1; }
}

# ─────────────────────────────── rollback ───────────────────────────────────
do_rollback(){
  need_root
  say "rollback: снять nft-правила (сеть возвращается к прежнему поведению)"
  nft delete table inet relay_isolation 2>/dev/null && echo "   таблица удалена" || echo "   таблицы уже нет"
  if grep -qF "include \"$NFT_FILE\"" "$NFT_MAIN" 2>/dev/null; then
    # убрать include и предшествующую строку-комментарий
    sed -i "\|include \"$NFT_FILE\"|d; \|# relay-isolation: egress-фильтр|d" "$NFT_MAIN"
    echo "   include убран из $NFT_MAIN"
  fi
  rm -f "$NFT_FILE"
  echo "   ⚠ НЕ забыть: снять RELAY_SANDBOX=1 и перезапустить релей (delete+start)."

  if [ "${1:-}" = "--purge" ]; then
    say "purge: снос пользователя/группы/профиля/файлов (bubblewrap оставляем)"
    # apparmor: сперва ВЫГРУЗИТЬ профиль (нужен файл), потом удалить файл.
    if [ -f /etc/apparmor.d/bwrap ] && command -v apparmor_parser >/dev/null; then
      apparmor_parser -R /etc/apparmor.d/bwrap 2>/dev/null || true
    fi
    rm -f /etc/sudoers.d/relay-isolation /etc/apparmor.d/bwrap
    rm -rf "$INSTALL_DIR" "$CONF_DIR"
    userdel -r "$ISO_USER" 2>/dev/null || true
    groupdel "$ISO_GROUP" 2>/dev/null || true
    # STATE_DIR оставляем: там транскрипты сессий; сносить осознанно вручную.
    echo "   purge готов (STATE_DIR $STATE_DIR оставлен намеренно)."
  fi
}

case "${1:-provision}" in
  provision) do_provision;;
  verify)    do_verify;;
  rollback)  shift || true; do_rollback "${1:-}";;
  *) echo "usage: $0 [provision|verify|rollback [--purge]]"; exit 1;;
esac
