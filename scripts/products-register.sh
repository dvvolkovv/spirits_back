#!/usr/bin/env bash
# Заводит продукт в реестре и печатает runner-токен ОДИН раз.
#
# В базе лежит только sha256 токена — восстановить его потом нельзя, можно
# лишь выпустить новый. Это осознанно: утечка дампа не даёт доступа к
# клиентской VM.
#
# Использование:
#   DATABASE_URL=... scripts/products-register.sh <user_id> <name> <slug> <checkout_path> <site|bot>
#
# status и kind передаются явно: у обеих колонок нет DEFAULT, чтобы любая
# вставка называла состояние и форму продукта вслух. Дефолт 'site' у kind
# завёл бы бота как сайт — с публичным портом и vhost-ом наружу.
set -euo pipefail

if [[ $# -lt 5 ]]; then
  echo "usage: $0 <user_id> <name> <slug> <checkout_path> <site|bot>" >&2
  exit 2
fi

USER_ID="$1"; NAME="$2"; SLUG="$3"; CHECKOUT="$4"; KIND="$5"
if [[ "$KIND" != "site" && "$KIND" != "bot" ]]; then
  echo "kind должен быть site или bot, получено: $KIND" >&2
  exit 2
fi
: "${DATABASE_URL:?DATABASE_URL не задан}"

TOKEN="$(openssl rand -hex 32)"
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "
  INSERT INTO products (user_id, name, slug, checkout_path, runner_token_hash, status, kind)
  VALUES ('$USER_ID', '$NAME', '$SLUG', '$CHECKOUT', '$HASH', 'running', '$KIND')
  RETURNING id;"

echo "RUNNER_TOKEN=$TOKEN"
echo "Сохрани токен сейчас — второй раз он не покажется."
