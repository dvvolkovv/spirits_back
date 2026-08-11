-- Устройства, с которых люди заходят. Строка на пару «пользователь —
-- устройство»: человек с ноутбуком и телефоном даёт две строки, и сводка
-- честно показывает его в обеих корзинах.
CREATE TABLE IF NOT EXISTS user_devices (
  user_id         text NOT NULL,
  -- Огрублённый отпечаток: платформа|ОС|браузер|мажорная версия. Ключом взят
  -- он, а не сырой User-Agent: браузер обновляется каждые пару недель, и по
  -- сырой строке у одного человека за год накопились бы десятки «устройств».
  signature       text NOT NULL,
  platform        text NOT NULL,
  os_name         text,
  os_version      text,
  browser_name    text,
  browser_version text,
  -- Последняя сырая строка — для разбора спорных случаев.
  raw_user_agent  text,
  first_seen      timestamptz NOT NULL DEFAULT now(),
  last_seen       timestamptz NOT NULL DEFAULT now(),
  -- Считает записи, то есть входы и продления токена, а не запросы вообще.
  -- Числом визитов это называть нельзя.
  seen_count      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, signature)
);

-- Сводка всегда фильтрует по свежести, разрез по пользователю — по user_id.
CREATE INDEX IF NOT EXISTS user_devices_last_seen_idx ON user_devices (last_seen);

COMMENT ON TABLE user_devices IS 'С каких устройств заходят пользователи';
COMMENT ON COLUMN user_devices.user_id IS 'ТОЛЬКО text: у телефонных регистраций это номер, у email и OAuth — UUID на 36 символов';
