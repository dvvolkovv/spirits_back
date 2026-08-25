# LiveKit SFU

Работает на прод-хосте `212.113.106.202` как контейнер (исторически
`livekit-dozvon`, поднят 16.04.2026 вручную и до 25.08.2026 отсутствовал в git).

## Ключи

В git не хранятся. На хосте в `~/livekit-dozvon/livekit.yaml` секция `keys:`
содержит пары `<api-key>: <api-secret>`. Для голосовых звонков заведён
отдельный ключ `voicecall*`, ключ `dozvon*` не переиспользуется.

Бэкенд читает их из `.env`: `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`LIVEKIT_URL` (по умолчанию `ws://localhost:7880`).

## Применить изменения конфига

    scp infra/livekit/livekit.yaml dvolkov@212.113.106.202:~/livekit-dozvon/livekit.yaml.new
    ssh dvolkov@212.113.106.202
    # вручную перенести секцию keys: из старого файла в новый
    mv ~/livekit-dozvon/livekit.yaml.new ~/livekit-dozvon/livekit.yaml
    sudo docker restart livekit-dozvon
    curl -s -o /dev/null -w "%{http_code}\n" http://localhost:7880   # ждём 200

Рестарт рвёт активные звонки. Перед применением проверить, что их нет:

    psql -c "SELECT count(*) FROM voice_calls WHERE status IN ('dialing','active')"

## Настройки хоста

Отдельно от конфига, разово:

    ulimit -n 65535
    sysctl -w net.core.rmem_max=25165824
    sysctl -w net.core.wmem_max=25165824
    sysctl -w net.core.somaxconn=65535
