# База городов

`cities.<код>.json` — города GeoNames от 15 000 жителей с названиями на семи
языках сайта (ru, en, es, de, fr, pt, zh) и IANA-поясом; один список и порядок:
строка N — один город во всех базах. Страны в нерусских базах — Unicode CLDR,
китайские названия — упрощённые (Unihan). Собирает
`land_linkeon/scripts/build-hd-cities.py` за один прогон, сюда —
`scripts/sync-human-design.sh` (land_linkeon @ `1156632`).
Данные GeoNames (https://www.geonames.org/) — по лицензии CC BY 4.0.
Данные Unicode CLDR и Unihan — по лицензии Unicode License v3 (полный текст —
land_linkeon/public/licenses.txt).
