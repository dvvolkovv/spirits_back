#!/usr/bin/env bash
# Изоляция контейнеров продуктов на хосте. Идемпотентен, запускать на
# PRODUCTS_HOST после установки Docker и при пересоздании машины.
#
# Зачем: вся модель безопасности схемы держится на границе контейнера — внутри
# сидит агент, которому клиент пишет произвольный текст. По умолчанию Docker эту
# границу не даёт.
#
# Замерено на живом стенде до применения:
#   контейнер соседа  172.17.0.2:3000 → 200
#   SSH хоста         172.17.0.1:22   → соединение установлено
#   nginx хоста       172.17.0.1:80   → соединение установлено
# То есть агент одного клиента видел и продукт другого, и SSH машины.
set -euo pipefail

echo "[1/3] запрещаю контейнерам общаться между собой"
python3 - <<'PY'
import json, os
p = "/etc/docker/daemon.json"
d = json.load(open(p)) if os.path.exists(p) else {}
d["icc"] = False
json.dump(d, open(p, "w"), indent=2)
PY
systemctl restart docker
sleep 8

echo "[2/3] запрещаю контейнерам обращаться к самому хосту"
# ВАЖЕН ПОРЯДОК. Трафик к самому хосту идёт цепочкой INPUT, а не FORWARD —
# правило в DOCKER-USER (FORWARD) его не видит вовсе, это проверено: SSH хоста
# оставался доступен.
#
# И ещё важнее: ESTABLISHED обязан стоять ПЕРЕД DROP. Без него рубится ответный
# трафик от контейнера к nginx, и все продукты разом отдают пустой ответ —
# проверено, оба сайта легли до этой строки.
iptables -D INPUT -i docker0 -j DROP 2>/dev/null || true
iptables -D INPUT -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null || true
iptables -I INPUT -i docker0 -j DROP
iptables -I INPUT -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

echo "[3/3] сохраняю правила на перезагрузку"
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq iptables-persistent >/dev/null 2>&1 || true
netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4

echo
echo "Проверять так — из любого контейнера продукта:"
echo "  docker exec <slug> node -e \"require('net').connect({host:'172.17.0.1',port:22,timeout:5000})"
echo "    .on('connect',()=>console.log('ДЫРА')).on('timeout',()=>console.log('закрыто'))\""
echo
echo "Исходящий интернет обязан остаться: раннеру нужен my.linkeon.io,"
echo "агенту — Anthropic. Проверить: docker exec <slug> curl -sI https://my.linkeon.io"
