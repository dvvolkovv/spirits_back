#!/bin/sh
#
# Переложить ключи приложения Zoom из базы Attendee в .env нашего бота.
#
# Зачем скрипт, а не пара команд руками: ключи лежат в базе Attendee
# зашифрованными (Fernet, ключ — в его настройках), достать их можно только его
# же кодом, а класть в .env надо ровно двумя строками и с правами 600.
#
# Секрет при этом никуда, кроме стенда, не выходит: контейнер пишет его во
# временный файл на смонтированном каталоге, скрипт переносит строки в .env и
# временный файл удаляет. На экран печатаются только длины — чтобы было видно,
# что ключи непустые, и не видно, какие именно.
#
# Запуск на стенде:
#     sh ~/spirits_back/infra/meeting-bot/pull-zoom-keys.sh
set -e

ENV="$HOME/spirits_back/infra/meeting-bot/.env"
TMP="$HOME/attendee/.zoom-keys"

[ -f "$ENV" ] || { echo "нет файла $ENV"; exit 1; }

cd "$HOME/attendee"
sudo docker compose -f dev.docker-compose.yaml exec -T attendee-app-local python manage.py shell -c '
from bots.models import Credentials

row = Credentials.objects.filter(credential_type=2).first()   # 2 — Zoom OAuth
if not row:
    raise SystemExit("в базе Attendee нет ключей Zoom")
d = row.get_credentials()
with open("/attendee/.zoom-keys", "w") as f:
    f.write("ZOOM_SDK_CLIENT_ID=%s\n" % d["client_id"])
    f.write("ZOOM_SDK_CLIENT_SECRET=%s\n" % d["client_secret"])
print("из базы Attendee взято, длины:", len(d["client_id"]), len(d["client_secret"]))
'

sudo chown "$(id -u):$(id -g)" "$TMP"

# Старые строки убираем: иначе в .env окажутся два значения одного ключа, и
# какое возьмёт dotenv — вопрос порядка, а не намерения.
grep -v '^ZOOM_SDK_' "$ENV" > "$ENV.new" || true
cat "$TMP" >> "$ENV.new"
mv "$ENV.new" "$ENV"
chmod 600 "$ENV"
rm -f "$TMP"

echo "в .env строк с ключами Zoom: $(grep -c '^ZOOM_SDK_' "$ENV")"
pm2 restart linkeon-meeting-bot >/dev/null && echo "сервис перезапущен"
