#!/usr/bin/env bash
# Заводит продукт в реестре и печатает runner-токен ОДИН раз.
#
# В базе лежит только sha256 токена — восстановить его потом нельзя, можно
# лишь выпустить новый. Это осознанно: утечка дампа не даёт доступа к
# клиентской VM.
#
# Использование:
#   DATABASE_URL=... scripts/products-register.sh <user_id> <name> <slug> <checkout_path>
#
# status передаётся явно: у колонки нет DEFAULT, чтобы любая вставка называла
# состояние продукта вслух, а не получала «работает» по умолчанию.
set -euo pipefail

if [[ $# -lt 4 ]]; then
  echo "usage: $0 <user_id> <name> <slug> <checkout_path>" >&2
  exit 2
fi

USER_ID="$1"; NAME="$2"; SLUG="$3"; CHECKOUT="$4"
: "${DATABASE_URL:?DATABASE_URL не задан}"

TOKEN="$(openssl rand -hex 32)"
HASH="$(printf '%s' "$TOKEN" | openssl dgst -sha256 -hex | awk '{print $NF}')"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -tAc "
  INSERT INTO products (user_id, name, slug, checkout_path, runner_token_hash, status)
  VALUES ('$USER_ID', '$NAME', '$SLUG', '$CHECKOUT', '$HASH', 'running')
  RETURNING id;"

echo "RUNNER_TOKEN=$TOKEN"
echo "Сохрани токен сейчас — второй раз он не покажется."
