# Ролики со сценками, план 3: движок сценок и ролик-образец — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Студия умеет оживлять сценки (кадр Nano Banana Pro → клип Gemini Omni → проверка речи → громкость и субтитры) и собирать ролик «сценка → настоящий ответ → сценка → финал». Этим кодом собран ролик-образец про залог, и владелец его принял.

**Architecture:** Паспорта труппы и сборка промптов — чистые функции в API (`src/shorts/short-troupe.ts`, `short-skit-prompts.ts`): в плане 4 их вызовут режиссёр и сценарист. Студия получает папку `src/animate/` (клиент Google, распознавание SpeechKit, сверка речи, время реплик, проверка клипа, задание `animate`) и композицию `SkitShort`. Образец собирается командами на ноде из настоящей съёмки стенда: CLI бэкенда кладёт в сценарий готовые промпты, `npm run animate` оживляет сценки, `npm run render` собирает ролик. Очередь, база и бот в этом плане не меняются.

**Tech Stack:** NestJS 10 (commonjs, `strictNullChecks: false`, jest + ts-jest, ts-node). Студия — Node 22 ESM, `tsx --test` (`node:test`), Remotion 4.0.530, ffmpeg/ffprobe с libx264 и libopus. Google Generative Language API: `gemini-3-pro-image-preview` (`generateContent`), `gemini-omni-1.1-flash` (Interactions API). SpeechKit v1: синтез (уже есть) и распознавание.

**Спека:** `docs/superpowers/specs/2026-10-26-shorts-skits-design.md`, разделы «Ролик», «Труппа», «Кто пишет сценки» (форма `Skit`, сборка промптов кодом), «Задание `animate`», «Сборка», «Отказы» (кроме того, что относится к очереди), «Порядок работ», шаг 1.

**Код задач 2–14 прошёл две волны ревью.** Блоки кода в задачах ниже — редакция после первой волны (коммит плана `1e57d5e`). Вторая волна (коммиты `fe9aade..f9dc5ae`, раздел «Вторая волна правок по ревью» перед задачей 15) их уточняет; источник правды — код ветки.

**Вне этого плана — план 4 «Сценки в конвейере»** (пишется после того, как владелец примет образец, с учётом того, что образец уточнил):
- миграция `shorts/002`: `short_video.format`, `short_video.animation`, статусы `animate_queued` и `animating`, `short_settings.format` и `max_omni_seconds`;
- переходы статусов, `IN_WORK_STATUSES`, `RESUME_FROM`, «Повторить» после сбоя на оживлении;
- режиссёр пишет сценку 1, сценарист — сценку 2; разбор, правила 16–18 в `short-rules.ts`, паспорта и приёмы юмора в промптах, описания сценок последних 20 роликов;
- задание `animate` в рабочем процессе студии: клипы в MinIO (`shorts/<id>/skits/<отпечаток>/…`), срок этапа 25 минут, аренда 30 минут;
- состав и траты Omni в подписи владельцу; настройки «Формат» и «Предел секунд Omni» и предпросмотр сценок в админке;
- формат `chat` как запасной; остаток задачи 37 плана 2 (сквозной прогон на стенде) на новом формате.

**Что план уточняет в спеке** (дописывается в спеку в задаче 17):
- У сценки есть поле `opening` — первый кадр (по нему рисуется кадр-эталон); `action` — всё действие за 8 с (по нему Omni оживляет кадр). Место, первый кадр и действие пишутся по-английски: они идут прямо в промпты. Реплики — по-русски. Роль героя в промпты не идёт: русский текст в кавычках генератор картинок рисует надписью.
- Отпечатков два (первые 16 hex от sha256): отпечаток кадра — от вида сценки, версии труппы и промпта кадра, у развязки ещё от отпечатка кадра конфликта; отпечаток клипа — от отпечатка кадра и промпта видео. Кадр лежит в `keyframes/<отпечаток кадра>.<jpg|png|webp>` (расширение — по типу картинки: Nano Banana Pro отдаёт JPEG), клип — в `skits/<отпечаток клипа>/`. Новая реплика переснимает только клип своей сценки с прежнего кадра; новое место конфликта перерисовывает и развязку. Промпты собирает код, поэтому порядок полей на отпечатки не влияет, а правка шаблона переснимает сценку.
- Кадры рисуются по очереди: кадр развязки — по кадру конфликта. Клипы снимаются параллельно. После отказа фильтра кадр не перерисовывается: по нему уже могла быть нарисована развязка. Кадр рисуется, только когда снимается новый клип: принятым сценкам он не нужен. Пропал кадр конфликта, а по нему уже есть клипы или кадр развязки — ошибка с подсказкой, а не тихая перерисовка.
- `planSkits` проверяет сценку до промптов: 2–3 разных героя, 1–3 реплики, непустые место, первый кадр, действие, роли и реплики; место, первый кадр и действие — строки без кириллицы и кавычек («» и латинских); правило 17 (реплика до 12 слов, сценка до 25). Та же проверка стоит внутри сборщиков промптов. Ошибка называет сценку. В строке состава промпта названы сами герои («the goose and the capybara»).
- Облик героя пишется через зверя («a cat boss», а не «a boss»): иначе генератор дорисует отдельного человека. Голоса Кеши и Бориса разведены по высоте. В паспортах сверх таблицы спеки роли: «заёмщик» (Кеша), «начальник» (Борис), «мастер» (Михалыч), «риелтор» (Жорик).
- Секунды Omni резервируются до запуска клипа (так две параллельные сценки не проходят предел вдвоём) и возвращаются только при явном отказе Google — квота, ключ, снятая модель, фильтр. При потерянном ответе — нет: генерация могла начаться и будет оплачена.
- id запущенной генерации хранится в `animation.json` (`pending`): после срока ожидания (`omni_timeout`), сбоя ключа или квоты следующий запуск дожидается той же генерации, а не платит снова. Готовая генерация, которую студия не может забрать (ответ незнакомой формы, опрос отвергнут, ссылка не отдаёт файл), — `omni_unreadable` без повтора: id остаётся, запуск после правки студии заберёт её без новой оплаты.
- Кадр-эталон рисуется до трёх попыток; заблокированный промпт кадра — ошибка без повтора и без единого запуска Omni. Предел секунд Omni проверяется и до кадра: кадр тоже стоит денег. Оплаченный `raw.mp4` живёт до брака; брак не удаляется, а откладывается в `rejected-<время>.mp4`.
- Ошибки распознавания не пересъёмка: SpeechKit повторяется сам до трёх раз, пустой ответ спрашивается ещё раз, затем задание падает без повтора — клип Omni уже оплачен. SpeechKit просится писать числа словами (`rawResults=true`).
- Сверка речи сравнивает только слова с кириллицей и гласной (числа и латиницу SpeechKit пишет по-своему, «Ш-ш-ш» не проверяется), знак ударения слово не делит, склеенный повтор слога («гага») засчитывается за «га-га». Отдельно ловится проглоченная реплика или её последнее предложение (обрыв клипа) — клип не годится, если от них не услышано ни одного слова от трёх букв.
- Смена громкости или порогов пауз (поле `post` клипа) переобрабатывает принятый клип из `raw.mp4` без Omni и без SpeechKit. Обработка идёт во временный файл: если принятый клип при новых настройках не проходит проверку, запись и `clip.mp4` остаются прежними, и повтор с теми же настройками ничего не тратит. Принятый клип без `raw.mp4` — ошибка, а не тихая пересъёмка.
- Субтитры реплик сценки: пара «отрезок речи — реплика» засчитывается, только если длина отрезка правдоподобна для длины текста; если отрезков больше, чем реплик, граница встаёт в паузу, ближайшую к оценке по тексту. Порог тишины — число в дБ.
- Пауза в клипе и в ролике со сценками — до 3 с (`SKIT_MAX_SILENCE_SEC`, стартовое значение; сверяется на образце). Паузы между репликами ищутся порогом −30 дБ, от 0,25 с.
- Длина сцены и ролика меряется по видеодорожке: звук AAC выходит длиннее видео на десятки мс, и ролик ровно на пределе, пропущенный таймлайном, падал бы на проверке файла.
- Зацепка ролика со сценками — немая надпись поверх конфликта, держится 3 с (`SKIT_HOOK_MS`) и гаснет за 8 кадров. Для плана 4: у зацепки сценок предел слов строже (≈ 5–6 слов, ≈ 30 знаков) — её читают.
- Ролик со сценками собирает отдельная композиция `SkitShort` (композиция `Short` не тронута). Субтитры реплик сценок рисует композиция одним слоем (`CueCaptions`), а не `Clip.tsx`. Время реплик сценки сверяется со сценарием: расхождение — ошибка, а не ролик без субтитров.
- Обложка ролика со сценками — кадр 20 конфликта с надписью-зацепкой, без субтитров реплик. Remotion рисует пропсы, с которыми выбрана композиция, поэтому у обложки свой выбор композиции.
- Сборка проверяет `animation.json` и файлы клипов до озвучки и бандла; таймлайн — длину клипов (конечная, не короче зацепки) и пишет длину ролика с разбивкой «сценки / озвучка»: сценарист может сократить только озвучку.
- `animation.json` студии (`ShortAnimation`): сценки — `Partial` (частично заполненный файл — нормальное состояние), пути — относительно папки ролика; в плане 4 — ключи MinIO. Испорченный файл — ошибка, а не счёт с нуля; запись атомарная. Кроме секунд Omni считаются кадры (`keyframes`), CLI печатает сумму в $. Оживление требует ключей Google и SpeechKit; ключ Google вне оживления не читается.

---

## Как работать

- **Воркдерево на маке:** `/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts`, ветка `feat/promo-shorts` (спека сценок — `96bf5b8`). Ниже `WT` — этот путь. Git — через `git -C "$WT"`, без `cd` в цепочках.
- **Всё тяжёлое — на тестовой ноде** через `"$WT"/studio/scripts/node-run.sh "<команда>"`. Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит. **Незакоммиченное на ноду не уезжает:** красный тест сначала коммитится (`test(...): … (красный)`), потом гоняется.
  - Студия (команда выполняется в `studio/`): `"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"`.
  - Бэкенд (команда выполняется в корне): `NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts"`.
  - Гейт типов бэкенда: `NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"`. jest типы не проверяет (`isolatedModules`).
  - Гейт типов студии: `"$WT"/studio/scripts/node-run.sh "npm run typecheck && echo TSC_OK"`.
- **Любой вызов `node-run.sh` — с `timeout: 600000`;** долгие (рендер, оживление) — с `run_in_background`. Код 75 — воркдерево ноды занято другим прогоном (повторить позже), 3 — воркдерево не встало на коммит (команда не запускалась; это не «ожидаемый красный»), 255 — ssh сброшен по `MaxStartups` (повторить через 1–2 минуты, не петлёй).
- **SSH к ноде — через одно мастер-соединение:** все `ssh` и `scp` в плане идут с опциями `-o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m`. Опции пишутся в команде явно: шелл агента — zsh, и переменная с опциями в нём не делится на слова — ssh получает одну строку и падает с `keyword connecttimeout extra arguments`.
- **Живой чекаут `~/spirits_back` на ноде не трогать:** из него работает test.linkeon.io. Из его `.env` можно только читать.
- **Ничего не вливать в main и не выкатывать.** Этот план выкат не требует вовсе.
- **Секреты.** Ключ Google живёт только в `~/ci/wt/promo-shorts/studio/.env` на ноде. Не печатать его, не класть в репозиторий (репозитории Linkeon публичные), не передавать в командной строке.
- **Деньги.** Каждый запуск Omni — $0,80 (8 с при 720p), кадр Nano Banana Pro — около $0,13. Живые вызовы Google — только в задачах 16–17. На образец со всеми итерациями — не больше $10 без отдельного вопроса владельцу.
- **Ревьюерам-субагентам:** никаких `git checkout` и `git switch` в общем воркдереве. «Красное» состояние смотреть через `git show <sha>:<путь>`.
- **Коммиты** — по-русски, с префиксом (`feat(shorts):`, `test(shorts):`, `feat(studio):`, `test(studio):`, `fix(...)`, `docs(...)`). Последняя строка каждого сообщения — `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Кириллица и эмодзи пишутся в файлы как есть.** Escape-последовательностей вида `\uXXXX` в коде нет и не вводить: инструмент записи их портит.
- **Список тестов студии — явный.** `scripts.test` в `studio/package.json` перечисляет файлы. Новый файл теста, не дописанный туда, в `npm test` не попадёт.

## Файлы

| Файл | За что отвечает |
|---|---|
| `studio/assets/troupe/v1/sheet.png`, `<id>.png` | Утверждённый лист труппы и портреты героев |
| `src/shorts/short-troupe.ts` | Паспорта героев, версия труппы |
| `src/shorts/short-skit-prompts.ts` | Форма сценки, промпты кадра и видео, отпечаток, `planSkit` |
| `scripts/shorts-skit-plan.ts` | CLI: сценки + сценарий → сценарий студии с готовыми промптами |
| `studio/samples/zalog/skits.json`, `script.base.json` | Сценки и сценарий образца |
| `src/shorts/shorts.contract.spec.ts` | Сторож полей сценок в типах студии |
| `studio/src/types.ts` | `SKIT_KINDS`, `SkitPlan`, `SkitClip`, `ShortAnimation`, `SkitTimeline`, `SkitShortProps` |
| `studio/src/errors.ts` | Коды ошибок оживления |
| `studio/src/config.ts`, `studio/.env.example` | Ключ Google |
| `studio/src/animate/match.ts` | Сверка распознанной речи с репликами |
| `studio/src/animate/cues.ts` | Отрезки речи и время реплик по паузам |
| `studio/src/animate/google.ts` | Nano Banana Pro и Omni |
| `studio/src/animate/stt.ts` | Звук клипа → SpeechKit v1 |
| `studio/src/animate/clip-check.ts` | Проверка клипа и выравнивание громкости |
| `studio/src/animate/run-animate.ts` | Задание `animate` и CLI `npm run animate` |
| `studio/src/ffprobe.ts` | Пороги поиска пауз, длина по видеодорожке, пределы ролика со сценками |
| `studio/src/timeline.ts` | `buildSkitTimeline` |
| `studio/src/script.ts` | Проверка сценария со сценками |
| `studio/src/remotion/Caption.tsx`, `scenes/Hook.tsx`, `scenes/Clip.tsx`, `SkitShort.tsx`, `Root.tsx` | Композиция `SkitShort` |
| `studio/src/render/props.ts` | `buildSkitProps` |
| `studio/src/render/run-render.ts`, `run-render.test.ts` | Сборка ролика со сценками; проверка клипов до озвучки, обложка |
| `studio/src/render/render-skit.fixture.ts` | Сборка ролика со сценками из фикстуры без сети |

---

### Task 1: Портреты труппы в студии

Лист утверждён владельцем 26.10.2026 (`~/Downloads/linkeon_shorts/troupe-v1.png`, 1376×768). Портреты вырезаются по проверенным границам. Герои на листе местами заходят друг на друга, поэтому у четырёх портретов куски соседей по краям закрашиваются цветом фона.

**Files:**
- Create: `studio/assets/troupe/v1/sheet.png`, `kesha.png`, `galina.png`, `boris.png`, `mikhalych.png`, `zhorik.png`

- [ ] **Step 1: Скопировать лист, вырезать портреты и закрасить куски соседей**

Это лёгкая операция, её можно делать на маке.

```bash
WT=/Users/dmitry/Downloads/spirits_back/.worktrees/promo-shorts
D="$WT/studio/assets/troupe/v1"
mkdir -p "$D"
cp ~/Downloads/linkeon_shorts/troupe-v1.png "$D/sheet.png"
for spec in kesha:262:560:30:130 galina:252:560:302:120 boris:282:560:542:130 mikhalych:250:560:815:130 zhorik:276:560:1070:130; do
  IFS=: read n w h x y <<<"$spec"
  ffmpeg -hide_banner -loglevel error -y -i "$D/sheet.png" -vf "crop=$w:$h:$x:$y" "$D/$n.png"
done
# Герои на листе заходят друг на друга: у четырёх портретов по краям остаются куски
# соседей. Они закрашиваются полосами по 8 px цветом фона из соседнего столбца.
fill() { ffmpeg -hide_banner -loglevel error -y -i "$D/$1.png" -vf "$2" "$D/$1.fill.png" && mv "$D/$1.fill.png" "$D/$1.png"; }
fill boris 'drawbox=x=0:y=290:w=16:h=8:color=0xdfc499:t=fill,drawbox=x=0:y=298:w=16:h=8:color=0xddc098:t=fill,drawbox=x=0:y=306:w=16:h=8:color=0xdec495:t=fill,drawbox=x=0:y=314:w=16:h=8:color=0xe0c295:t=fill,drawbox=x=0:y=322:w=16:h=8:color=0xe2c698:t=fill,drawbox=x=0:y=330:w=16:h=8:color=0xe0c496:t=fill,drawbox=x=0:y=338:w=16:h=8:color=0xe0c59c:t=fill,drawbox=x=0:y=346:w=16:h=8:color=0xdec79d:t=fill,drawbox=x=0:y=354:w=16:h=8:color=0xe1c69d:t=fill,drawbox=x=0:y=362:w=16:h=8:color=0xe1c49a:t=fill,drawbox=x=0:y=370:w=16:h=8:color=0xe4c699:t=fill,drawbox=x=0:y=378:w=16:h=8:color=0xe3c79a:t=fill,drawbox=x=0:y=386:w=16:h=8:color=0xe1ca9b:t=fill,drawbox=x=0:y=394:w=16:h=8:color=0xe1ca9b:t=fill,drawbox=x=0:y=402:w=16:h=8:color=0xe4ca9b:t=fill,drawbox=x=0:y=410:w=16:h=5:color=0xe4c99e:t=fill,drawbox=x=256:y=476:w=26:h=8:color=0xdec398:t=fill,drawbox=x=256:y=484:w=26:h=8:color=0xddc096:t=fill,drawbox=x=256:y=492:w=26:h=8:color=0xd9bb8d:t=fill,drawbox=x=256:y=500:w=26:h=8:color=0xd4b488:t=fill,drawbox=x=256:y=508:w=26:h=8:color=0xccac7f:t=fill'
fill mikhalych 'drawbox=x=0:y=275:w=17:h=8:color=0xe0c698:t=fill,drawbox=x=0:y=283:w=17:h=8:color=0xdec69a:t=fill,drawbox=x=0:y=291:w=17:h=8:color=0xe0c697:t=fill,drawbox=x=0:y=299:w=17:h=8:color=0xdec798:t=fill,drawbox=x=0:y=307:w=17:h=8:color=0xe0c399:t=fill,drawbox=x=0:y=315:w=17:h=8:color=0xe0c698:t=fill,drawbox=x=0:y=323:w=17:h=8:color=0xe0c59a:t=fill,drawbox=x=0:y=331:w=17:h=8:color=0xdfc597:t=fill,drawbox=x=0:y=339:w=17:h=8:color=0xe0c698:t=fill,drawbox=x=0:y=347:w=17:h=8:color=0xdfc79b:t=fill,drawbox=x=0:y=355:w=17:h=8:color=0xdec496:t=fill,drawbox=x=0:y=363:w=17:h=8:color=0xdec294:t=fill,drawbox=x=0:y=371:w=17:h=8:color=0xdfc597:t=fill,drawbox=x=0:y=379:w=17:h=8:color=0xdfc597:t=fill,drawbox=x=0:y=387:w=17:h=8:color=0xe1c99d:t=fill,drawbox=x=0:y=395:w=17:h=8:color=0xdfc99a:t=fill,drawbox=x=0:y=403:w=17:h=8:color=0xe1cb9b:t=fill,drawbox=x=0:y=411:w=17:h=8:color=0xe1ca9e:t=fill,drawbox=x=0:y=419:w=17:h=1:color=0xe3cd9e:t=fill'
fill zhorik 'drawbox=x=0:y=285:w=24:h=8:color=0xddc194:t=fill,drawbox=x=0:y=293:w=24:h=8:color=0xdcc090:t=fill,drawbox=x=0:y=301:w=24:h=8:color=0xdcbe8e:t=fill,drawbox=x=0:y=309:w=24:h=8:color=0xdcbf95:t=fill,drawbox=x=0:y=317:w=24:h=8:color=0xdec69a:t=fill,drawbox=x=0:y=325:w=24:h=8:color=0xdfc49b:t=fill,drawbox=x=0:y=333:w=24:h=8:color=0xdbc495:t=fill,drawbox=x=0:y=341:w=24:h=8:color=0xdec496:t=fill,drawbox=x=0:y=349:w=24:h=8:color=0xe0c698:t=fill,drawbox=x=0:y=357:w=24:h=8:color=0xe1c598:t=fill,drawbox=x=0:y=365:w=24:h=8:color=0xe1c798:t=fill,drawbox=x=0:y=373:w=24:h=8:color=0xdfc898:t=fill,drawbox=x=0:y=381:w=24:h=8:color=0xe0c698:t=fill,drawbox=x=0:y=389:w=24:h=8:color=0xe0c99a:t=fill,drawbox=x=0:y=397:w=24:h=8:color=0xe2c699:t=fill'
fill galina 'drawbox=x=233:y=452:w=19:h=8:color=0xe3cc9d:t=fill,drawbox=x=233:y=460:w=19:h=8:color=0xe4c99e:t=fill,drawbox=x=233:y=468:w=19:h=8:color=0xe2c89a:t=fill,drawbox=x=233:y=476:w=19:h=8:color=0xdfc499:t=fill,drawbox=x=233:y=484:w=19:h=8:color=0xdfc096:t=fill,drawbox=x=233:y=492:w=19:h=6:color=0xdbbd90:t=fill'
ls -la "$D"
```

Expected: шесть файлов `sheet.png`, `kesha.png`, `galina.png`, `boris.png`, `mikhalych.png`, `zhorik.png`.

- [ ] **Step 2: Посмотреть портреты рядом**

```bash
ffmpeg -hide_banner -loglevel error -y -i "$D/kesha.png" -i "$D/galina.png" -i "$D/boris.png" -i "$D/mikhalych.png" -i "$D/zhorik.png" \
  -filter_complex "[0][1][2][3][4]hstack=inputs=5" /tmp/troupe-strip.png
```

Открыть `/tmp/troupe-strip.png` (Read). Expected: слева направо капибара в свитере, гусыня в фартуке с ключами, кот в костюме со штампом, бобр в комбинезоне, енот в клетчатом пиджаке. У каждого портрета по краям нет кусков соседей. Если кусок соседа виден — закрасить его так же, функцией `fill` (прямоугольник полосами цветом соседнего фона), и повторить шаг 2.

- [ ] **Step 3: Commit**

```bash
git -C "$WT" add studio/assets/troupe/v1
git -C "$WT" commit -m "feat(studio): лист труппы v1 и портреты пятерых героев — эталоны для кадров сценок

Лист утверждён владельцем 26.10.2026. Границы вырезки (w:h:x:y):
kesha 262:560:30:130, galina 252:560:302:120, boris 282:560:542:130,
mikhalych 250:560:815:130, zhorik 276:560:1070:130.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Паспорта труппы (API)

**Files:**
- Create: `src/shorts/short-troupe.ts`
- Test: `src/shorts/short-troupe.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-troupe.spec.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { heroById, TROUPE, TROUPE_VERSION } from './short-troupe';

describe('труппа', () => {
  it('пятеро героев утверждённого листа', () => {
    expect(TROUPE.map((h) => h.id)).toEqual(['kesha', 'galina', 'boris', 'mikhalych', 'zhorik']);
  });

  it('промпт Omni однозначно называет говорящего, генераторам уходит только английский', () => {
    const who = TROUPE.map((h) => h.who);
    expect(new Set(who).size).toBe(who.length);
    for (const h of TROUPE) {
      expect(h.who).toMatch(/^the [a-z]+( [a-z]+)*$/);
      expect(h.look).toContain(h.who.replace(/^the /, ''));
      expect(h.voice).toMatch(/voice$/);
      expect(`${h.who} ${h.look} ${h.voice}`).not.toMatch(/[а-яё]/i);
    }
  });

  it('у каждого — роли и коронная фраза для режиссёра и сценариста', () => {
    for (const h of TROUPE) {
      expect(h.roles.length).toBeGreaterThan(0);
      expect(h.catchphrases.length).toBeGreaterThan(0);
    }
  });

  it('heroById находит героя по id и не находит чужого', () => {
    for (const h of TROUPE) expect(heroById(h.id)).toBe(h);
    expect(heroById('fox')).toBeUndefined();
  });

  it('у каждого героя есть портрет в студии', () => {
    for (const h of TROUPE) {
      const f = path.join(__dirname, '..', '..', 'studio', 'assets', 'troupe', TROUPE_VERSION, `${h.id}.png`);
      expect(fs.existsSync(f)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-troupe.spec.ts
git -C "$WT" commit -m "test(shorts): паспорта труппы (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts"
```

Expected: FAIL — `Cannot find module './short-troupe'`.

- [ ] **Step 3: Написать паспорта**

`src/shorts/short-troupe.ts`:

```ts
/**
 * Постоянная труппа роликов со сценками — паспорта героев.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Труппа».
 * Облик (`look`), голос (`voice`) и короткое имя в кадре (`who`) — по-английски:
 * из них код собирает промпты Nano Banana и Omni (short-skit-prompts.ts).
 * Роли, манера и коронные фразы — по-русски: их читают режиссёр и сценарист.
 * Портреты — studio/assets/troupe/<версия>/<id>.png, вырезаны из листа,
 * утверждённого владельцем 26.10.2026.
 *
 * Текст паспорта (голос, уточнение облика) правится на месте: отпечатки сценок
 * считаются от промптов, и сценки с новым текстом переснимутся сами. Новая
 * версия листа нужна, когда меняется картинка — новый герой или новый облик:
 * старые ролики остаются со своими портретами.
 */
export const TROUPE_VERSION = 'v1';

export type TroupeId = 'kesha' | 'galina' | 'boris' | 'mikhalych' | 'zhorik';

export interface Hero {
  id: TroupeId;
  /** Имя в подписях владельцу и в промптах режиссёра. */
  name: string;
  /** Кто это в кадре, коротко: им промпт Omni называет говорящего. */
  who: string;
  /**
   * Облик — совпадает с портретом: текст и картинка вместе уходят в Nano Banana.
   * Профессия — через зверя («a cat boss»), а не «a boss»: иначе генератор
   * дорисует отдельного человека.
   */
  look: string;
  /** Описание голоса для Omni: одно и то же в каждом промпте держит голос узнаваемым. */
  voice: string;
  manner: string;
  /** Правило 16: в сценке у героя роль только из этого списка. */
  roles: string[];
  catchphrases: string[];
}

export const TROUPE: readonly Hero[] = [
  {
    id: 'kesha',
    name: 'Капибара Кеша',
    who: 'the capybara',
    look: 'a brown capybara with a calm, slightly sleepy face, wearing a chunky beige knitted sweater',
    voice: 'soft, calm, unhurried mid-pitched male voice',
    manner: 'Главный герой, «обычный человек». Невозмутим, сколько бы на него ни кричали. Не спорит и не паникует — открывает Linkeon.',
    roles: ['жилец', 'работник', 'покупатель', 'клиент', 'сосед', 'муж', 'предприниматель', 'заёмщик'],
    catchphrases: ['Спокойно. Сейчас спрошу.'],
  },
  {
    id: 'galina',
    name: 'Гусыня Галина Петровна',
    who: 'the goose',
    look: 'a white goose with an orange beak and orange feet, a grumpy elderly goose lady wearing a cream apron with a pink rose print, holding a bunch of keys',
    voice: 'shrill, loud, grumpy elderly female voice',
    manner: 'Вечный противник. Скандалит, шипит, машет крыльями, тычет крылом в «улики». В развязке сдаётся.',
    roles: ['хозяйка квартиры', 'соседка', 'свекровь', 'вахтёрша', 'продавщица'],
    catchphrases: ['Га-га… ладно.'],
  },
  {
    id: 'boris',
    name: 'Кот Борис Аркадьевич',
    who: 'the cat',
    look: 'a fat grey tabby cat with yellow eyes, a pompous cat boss wearing a too-tight navy suit, white shirt and striped tie, holding a rubber stamp with a wooden handle',
    voice: 'booming, lazy, pompous bass voice',
    manner: 'Начальник. Важный и ленивый, всё «не положено». Ставит печать — и засыпает.',
    roles: ['работодатель', 'начальник', 'чиновник', 'налоговая', 'управляющая компания'],
    catchphrases: ['Не положено.'],
  },
  {
    id: 'mikhalych',
    name: 'Бобр Михалыч',
    who: 'the beaver',
    look: 'a brown beaver with big front teeth, a beaver handyman wearing blue denim overalls with a leather tool belt and a pencil behind his ear',
    voice: 'hoarse, cheerful middle-aged male voice',
    manner: 'Мастер. Работяга, вечно всё переделывает, смета растёт на глазах.',
    roles: ['подрядчик', 'сантехник', 'автосервис', 'строитель', 'мастер'],
    catchphrases: ['Тут всё переделывать, хозяин.'],
  },
  {
    id: 'zhorik',
    name: 'Енот Жорик',
    who: 'the raccoon',
    look: 'a raccoon with a sly grin, a raccoon salesman wearing a brown checkered jacket, white shirt and a gold chain',
    voice: 'fast-talking, slick, ingratiating male voice',
    manner: 'Хитрый продавец. Говорит быстро, обещает золотые горы, мелкий шрифт прячет.',
    roles: ['продавец', 'кредитный менеджер', 'мошенник по телефону', 'турагент', 'риелтор'],
    catchphrases: ['Только сегодня, только для вас!'],
  },
];

export function heroById(id: string): Hero | undefined {
  return TROUPE.find((h) => h.id === id);
}
```

- [ ] **Step 4: Прогнать тест и гейт типов**

```bash
git -C "$WT" add src/shorts/short-troupe.ts
git -C "$WT" commit -m "feat(shorts): паспорта труппы — облик и голос для промптов, роли и коронные фразы

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-troupe.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: `Tests: 5 passed`, затем `TSC_OK`.

---

### Task 3: Промпты сценок и отпечатки (API)

Отпечатков у сценки два. Кадр-эталон студия хранит по отпечатку кадра, клип — по отпечатку клипа, который включает отпечаток кадра. У развязки отпечаток кадра включает отпечаток кадра конфликта: её кадр рисуется по нему. Поэтому новая реплика переснимает только клип своей сценки с прежнего кадра, а новое место конфликта перерисовывает и развязку. Пару сценок планирует `planSkits`.

**Files:**
- Create: `src/shorts/short-skit-prompts.ts`
- Test: `src/shorts/short-skit-prompts.spec.ts`

- [ ] **Step 1: Написать падающий тест**

`src/shorts/short-skit-prompts.spec.ts`:

```ts
import { heroById, TROUPE_VERSION } from './short-troupe';
import {
  buildKeyframePrompt,
  buildVideoPrompt,
  planSkit,
  planSkits,
  Skit,
  SKIT_FORBIDDEN,
  SKIT_FRAMING,
  skitFingerprints,
} from './short-skit-prompts';

const conflict = (): Skit => ({
  cast: [
    { hero: 'galina', role: 'хозяйка квартиры' },
    { hero: 'kesha', role: 'жилец' },
  ],
  setting: 'shabby hallway of a rented flat',
  opening: 'The goose blocks the doorway, the capybara stands with a suitcase',
  action: 'The goose hisses and flaps her wings.',
  lines: [
    { hero: 'galina', text: 'Обои потёрли! Залог мой!' },
    { hero: 'kesha', text: 'Спокойно. Спрошу у юриста.' },
  ],
});

const punchline = (): Skit => ({
  ...conflict(),
  opening: 'The capybara holds up the phone',
  action: 'The goose lowers her wings.',
  lines: [
    { hero: 'kesha', text: 'Три года — нормальный износ.', box: 1 },
    { hero: 'galina', text: 'Га-га… ладно.' },
  ],
});

const galina = heroById('galina');
const kesha = heroById('kesha');

describe('промпт кадра', () => {
  it('облик героев из паспортов по порядку, место, первый кадр, рамка и запреты', () => {
    const p = buildKeyframePrompt(conflict(), { continuity: false });
    expect(p).toContain(`1) ${galina.look}; 2) ${kesha.look}.`);
    expect(p).toContain('Exactly 2 characters, each appears once.');
    expect(p).toContain('Setting: shabby hallway of a rented flat.');
    expect(p).toContain('The picture: The goose blocks the doorway, the capybara stands with a suitcase.');
    expect(p).toContain(SKIT_FRAMING);
    expect(p).toContain(SKIT_FORBIDDEN);
    expect(p).not.toContain('previous scene');
    expect(p).not.toContain('hisses');
  });

  it('без кириллицы и «ёлочек»: надписи генератор картинок рисует охотно', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: false })).not.toMatch(/[а-яё«»]/i);
  });

  it('у развязки — опора на кадр конфликта', () => {
    expect(buildKeyframePrompt(conflict(), { continuity: true })).toContain('The last image is the previous scene');
  });

  it('точка в конце фразы не удваивается, лишние пробелы схлопываются', () => {
    const s = conflict();
    s.setting = '  hallway.  ';
    s.opening = 'Goose   at the door';
    const p = buildKeyframePrompt(s, { continuity: false });
    expect(p).toContain('Setting: hallway. The picture: Goose at the door.');
  });

  it('состав: чужой герой, повтор, пустой — ошибка', () => {
    const fox = conflict();
    fox.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => buildKeyframePrompt(fox, { continuity: false })).toThrow(/fox.*нет в труппе/);
    const twice = conflict();
    twice.cast[1] = { hero: 'galina', role: 'соседка' };
    expect(() => buildKeyframePrompt(twice, { continuity: false })).toThrow(/galina.*дважды/);
    const empty = conflict();
    empty.cast = [];
    expect(() => buildKeyframePrompt(empty, { continuity: false })).toThrow(/нет героев/);
  });
});

describe('промпт видео', () => {
  it('действие и реплики по порядку, слово в слово, с голосом говорящего', () => {
    const p = buildVideoPrompt(conflict());
    expect(p).toContain('The goose hisses and flaps her wings.');
    const first = p.indexOf('«Обои потёрли! Залог мой!»');
    const second = p.indexOf('«Спокойно. Спрошу у юриста.»');
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(p).toContain(`1) ${galina.who} (${galina.voice}) says in Russian: «Обои`);
    expect(p).toContain('Only the speaker talks');
    expect(p).toContain(SKIT_FORBIDDEN);
  });

  it('реплика героя не из состава и сценка без реплик — ошибка', () => {
    const s = conflict();
    s.lines.push({ hero: 'boris', text: 'Не положено.' });
    expect(() => buildVideoPrompt(s)).toThrow(/boris.*не в составе/);
    const mute = conflict();
    mute.lines = [];
    expect(() => buildVideoPrompt(mute)).toThrow(/нет реплик/);
  });
});

describe('отпечатки', () => {
  const pair = () => planSkits({ conflict: conflict(), punchline: punchline() });

  it('та же пара — те же отпечатки; порядок полей не важен', () => {
    const a = pair();
    expect(a.conflict.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(a.conflict.keyframeFingerprint).toMatch(/^[0-9a-f]{16}$/);
    const reordered = Object.fromEntries(Object.entries(conflict()).reverse()) as unknown as Skit;
    const b = planSkits({ conflict: reordered, punchline: punchline() });
    expect(b.conflict.fingerprint).toBe(a.conflict.fingerprint);
    expect(b.punchline.fingerprint).toBe(a.punchline.fingerprint);
  });

  it('правка реплики конфликта — новый клип конфликта с прежнего кадра, развязка та же', () => {
    const a = pair();
    const s = conflict();
    s.lines[1].text = 'Спокойно.';
    const b = planSkits({ conflict: s, punchline: punchline() });
    expect(b.conflict.keyframeFingerprint).toBe(a.conflict.keyframeFingerprint);
    expect(b.conflict.fingerprint).not.toBe(a.conflict.fingerprint);
    expect(b.punchline).toEqual(a.punchline);
  });

  it('новое место конфликта перерисовывает и развязку', () => {
    const a = pair();
    const s = conflict();
    s.setting = 'stairwell of an old block of flats';
    const b = planSkits({ conflict: s, punchline: punchline() });
    expect(b.conflict.keyframeFingerprint).not.toBe(a.conflict.keyframeFingerprint);
    expect(b.punchline.keyframeFingerprint).not.toBe(a.punchline.keyframeFingerprint);
    expect(b.punchline.fingerprint).not.toBe(a.punchline.fingerprint);
  });

  it('роль и опора на абзац отпечатки не меняют', () => {
    const a = pair();
    const c = conflict();
    c.cast[0].role = 'соседка';
    const p = punchline();
    p.lines[0].box = 5;
    const b = planSkits({ conflict: c, punchline: p });
    expect(b.conflict.fingerprint).toBe(a.conflict.fingerprint);
    expect(b.punchline.fingerprint).toBe(a.punchline.fingerprint);
  });

  it('версия труппы входит в оба отпечатка', () => {
    const base = { kind: 'conflict' as const, keyframePrompt: 'k', videoPrompt: 'v' };
    const v1 = skitFingerprints({ ...base, troupeVersion: 'v1' });
    const v2 = skitFingerprints({ ...base, troupeVersion: 'v2' });
    expect(v2.keyframeFingerprint).not.toBe(v1.keyframeFingerprint);
    expect(v2.fingerprint).not.toBe(v1.fingerprint);
  });

  it('пустые поля, состав и реплики ловятся до промптов — с именем сценки', () => {
    const p = punchline();
    delete (p as any).setting;
    expect(() => planSkits({ conflict: conflict(), punchline: p })).toThrow(/сценка punchline: пустое поле setting/);
    const c = conflict();
    c.lines[0].text = '  ';
    expect(() => planSkits({ conflict: c, punchline: punchline() })).toThrow(/сценка conflict: пустая реплика героя galina/);
    const one = conflict();
    one.cast = [one.cast[0]];
    one.lines = [one.lines[0]];
    expect(() => planSkits({ conflict: one, punchline: punchline() })).toThrow(/сценка conflict: в составе нужно 2–3 героя/);
    const fox = punchline();
    fox.cast[0] = { hero: 'fox' as any, role: 'лиса' };
    expect(() => planSkits({ conflict: conflict(), punchline: fox })).toThrow(/сценка punchline: героя «fox» нет в труппе/);
  });

  it('развязку без кадра конфликта не планируем', () => {
    expect(() => planSkit(punchline(), 'punchline')).toThrow(/planSkits/);
  });

  it('план несёт сценку, версию труппы и героев в порядке состава', () => {
    const c = pair().conflict;
    expect(c.skit).toEqual(conflict());
    expect(c.troupeVersion).toBe(TROUPE_VERSION);
    expect(c.heroes).toEqual(['galina', 'kesha']);
  });
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add src/shorts/short-skit-prompts.spec.ts
git -C "$WT" commit -m "test(shorts): промпты сценок и отпечаток (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-skit-prompts.spec.ts"
```

Expected: FAIL — `Cannot find module './short-skit-prompts'`.

- [ ] **Step 3: Написать модуль**

`src/shorts/short-skit-prompts.ts`:

```ts
/**
 * Сценки роликов: форма, промпты для Nano Banana и Omni, отпечатки.
 *
 * Спека: docs/superpowers/specs/2026-10-26-shorts-skits-design.md, «Кто пишет
 * сценки». Режиссёр и сценарист отдают сценку полями, а промпт собирает код:
 * так облик и голос героев одинаковы из ролика в ролик, а запреты (текст,
 * экраны, логотипы, дети) не забываются. Место, первый кадр и действие пишутся
 * по-английски — они идут прямо в промпты; реплики — по-русски. Роль героя в
 * промпты не идёт: русский текст в кавычках генератор картинок охотно рисует
 * надписью.
 *
 * Отпечатков два. Кадр-эталон студия хранит по отпечатку кадра, клип — по
 * отпечатку клипа, который включает отпечаток кадра. Кадр развязки рисуется по
 * кадру конфликта, поэтому его отпечаток включает отпечаток кадра конфликта:
 * новое место конфликта перерисует и развязку, а новая реплика переснимет
 * только клип своей сценки — с прежнего кадра.
 *
 * `SkitPlan` — то, что читает студия (зеркало studio/src/types.ts).
 */
import { createHash } from 'crypto';
import { Hero, heroById, TROUPE_VERSION, TroupeId } from './short-troupe';

export type SkitKind = 'conflict' | 'punchline';

export interface SkitLine {
  hero: TroupeId;
  /** По-русски, до 12 слов. */
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  /** 2–3 разных героя; role — из ролей героя, для режиссёра и сценариста. */
  cast: { hero: TroupeId; role: string }[];
  /** Место, одной фразой. */
  setting: string;
  /** Первый кадр: расстановка и позы до начала действия — по нему рисуется кадр-эталон. */
  opening: string;
  /** Что происходит за 8 секунд и визуальный гэг — по нему Omni оживляет кадр. */
  action: string;
  /** 1–3 реплики, всего до 25 слов. */
  lines: SkitLine[];
}

export interface SkitPlan {
  skit: Skit;
  troupeVersion: string;
  /** Чьи портреты нужны кадру — в порядке состава. */
  heroes: TroupeId[];
  keyframePrompt: string;
  videoPrompt: string;
  /** Отпечаток кадра-эталона: по нему студия хранит и переиспользует кадр. */
  keyframeFingerprint: string;
  /** Отпечаток клипа: отпечаток кадра и промпт видео. Клип с тем же отпечатком не переснимается. */
  fingerprint: string;
}

export const SKIT_STYLE =
  'Claymation stop-motion: handmade plasticine characters with visible fingerprints and clay texture, warm miniature set lighting.';
export const SKIT_FRAMING = [
  'Tall vertical 9:16 phone frame.',
  'The picture fills the whole frame edge to edge: no borders, no letterbox bars, no blurred bands, no split screen, no picture-in-picture; the wall continues above and the floor below all the way to the edges.',
  'The characters are big, their faces in the middle of the frame, between a third and three fifths of its height: the top third is calm background, and the lower part shows only bodies, floor and props — titles go there.',
].join(' ');
export const SKIT_FORBIDDEN =
  'No text, letters, subtitles or logos anywhere. Any phone, monitor or TV is turned away, its screen is not visible. No real people and no children.';

/** Пробелы схлопнуты: лишний пробел от модели не должен менять отпечаток — пересъёмка стоит денег. */
const clean = (s: string): string => String(s ?? '').replace(/\s+/g, ' ').trim();
/** Фраза с точкой в конце — модель пишет то с точкой, то без. */
const sentence = (s: string): string => {
  const t = clean(s);
  return /[.!?…]$/.test(t) ? t : `${t}.`;
};

function castHeroes(skit: Skit): Hero[] {
  if (!skit.cast?.length) throw new Error('в сценке нет героев');
  const seen = new Set<string>();
  return skit.cast.map((c) => {
    const h = heroById(c.hero);
    if (!h) throw new Error(`героя «${c.hero}» нет в труппе ${TROUPE_VERSION}`);
    if (seen.has(h.id)) throw new Error(`«${c.hero}» дважды в составе сценки`);
    seen.add(h.id);
    return h;
  });
}

/**
 * Кадр-эталон: первый кадр сценки. Картинки уходят в генератор так: портреты
 * героев в порядке состава, у развязки последней — кадр конфликта.
 */
export function buildKeyframePrompt(skit: Skit, o: { continuity: boolean }): string {
  const heroes = castHeroes(skit);
  const cast = heroes.map((h, i) => `${i + 1}) ${h.look}`).join('; ');
  return [
    SKIT_STYLE,
    `The first ${heroes.length} images are portraits of the characters, in this order: ${cast}. Keep each character's look exactly as in the portrait; poses follow the scene.`,
    o.continuity
      ? 'The last image is the previous scene: keep the same costumes and lighting, and the same place unless the setting below says otherwise.'
      : '',
    `Exactly ${heroes.length} characters, each appears once.`,
    sentence(`Setting: ${skit.setting}`),
    sentence(`The picture: ${skit.opening}`),
    SKIT_FRAMING,
    SKIT_FORBIDDEN,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Клип: действие и реплики по порядку, у каждой — кто говорит и каким голосом (из паспорта). */
export function buildVideoPrompt(skit: Skit): string {
  const cast = new Set(castHeroes(skit).map((h) => h.id));
  if (!skit.lines?.length) throw new Error('в сценке нет реплик');
  const said = skit.lines
    .map((l, i) => {
      const h = heroById(l.hero);
      if (!h || !cast.has(h.id)) throw new Error(`«${l.hero}» говорит реплику, но не в составе сценки`);
      return `${i + 1}) ${h.who} (${h.voice}) says in Russian: «${clean(l.text)}»`;
    })
    .join(' ');
  return [
    SKIT_STYLE,
    'Animate this image: keep the characters, the set and the lighting exactly as in it.',
    sentence(skit.action),
    `Dialogue, spoken clearly in this order, each line word for word: ${said}`,
    'The first line starts right away. Only the speaker talks, the others listen; mouths and beaks move with the speech.',
    'Slightly jerky stop-motion movement, small comic gestures, no camera cuts, no music.',
    SKIT_FORBIDDEN,
  ].join(' ');
}

/**
 * Поля сценки проверяются до промптов: опечатка в имени поля дала бы «undefined»
 * в платном промпте, а сценарий проверяется только на сборке — после трат.
 */
function assertSkit(skit: Skit): void {
  if (!skit || typeof skit !== 'object') throw new Error('нет сценки');
  for (const f of ['setting', 'opening', 'action'] as const) {
    if (!clean(skit[f])) throw new Error(`пустое поле ${f}`);
  }
  if (!Array.isArray(skit.cast) || skit.cast.length < 2 || skit.cast.length > 3) throw new Error('в составе нужно 2–3 героя');
  for (const c of skit.cast) if (!clean(c?.role)) throw new Error(`у героя ${c?.hero} нет роли`);
  if (!Array.isArray(skit.lines) || skit.lines.length < 1 || skit.lines.length > 3) throw new Error('нужно 1–3 реплики');
  for (const l of skit.lines) if (!clean(l?.text)) throw new Error(`пустая реплика героя ${l?.hero}`);
}

const hash16 = (parts: string[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);

/** Отпечатки сценки. У развязки в отпечаток кадра входит отпечаток кадра конфликта. */
export function skitFingerprints(p: {
  kind: SkitKind;
  troupeVersion: string;
  keyframePrompt: string;
  videoPrompt: string;
  conflictKeyframe?: string;
}): { keyframeFingerprint: string; fingerprint: string } {
  const keyframeFingerprint = hash16([p.kind, p.troupeVersion, p.keyframePrompt, p.conflictKeyframe ?? '']);
  return { keyframeFingerprint, fingerprint: hash16([keyframeFingerprint, p.videoPrompt]) };
}

/** Одна сценка. Развязке нужен отпечаток кадра конфликта — пару планирует planSkits. Ошибки — с именем сценки. */
export function planSkit(skit: Skit, kind: SkitKind, conflictKeyframe?: string): SkitPlan {
  if (kind === 'punchline' && !conflictKeyframe) {
    throw new Error('сценка punchline: развязка рисуется по кадру конфликта — планируйте пару через planSkits');
  }
  try {
    assertSkit(skit);
    const keyframePrompt = buildKeyframePrompt(skit, { continuity: kind === 'punchline' });
    const videoPrompt = buildVideoPrompt(skit);
    return {
      skit,
      troupeVersion: TROUPE_VERSION,
      heroes: skit.cast.map((c) => c.hero),
      keyframePrompt,
      videoPrompt,
      ...skitFingerprints({ kind, troupeVersion: TROUPE_VERSION, keyframePrompt, videoPrompt, conflictKeyframe }),
    };
  } catch (e) {
    throw new Error(`сценка ${kind}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function planSkits(s: Record<SkitKind, Skit>): Record<SkitKind, SkitPlan> {
  const conflict = planSkit(s.conflict, 'conflict');
  return { conflict, punchline: planSkit(s.punchline, 'punchline', conflict.keyframeFingerprint) };
}
```

- [ ] **Step 4: Прогнать тест и гейт типов**

```bash
git -C "$WT" add src/shorts/short-skit-prompts.ts
git -C "$WT" commit -m "feat(shorts): промпты сценок кодом — облик и голос из паспортов, постоянные запреты, отпечатки кадра и клипа

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/short-skit-prompts.spec.ts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: `Tests: 15 passed`, затем `TSC_OK`.

---

### Task 4: Сценарий образца с готовыми промптами

CLI бэкенда превращает сценки образца в пару `SkitPlan` (`planSkits`) и кладёт её в сценарий студии. Студия — отдельный ESM-пакет и не может импортировать код бэкенда, поэтому промпты собираются здесь.

Сценарий образца построен на настоящей съёмке стенда (ролик `987f6045`, юрист Алексей, залог). Абзацы его ответа: 1 — «Нормальный износ за три года жизни — не повод оставлять залог себе…», 3 — ст. 622 ГК РФ про нормальный износ, 5 — ст. 15 ГК РФ: ущерб хозяйка должна доказать.

**Files:**
- Create: `scripts/shorts-skit-plan.ts`
- Create: `studio/samples/zalog/skits.json`, `studio/samples/zalog/script.base.json`

- [ ] **Step 1: Сценки образца**

`studio/samples/zalog/skits.json`:

```json
{
  "conflict": {
    "cast": [
      { "hero": "galina", "role": "хозяйка квартиры" },
      { "hero": "kesha", "role": "жилец" }
    ],
    "setting": "a tidy but slightly worn hallway of a rented flat, the front door open",
    "opening": "The capybara stands next to his suitcase and holds out an open paw; the goose blocks the doorway with her wings spread wide.",
    "action": "The goose points a wing at a tiny scuff on the wallpaper, hisses and flaps her wings. The capybara listens calmly. At the end he takes a phone out of his sweater pocket, its back to the camera.",
    "lines": [
      { "hero": "galina", "text": "Обои потёрли! Залог мой, весь до копейки!" },
      { "hero": "kesha", "text": "Спокойно. Спрошу у юриста." }
    ]
  },
  "punchline": {
    "cast": [
      { "hero": "kesha", "role": "жилец" },
      { "hero": "galina", "role": "хозяйка квартиры" }
    ],
    "setting": "a tidy but slightly worn hallway of a rented flat, the front door open",
    "opening": "The goose stands in the doorway with her wings raised, clutching her bunch of keys; the capybara calmly holds up his phone towards her like an official document, its back to the camera.",
    "action": "The capybara speaks calmly, still holding up the phone. Then the goose freezes, her feathers stand on end, the keys clatter to the floor, and she slowly lowers her wings.",
    "lines": [
      { "hero": "kesha", "text": "За три года это нормальный износ. Залог верните.", "box": 1 },
      { "hero": "galina", "text": "Га-га… ладно." }
    ]
  }
}
```

`studio/samples/zalog/script.base.json` — сценарий студии без сценок. Зацепки-реплики `hook` нет: у ролика со сценками зацепка — надпись поверх конфликта.

```json
{
  "hook": "Весь залог — за потёртые обои?",
  "hookBox": 1,
  "voice": "madirus",
  "speed": 1.1,
  "lines": [
    { "id": "q", "scene": "question", "text": "Я Алексей, юрист. Жилец спросил, законно ли это." },
    { "id": "a1", "scene": "answer", "box": 3, "text": "Квартиру возвращают с учётом нормального износа. Потёртые у дивана обои и пара царапин на ламинате за три года — это и есть износ." },
    { "id": "a2", "scene": "answer", "box": 5, "text": "Ущерб хозяйка должна доказать и обосновать сумму. Сказать «не верну, и всё» нельзя." },
    { "id": "f", "scene": "final", "voice": "alena", "text": "Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле." }
  ],
  "final": { "assistantsCount": 18, "disclaimer": "Ответ ИИ, не заменяет юриста" }
}
```

- [ ] **Step 2: Написать CLI**

`scripts/shorts-skit-plan.ts`:

```ts
#!/usr/bin/env ts-node
/**
 * Сценки + сценарий студии → сценарий с готовыми промптами (ролик-образец
 * со сценками, план 3). В конвейере (план 4) то же самое сделает сценарист.
 *
 *   npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>
 *
 * skits.json — { conflict: Skit, punchline: Skit } (src/shorts/short-skit-prompts.ts);
 * script.base.json — сценарий студии без сценок (studio/src/types.ts, Script).
 * Ошибка входа — сообщение с именем файла и код 2: скрипт — последняя проверка
 * сценок перед платными генерациями.
 */
import * as fs from 'fs';
import * as path from 'path';
import { planSkits, Skit } from '../src/shorts/short-skit-prompts';

function fail(file: string, msg: string): never {
  console.error(`skit-plan: ${file} — ${msg}`);
  process.exit(2);
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fail(file, e instanceof Error ? e.message : String(e));
  }
}

const [skitsPath, basePath, outPath] = process.argv.slice(2);
if (!skitsPath || !basePath || !outPath) {
  console.error('usage: npx ts-node scripts/shorts-skit-plan.ts <skits.json> <script.base.json> <out/script.json>');
  process.exit(2);
}
const skits = readJson(skitsPath) as { conflict?: Skit; punchline?: Skit };
if (!skits?.conflict || !skits?.punchline) fail(skitsPath, 'нужны обе сценки: conflict и punchline');
const base = readJson(basePath);
let plans: ReturnType<typeof planSkits>;
try {
  plans = planSkits({ conflict: skits.conflict, punchline: skits.punchline });
} catch (e) {
  fail(skitsPath, e instanceof Error ? e.message : String(e));
}
const script = { ...base, skits: plans };
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(script, null, 2));
console.log(`skit-plan: ${outPath} — conflict ${plans.conflict.fingerprint}, punchline ${plans.punchline.fingerprint}`);
```

- [ ] **Step 3: Закоммитить и прогнать CLI на ноде**

```bash
git -C "$WT" add scripts/shorts-skit-plan.ts studio/samples/zalog
git -C "$WT" commit -m "feat(shorts): сценарий образца со сценками — CLI кладёт в сценарий студии готовые промпты

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx ts-node scripts/shorts-skit-plan.ts studio/samples/zalog/skits.json studio/samples/zalog/script.base.json /tmp/skit-plan-check.json && node -e 'const s=require(\"/tmp/skit-plan-check.json\"); for (const k of [\"conflict\",\"punchline\"]) { const p=s.skits[k]; if (p.fingerprint.length !== 16 || p.keyframeFingerprint.length !== 16 || !p.videoPrompt.includes(\"«\") || p.troupeVersion !== \"v1\") throw new Error(k); } if (!s.skits.punchline.keyframePrompt.includes(\"previous scene\")) throw new Error(\"continuity\"); console.log(\"PLAN_OK\", s.skits.punchline.heroes.join(\",\"))' && (npx ts-node scripts/shorts-skit-plan.ts studio/samples/zalog/script.base.json studio/samples/zalog/script.base.json /tmp/skit-plan-bad.json || echo BAD_INPUT_EXIT=\$?)"
```

Expected: `skit-plan: /tmp/skit-plan-check.json — conflict <16 hex>, punchline <16 hex>`, затем `PLAN_OK kesha,galina`. Вход без сценок CLI отвергает: `skit-plan: studio/samples/zalog/script.base.json — нужны обе сценки: conflict и punchline`, затем `BAD_INPUT_EXIT=2`.

---

### Task 5: Типы сценок, коды ошибок и ключ Google в студии

**Files:**
- Modify: `studio/src/types.ts`
- Modify: `studio/src/errors.ts`
- Modify: `studio/src/config.ts`, `studio/src/config.test.ts`
- Modify: `studio/.env.example`
- Modify: `src/shorts/shorts.contract.spec.ts`

- [ ] **Step 1: Падающие тесты — ключ Google в конфиге и поля сценок в контракте**

В конец `studio/src/config.test.ts`:

```ts
test('оживлению сценок нужны ключи Google и SpeechKit; без оживления ключ Google не читается', () => {
  const animate = { capture: false, tts: false, animate: true };
  const speech = { YANDEX_SPEECHKIT_API_KEY: 'k', YANDEX_TTS_FOLDER_ID: 'f' };
  assert.throws(() => parseConfig(speech, animate), /GOOGLE_AI_API_KEY/);
  assert.throws(() => parseConfig({ GOOGLE_AI_API_KEY: 'g' }, animate), /YANDEX_SPEECHKIT_API_KEY/);
  const c = parseConfig({ GOOGLE_AI_API_KEY: 'g', ...speech }, animate);
  assert.equal(c.googleKey, 'g');
  assert.equal(c.speechkitKey, 'k');
  assert.equal(parseConfig({ GOOGLE_AI_API_KEY: 'g' }, none).googleKey, '');
});
```

В `src/shorts/shorts.contract.spec.ts` после строки `import * as path from 'path';` добавить `import { planSkits } from './short-skit-prompts';`, а перед последней строкой файла `});` — новый тест. Он ищет поле внутри своего типа (имена `skits` и `fingerprint` есть и в соседних типах) и берёт имена полей из настоящего плана сценок бэкенда, поэтому ловит рассинхрон в обе стороны:

```ts
  it('сценки: студия знает те же поля, что пишет план сценок бэкенда, и в тех же типах', () => {
    const types = studio('types.ts');
    // Поле ищется внутри своего типа: skits и fingerprint есть и в соседних типах.
    const block = (name: string): string => {
      const m = types.match(new RegExp(`(?:interface ${name}(?: extends [^{]+)? |type ${name} = )\\{([\\s\\S]*?)\\n\\}`));
      if (!m) throw new Error(`studio/src/types.ts: нет типа ${name}`);
      return m[1];
    };
    const has = (name: string, field: string) => expect(block(name)).toMatch(new RegExp(`^\\s*${field}\\??:`, 'm'));
    has('Script', 'skits');
    const skit = {
      cast: [{ hero: 'galina' as const, role: 'хозяйка квартиры' }, { hero: 'kesha' as const, role: 'жилец' }],
      setting: 'hallway',
      opening: 'at the door',
      action: 'argue',
      lines: [{ hero: 'kesha' as const, text: 'Это износ.', box: 1 }],
    };
    const { punchline } = planSkits({ conflict: skit, punchline: skit });
    for (const f of Object.keys(punchline)) has('SkitPlan', f);
    for (const f of Object.keys(punchline.skit)) has('Skit', f);
    for (const f of Object.keys(punchline.skit.lines[0])) has('SkitLine', f);
    const kind = /export type SkitKind = ([^;]+);/;
    expect(types.match(kind)?.[1]).toBe(fs.readFileSync(path.join(__dirname, 'short-skit-prompts.ts'), 'utf8').match(kind)?.[1]);
  });
```


- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/config.test.ts src/shorts/shorts.contract.spec.ts
git -C "$WT" commit -m "test(studio): ключ Google для оживления и поля сценок в контракте (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/config.test.ts"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"
```

Expected: оба FAIL — тест конфига ждёт ошибку про `GOOGLE_AI_API_KEY`; сторож контракта не находит поле `skits` в типе `Script` студии.

- [ ] **Step 3: Типы сценок**

В `studio/src/types.ts` в интерфейс `Script` после поля `final` добавить поле `skits`:

```ts
  /** Число ассистентов — из базы; его же словами произносит финальная реплика (сценарий пишет бэкенд). */
  final: { assistantsCount: number; disclaimer?: string };
  /** Сценки — у ролика формата «Сценки». Без них ролик собирается по-старому (композиция Short). */
  skits?: Record<SkitKind, SkitPlan>;
}
```

В конец `studio/src/types.ts`:

```ts
// ── Сценки (спека docs/superpowers/specs/2026-10-26-shorts-skits-design.md) ──

export type SkitKind = 'conflict' | 'punchline';

export interface SkitLine {
  /** id героя труппы (src/shorts/short-troupe.ts бэкенда). */
  hero: string;
  text: string;
  /** Абзац ответа, на который опирается утверждение по существу (только в развязке). */
  box?: number;
}

export interface Skit {
  cast: { hero: string; role: string }[];
  setting: string;
  /** Первый кадр — по нему рисуется кадр-эталон. */
  opening: string;
  /** Что происходит за 8 секунд — по нему Omni оживляет кадр. */
  action: string;
  lines: SkitLine[];
}

/** Сценка, готовая к оживлению: промпты и отпечатки собрал бэкенд (src/shorts/short-skit-prompts.ts, SkitPlan). */
export interface SkitPlan {
  skit: Skit;
  /** Версия листа труппы: портреты — assets/troupe/<версия>/<id>.png. */
  troupeVersion: string;
  /** Чьи портреты нужны кадру — в порядке состава. */
  heroes: string[];
  keyframePrompt: string;
  videoPrompt: string;
  /** Отпечаток кадра-эталона: кадр лежит в keyframes/<отпечаток>.png и с тем же отпечатком не перерисовывается. */
  keyframeFingerprint: string;
  /** Отпечаток клипа (включает отпечаток кадра): клип с тем же отпечатком не переснимается. */
  fingerprint: string;
}

/** Время реплики сценки в клипе: line — номер в skit.lines с 0, время — мс от начала клипа. */
export interface SkitCue {
  line: number;
  startMs: number;
  endMs: number;
}

/** Готовая сценка. Пути — относительно папки ролика. */
export interface SkitClip {
  fingerprint: string;
  /** keyframes/<отпечаток кадра>.png */
  keyframe: string;
  /** skits/<отпечаток клипа>/clip.mp4 — громкость уже выровнена. */
  clip: string;
  durationMs: number;
  /** Что распознал SpeechKit в клипе. */
  heard: string;
  cues: SkitCue[];
  /** Номер удачной попытки в последнем запуске animate; оплаченные клипы считает omniSeconds. */
  attempts: number;
  /** Настройки бесплатной обработки (громкость, пороги пауз): при их смене клип переобрабатывается из raw.mp4, без Omni. */
  post: string;
}

/**
 * animation.json папки ролика — итог задания animate. Сценки — Partial:
 * частично заполненный файл — нормальное состояние (одна сценка готова,
 * другая упала). Не Animation: так называется тип DOM.
 */
export interface ShortAnimation {
  /** Секунды Omni, потраченные на ролик, со всеми попытками. */
  omniSeconds: number;
  skits: Partial<Record<SkitKind, SkitClip>>;
}

export interface SkitTimeline {
  segments: Segment[];
  scenes: Record<SkitKind | 'question' | 'answer' | 'final', SceneSpan>;
  totalFrames: number;
}

/** Субтитр в кадрах от начала ролика — у реплик сценок. */
export interface ClipCue {
  key: string;
  text: string;
  from: number;
  duration: number;
}

/** Пропсы композиции SkitShort. Как и ShortProps — type, а не interface. */
export type SkitShortProps = {
  fps: number;
  hook: string;
  badge?: string;
  questionShot: string;
  answerShot: string;
  answerShotHeight: number;
  boxes: ImageBox[];
  timeline: SkitTimeline;
  final: { assistantsCount: number; disclaimer?: string };
  clips: Record<SkitKind, { video: string; cues: ClipCue[] }>;
};
```

- [ ] **Step 4: Коды ошибок оживления**

В `studio/src/errors.ts` в объединение `StudioErrorCode` перед `| 'unknown';` дописать:

```ts
  | 'no_input'
  | 'keyframe'
  | 'omni_rejected'
  | 'omni_failed'
  | 'omni_budget'
  | 'google_quota'
  | 'google_auth'
  | 'model_gone'
  | 'speech_mismatch'
  | 'clip_invalid'
  | 'stt'
  | 'unknown';
```

(строка `| 'no_input'` уже есть — заменить хвост `| 'no_input'\n  | 'unknown';` на блок выше).

- [ ] **Step 5: Ключ Google в конфиге**

В `studio/src/config.ts`:

1. В `StudioConfig` после `speechkitFolder: string;`:

```ts
  /** Ключ Google (Nano Banana Pro и Omni) — заданию animate. */
  googleKey: string;
```

2. Сигнатура: `needs: { capture: boolean; tts: boolean; worker?: boolean; animate?: boolean }`.

3. После строки `const worker = needs.worker === true;` добавить `const speech = needs.tts || needs.animate === true;` — оживление распознаёт речь клипа, и пустой ключ SpeechKit всплыл бы уже после оплаты Omni. В возвращаемом объекте строки `speechkitKey: …` и `speechkitFolder: …` заменить тремя строками:

```ts
    speechkitKey: speech ? required(env, 'YANDEX_SPEECHKIT_API_KEY') : '',
    speechkitFolder: speech ? required(env, 'YANDEX_TTS_FOLDER_ID') : '',
    googleKey: needs.animate === true ? required(env, 'GOOGLE_AI_API_KEY') : '',
```

4. В комментарии над `parseConfig` фразу «озвучке — SpeechKit.» продолжить: «озвучке — SpeechKit, оживлению сценок — ключи Google и SpeechKit.» Ключ Google вне оживления не читается.

В `studio/.env.example` после строки `YANDEX_TTS_FOLDER_ID=`:

```
# Ключ Google (Nano Banana Pro и Omni) — оживление сценок (npm run animate). Тот же, что GOOGLE_AI_API_KEY бэкенда.
GOOGLE_AI_API_KEY=
```

- [ ] **Step 6: Прогнать тесты и типы**

```bash
git -C "$WT" add studio/src/types.ts studio/src/errors.ts studio/src/config.ts studio/.env.example
git -C "$WT" commit -m "feat(studio): типы сценок, коды ошибок оживления и ключ Google

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/config.test.ts src/errors.test.ts && npm run typecheck && echo TSC_OK"
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts/shorts.contract.spec.ts"
```

Expected: студия — все тесты `pass`, затем `TSC_OK`; бэкенд — `Tests: 4 passed`.

---

### Task 6: Сверка речи

**Files:**
- Create: `studio/src/animate/match.ts`
- Test: `studio/src/animate/match.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/match.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MATCH_THRESHOLD, speechCheck, speechWords } from './match';

test('слова — без регистра, знаков и с «е» вместо «ё»; дефис делит слово; NFD приводится к NFC', () => {
  assert.deepEqual(speechWords('Обои потёрли! Залог — мой.'), ['обои', 'потерли', 'залог', 'мой']);
  assert.deepEqual(speechWords('Га-га… ладно.'), ['га', 'га', 'ладно']);
  assert.deepEqual(speechWords('потёрли'.normalize('NFD')), ['потерли']);
});

test('всё сказано — годится; ничего не услышано — нет, обе реплики проглочены', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.deepEqual(speechCheck(lines, 'обои потерли залог мой спокойно спрошу у юриста'), { ok: true, share: 1, silentLines: [] });
  assert.deepEqual(speechCheck(lines, ''), { ok: false, share: 0, silentLines: [0, 1] });
});

test('числа цифрами и латиница не сверяются: SpeechKit пишет их по-своему', () => {
  assert.equal(speechCheck(['Залог 40 000 рублей.'], 'залог сорок тысяч рублей').share, 1);
  assert.equal(speechCheck(['Спрошу у Linkeon.'], 'спрошу у линкеон').share, 1);
});

test('слитное «гага» засчитывается за «га-га»', () => {
  assert.deepEqual(speechCheck(['Га-га… ладно.'], 'гага ладно'), { ok: true, share: 1, silentLines: [] });
  assert.equal(speechCheck(['Ай-ай-ай!'], 'айайай').share, 1);
});

test('проглоченная короткая реплика ловится, даже когда общая доля выше порога', () => {
  const r = speechCheck(['Обои потёрли! Залог мой, весь до копейки!', 'Спокойно. Спрошу у юриста.'], 'обои потерли залог мой весь до копейки');
  assert.ok(r.share >= MATCH_THRESHOLD);
  assert.deepEqual(r.silentLines, [1]);
  assert.equal(r.ok, false);
});

test('часть слов перевраны — доля услышанных; доля на пороге годится', () => {
  assert.deepEqual(speechCheck(['раз два три четыре пять'], 'раз два три'), { ok: true, share: 0.6, silentLines: [] });
  assert.equal(speechCheck(['раз два три четыре пять'], 'раз два').ok, false);
});

test('повтор слова считается столько раз, сколько сказан', () => {
  assert.equal(speechCheck(['да да ладно'], 'да ладно').share, 2 / 3);
});

test('реплик нет — сверять нечего', () => {
  assert.deepEqual(speechCheck([], 'что угодно'), { ok: true, share: 1, silentLines: [] });
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/capture/promo.test.ts"` на `src/capture/promo.test.ts src/animate/match.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/match.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): сверка распознанной речи с репликами (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Expected: FAIL — модуля `./match` нет (`ERR_MODULE_NOT_FOUND`).

- [ ] **Step 3: Написать модуль**

`studio/src/animate/match.ts`:

```ts
/**
 * Сверка речи клипа Omni с репликами сценки: проглотил ли Omni реплику или
 * переврал её. Распознаёт SpeechKit (stt.ts), сравниваются слова.
 */

/** Доля слов реплик, которая должна прозвучать. Стартовая; окончательная подбирается на ролике-образце. */
export const MATCH_THRESHOLD = 0.6;
/** Слово короче — междометие или предлог: по нему не судят, прозвучала ли реплика. */
const MIN_LINE_WORD = 3;

/**
 * Слова текста: NFC, нижний регистр, «ё» → «е», без знаков. Дефис делит слово
 * («Га-га» → «га», «га»). Порядок слов и лишние слова при сверке не важны.
 */
export function speechWords(s: string): string[] {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Сверяются только слова с кириллицей: числа SpeechKit пишет то словами, то
 * цифрами, латиницу («Linkeon») — по-своему, и пересъёмка этого не лечит.
 */
const checkable = (w: string): boolean => /\p{Script=Cyrillic}/u.test(w);

/** Слитное «гага» на месте «га-га» из реплик — повтор слога: так SpeechKit пишет междометия. */
function unglue(w: string, vocab: Set<string>): string[] {
  if (vocab.has(w)) return [w];
  for (let n = 2; n <= w.length / 2; n++) {
    const syl = w.slice(0, n);
    if (w.length % n === 0 && vocab.has(syl) && syl.repeat(w.length / n) === w) return Array<string>(w.length / n).fill(syl);
  }
  return [w];
}

export interface SpeechCheck {
  /** Клип годится: доля не ниже порога и ни одна реплика не проглочена. */
  ok: boolean;
  /** Доля сверяемых слов реплик (с повторами), найденных в распознанном. */
  share: number;
  /** Номера реплик (с 0), от которых не услышано ни одного слова от трёх букв. */
  silentLines: number[];
}

export function speechCheck(lines: string[], heard: string): SpeechCheck {
  const perLine = lines.map((l) => speechWords(l).filter(checkable));
  const vocab = new Set(perLine.flat());
  const pool = new Map<string, number>();
  for (const w of speechWords(heard).flatMap((x) => unglue(x, vocab))) pool.set(w, (pool.get(w) ?? 0) + 1);
  const heardWords = new Set(pool.keys());
  const expected = perLine.flat();
  let hit = 0;
  for (const w of expected) {
    const left = pool.get(w) ?? 0;
    if (left > 0) {
      hit++;
      pool.set(w, left - 1);
    }
  }
  const share = expected.length ? hit / expected.length : 1;
  const silentLines = perLine
    .map((words, i) => ({ i, long: words.filter((w) => w.length >= MIN_LINE_WORD) }))
    .filter(({ long }) => long.length > 0 && !long.some((w) => heardWords.has(w)))
    .map(({ i }) => i);
  return { ok: share >= MATCH_THRESHOLD && silentLines.length === 0, share, silentLines };
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/match.ts
git -C "$WT" commit -m "feat(studio): сверка речи клипа с репликами по словам

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/match.test.ts"
```

Expected: `# pass 8`, `# fail 0`.

---

### Task 7: Время реплик сценки по паузам

**Files:**
- Create: `studio/src/animate/cues.ts`
- Test: `studio/src/animate/cues.test.ts`
- Modify: `studio/src/ffprobe.ts` (`detectSilences` с порогами)
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/cues.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineCues, voicedSpans } from './cues';

test('отрезки речи — между паузами; щелчки короче 300 мс отброшены', () => {
  const silences = [
    { start: 0, end: 0.4, duration: 0.4 },
    { start: 3.0, end: 3.6, duration: 0.6 },
    { start: 3.8, end: 4.5, duration: 0.7 },
    { start: 7.2, end: 8.0, duration: 0.8 },
  ];
  assert.deepEqual(voicedSpans(silences, 8000), [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ]);
});

test('без пауз — один отрезок на весь клип', () => {
  assert.deepEqual(voicedSpans([], 8000), [{ startMs: 0, endMs: 8000 }]);
});

test('отрезков столько же, сколько реплик, — реплика на отрезок', () => {
  const spans = [
    { startMs: 400, endMs: 3000 },
    { startMs: 4500, endMs: 7200 },
  ];
  assert.deepEqual(lineCues(['Обои потёрли!', 'Спокойно.'], spans, 8000), [
    { line: 0, startMs: 400, endMs: 3000 },
    { line: 1, startMs: 4500, endMs: 7200 },
  ]);
});

test('иначе речь от первого отрезка до последнего делится пропорционально длине реплик', () => {
  assert.deepEqual(lineCues(['aaaa', 'aa'], [{ startMs: 1000, endMs: 7000 }], 8000), [
    { line: 0, startMs: 1000, endMs: 5000 },
    { line: 1, startMs: 5000, endMs: 7000 },
  ]);
});

test('отрезков нет — делится весь клип; реплик нет — субтитров нет', () => {
  assert.deepEqual(lineCues(['a', 'b'], [], 8000), [
    { line: 0, startMs: 0, endMs: 4000 },
    { line: 1, startMs: 4000, endMs: 8000 },
  ]);
  assert.deepEqual(lineCues([], [{ startMs: 0, endMs: 8000 }], 8000), []);
});

test('паузы не по порядку, перекрытые и вложенные — отрезки всё равно по порядку и без пересечений', () => {
  const silences = [
    { start: 5.0, end: 6.0, duration: 1.0 },
    { start: 1.0, end: 2.0, duration: 1.0 },
    { start: 1.5, end: 2.5, duration: 1.0 },
    { start: 5.2, end: 5.4, duration: 0.2 },
  ];
  assert.deepEqual(voicedSpans(silences, 8000), [
    { startMs: 0, endMs: 1000 },
    { startMs: 2500, endMs: 5000 },
    { startMs: 6000, endMs: 8000 },
  ]);
});

test('тишина на весь клип — отрезков нет; отрезок ровно 300 мс остаётся, 299 мс — нет; пауза за концом клипа не тянет отрезок', () => {
  assert.deepEqual(voicedSpans([{ start: 0, end: 8, duration: 8 }], 8000), []);
  assert.deepEqual(voicedSpans([{ start: 0.3, end: 8, duration: 7.7 }], 8000), [{ startMs: 0, endMs: 300 }]);
  assert.deepEqual(voicedSpans([{ start: 0.299, end: 8, duration: 7.701 }], 8000), []);
  assert.deepEqual(voicedSpans([{ start: 8.3, end: 8.6, duration: 0.3 }], 8000), [{ startMs: 0, endMs: 8000 }]);
});

test('в репликах по два предложения — граница встаёт в паузу между героями, а не посреди речи', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  const spans = [
    { startMs: 500, endMs: 1200 },
    { startMs: 1500, endMs: 4200 },
    { startMs: 4600, endMs: 5400 },
    { startMs: 5700, endMs: 6600 },
  ];
  assert.deepEqual(lineCues(lines, spans, 8000), [
    { line: 0, startMs: 500, endMs: 4200 },
    { line: 1, startMs: 4600, endMs: 6600 },
  ]);
});

test('отрезков столько же, сколько реплик, но случайно (стук и слитная речь) — делится по длине текста', () => {
  const lines = ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'];
  assert.deepEqual(lineCues(lines, [{ startMs: 300, endMs: 700 }, { startMs: 1500, endMs: 6000 }], 8000), [
    { line: 0, startMs: 300, endMs: 3036 },
    { line: 1, startMs: 3036, endMs: 6000 },
  ]);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/match.test.ts"` на `src/animate/match.test.ts src/animate/cues.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/cues.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): время реплик сценки по паузам (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/cues.test.ts"
```

Expected: FAIL — модуля `./cues` нет.

- [ ] **Step 3: Пороги поиска тишины в `detectSilences`**

В `studio/src/ffprobe.ts` заменить функцию `detectSilences` целиком:

```ts
/**
 * Тишина в файле. По умолчанию — провалы звука в готовом ролике (−45 дБ, от
 * 0,5 с); паузы между репликами сценки ищутся своими порогами (animate/cues.ts).
 * Порог — число в дБ: строку без «dB» ffmpeg не принимает, и сбой случился бы
 * уже после оплаченного клипа.
 */
export async function detectSilences(file: string, totalSec: number, o: { noiseDb?: number; minSec?: number } = {}): Promise<Silence[]> {
  // silencedetect пишет в stderr, ffmpeg при этом выходит с кодом 0.
  const { stderr } = await run(
    'ffmpeg',
    ['-hide_banner', '-nostats', '-i', file, '-af', `silencedetect=noise=${o.noiseDb ?? -45}dB:d=${o.minSec ?? 0.5}`, '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return parseSilences(stderr, totalSec);
}
```

- [ ] **Step 4: Написать модуль**

`studio/src/animate/cues.ts`:

```ts
import type { Silence } from '../ffprobe';
import type { SkitCue } from '../types';

/**
 * Паузы между репликами в клипе Omni: под репликами у Omni фон (шаги, шорох),
 * поэтому порог выше, чем у проверки провалов звука в готовом ролике.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const PAUSE_DETECT = { noiseDb: -30, minSec: 0.25 } as const;

/** Отрезок речи короче этого — щелчок или стук, а не реплика. */
const MIN_SPAN_MS = 300;
/** Во сколько раз доля отрезка в речи может отличаться от доли текста реплики, чтобы считать их парой. */
const SPAN_TEXT_RATIO = 3;

export interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Отрезки речи — промежутки между паузами, по порядку и без пересечений.
 * Паузы могут прийти не по порядку и перекрываться; всё зажимается в клип.
 */
export function voicedSpans(silences: Silence[], totalMs: number, minMs = MIN_SPAN_MS): Span[] {
  const spans: Span[] = [];
  let cursor = 0;
  for (const s of [...silences].sort((a, b) => a.start - b.start)) {
    const start = Math.min(totalMs, Math.round(s.start * 1000));
    if (start - cursor >= minMs) spans.push({ startMs: cursor, endMs: start });
    cursor = Math.max(cursor, start, Math.min(totalMs, Math.round(s.end * 1000)));
  }
  if (totalMs - cursor >= minMs) spans.push({ startMs: cursor, endMs: totalMs });
  return spans;
}

const distance = (gap: Span, t: number): number => (t < gap.startMs ? gap.startMs - t : t > gap.endMs ? t - gap.endMs : 0);

/**
 * Время субтитров реплик сценки по отрезкам речи из voicedSpans.
 * - Отрезков столько же, сколько реплик, и доля каждого в речи похожа на долю
 *   текста его реплики (не дальше чем в SPAN_TEXT_RATIO раз), — реплика на отрезок.
 * - Отрезков больше (в реплике два предложения — пауза и внутри) — граница
 *   каждой реплики встаёт в паузу, ближайшую к оценке по длине текста.
 * - Иначе речь от начала первого отрезка до конца последнего (без отрезков —
 *   весь клип) делится по длине текста.
 */
export function lineCues(lines: string[], spans: Span[], totalMs: number): SkitCue[] {
  if (!lines.length) return [];
  const weights = lines.map((l) => Math.max(1, l.length));
  const total = weights.reduce((n, w) => n + w, 0);
  const voiced = spans.reduce((n, s) => n + s.endMs - s.startMs, 0);
  const plausible = spans.every((s, i) => {
    const r = (s.endMs - s.startMs) / voiced / (weights[i] / total);
    return r >= 1 / SPAN_TEXT_RATIO && r <= SPAN_TEXT_RATIO;
  });
  if (spans.length === lines.length && plausible) return spans.map((s, i) => ({ line: i, startMs: s.startMs, endMs: s.endMs }));

  const from = spans.length ? spans[0].startMs : 0;
  const to = spans.length ? spans[spans.length - 1].endMs : totalMs;
  const gaps = spans.slice(1).map((s, i) => ({ startMs: spans[i].endMs, endMs: s.startMs }));
  const snap = spans.length > lines.length;
  const cues: SkitCue[] = [];
  let at = from;
  let acc = 0;
  let next = 0;
  lines.forEach((_, i) => {
    acc += weights[i];
    if (i === lines.length - 1) {
      cues.push({ line: i, startMs: at, endMs: to });
      return;
    }
    const est = from + Math.round(((to - from) * acc) / total);
    if (!snap) {
      cues.push({ line: i, startMs: at, endMs: est });
      at = est;
      return;
    }
    // Каждой следующей границе нужна своя пауза — их и оставляем в запасе.
    const left = lines.length - 2 - i;
    let best = next;
    for (let j = next; j < gaps.length - left; j++) if (distance(gaps[j], est) < distance(gaps[best], est)) best = j;
    cues.push({ line: i, startMs: at, endMs: gaps[best].startMs });
    at = gaps[best].endMs;
    next = best + 1;
  });
  return cues;
}
```

- [ ] **Step 5: Прогнать тесты**

```bash
git -C "$WT" add studio/src/animate/cues.ts studio/src/ffprobe.ts
git -C "$WT" commit -m "feat(studio): время реплик сценки по паузам в звуке клипа, пороги поиска тишины

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/cues.test.ts src/ffprobe.test.ts"
```

Expected: все `pass`, `# fail 0`.

---

### Task 8: Клиент Google — кадр Nano Banana Pro и клип Omni

Формы запросов и ответов сняты живыми вызовами 24–26.10.2026 (`src/misc/veo.service.ts` в `origin/main`, прототипы `~/shorts-style/keys.py` и `omni.py` на ноде). Генерация Omni оплачивается с запуска, поэтому клиент держится за неё: сбой опроса (сеть, таймаут, обрыв тела, не-JSON, 5xx, 408, 429, незнакомый статус) — повод опросить ещё раз, а не бросить клип. У каждого запроса таймаут, срок опроса — по часам. Поминутный лимит пережидается на месте. Кадр возвращается со своим типом: Nano Banana Pro отдаёт JPEG. Ключ в сообщения не попадает, даже если Google повторил его в ответе.

**Files:**
- Create: `studio/src/animate/google.ts`
- Test: `studio/src/animate/google.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/google.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StudioError } from '../errors';
import {
  CLEAR_REFUSALS,
  CLIP_SEC,
  generateKeyframe,
  googleHttpError,
  imageMime,
  KEYFRAME_MODEL,
  OMNI_MODEL,
  rateLimitDelayMs,
  startClip,
  waitClip,
  type GoogleDeps,
} from './google';

type Reply = { status?: number; body: unknown } | Error | (() => Response);

/** Подделка fetch с виртуальными часами: пауза двигает время, каждый запрос — на costMs. */
function fake(replies: Reply[], costMs = 0) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let t = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    t += costMs;
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const deps: GoogleDeps = {
    apiKey: 'AIzaSyTESTKEY0123456789abcdefghij',
    fetch: f,
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    pollEveryMs: 1,
    pollTimeoutMs: 3,
  };
  return { deps, calls };
}

const isErr = (code: string, retryable: boolean) => (e: unknown) =>
  e instanceof StudioError && e.code === code && e.retryable === retryable;

const done = (data: Buffer) => ({
  body: { status: 'completed', steps: [{ type: 'thought' }, { type: 'model_output', content: [{ type: 'text', text: 'вот' }, { type: 'video', data: data.toString('base64') }] }] },
});
const inProgress = { body: { status: 'in_progress' } };
const torn = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"status":"completed","steps":[{"type":"model_output","content":[{"type":"video","data":"AAAA'));
        c.error(new TypeError('terminated'));
      },
    }),
    { status: 200 },
  );
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

test('кадр: портреты инлайном перед текстом, 9:16, ключ в заголовке, картинка с её типом', async () => {
  const { deps, calls } = fake([
    { body: { candidates: [{ content: { parts: [{ text: 'ok' }, { inlineData: { mimeType: 'image/jpeg', data: JPEG.toString('base64') } }] } }] } },
  ]);
  const refs = [{ data: Buffer.from('a'), mime: 'image/png' }, { data: Buffer.from('b'), mime: 'image/png' }];
  assert.deepEqual(await generateKeyframe(deps, 'промпт', refs), { data: JPEG, mime: 'image/jpeg' });
  assert.match(calls[0].url, new RegExp(`models/${KEYFRAME_MODEL}:generateContent$`));
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
  assert.ok(calls[0].init?.signal, 'у запроса нет таймаута');
  const body = JSON.parse(String(calls[0].init?.body));
  const parts = body.contents[0].parts;
  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0], { inlineData: { mimeType: 'image/png', data: Buffer.from('a').toString('base64') } });
  assert.equal(parts[2].text, 'промпт');
  assert.deepEqual(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } });
});

test('тип картинки без mimeType — по сигнатуре', async () => {
  assert.equal(imageMime(JPEG), 'image/jpeg');
  assert.equal(imageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), 'image/png');
  const { deps } = fake([{ body: { candidates: [{ content: { parts: [{ inlineData: { data: JPEG.toString('base64') } }] } }] } }]);
  assert.equal((await generateKeyframe(deps, 'p', [])).mime, 'image/jpeg');
});

test('кадр без картинки: RECITATION — повторяемая ошибка, заблокированный промпт — без повтора', async () => {
  const a = fake([{ body: { candidates: [{ finishReason: 'RECITATION', content: { parts: [] } }] } }]);
  await assert.rejects(generateKeyframe(a.deps, 'p', []), (e: unknown) => isErr('keyframe', true)(e) && /RECITATION/.test((e as Error).message));
  const b = fake([{ body: { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } } }]);
  await assert.rejects(generateKeyframe(b.deps, 'p', []), (e: unknown) => isErr('keyframe', false)(e) && /PROHIBITED_CONTENT/.test((e as Error).message));
});

test('HTTP-ошибки Google: квота, ключ и снятая модель не повторяются', () => {
  assert.ok(isErr('google_quota', false)(googleHttpError('omni', 429, '{}')));
  assert.ok(isErr('google_quota', false)(googleHttpError('keyframe', 400, 'RESOURCE_EXHAUSTED')));
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 403, 'denied')));
  const badKey = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } });
  assert.ok(isErr('google_auth', false)(googleHttpError('omni', 400, badKey)));
  assert.ok(isErr('model_gone', false)(googleHttpError('omni', 404, 'not found')));
  assert.ok(isErr('omni_rejected', true)(googleHttpError('omni', 400, '{"error":{"status":"INVALID_ARGUMENT"}}')));
  assert.ok(isErr('omni_failed', true)(googleHttpError('omni', 503, 'unavailable')));
  assert.ok(isErr('keyframe', true)(googleHttpError('keyframe', 500, 'oops')));
});

test('ключ из ответа Google в сообщение не попадает', () => {
  const body = JSON.stringify({ error: { code: 403, message: "Consumer 'api_key:AIzaSyTESTKEY0123456789abcdefghij' has been suspended." } });
  assert.doesNotMatch(googleHttpError('omni', 403, body).message, /AIzaSyTESTKEY/);
});

test('поминутный лимит пережидается на месте и не сжигает попытку; суточный — нет', async () => {
  const perMinute = { status: 429, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded', details: [{ retryDelay: '7s' }] } } };
  assert.equal(rateLimitDelayMs(JSON.stringify(perMinute.body)), 7000);
  const daily = JSON.stringify({ error: { code: 429, message: 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0' } });
  assert.equal(rateLimitDelayMs(daily), null);
  const { deps, calls } = fake([perMinute, { body: { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] } }] } }]);
  assert.equal((await generateKeyframe(deps, 'p', [])).mime, 'image/png');
  assert.equal(calls.length, 2);
});

test('запуск клипа: Omni, фоновый, кадр с его типом и текст, 9:16 720p 8 с', async () => {
  const { deps, calls } = fake([{ body: { id: 'int-1', status: 'in_progress' } }]);
  assert.equal(await startClip(deps, 'сценка', { data: JPEG, mime: 'image/jpeg' }), 'int-1');
  assert.match(calls[0].url, /\/v1beta\/interactions$/);
  assert.equal((calls[0].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(body.model, OMNI_MODEL);
  assert.equal(body.background, true);
  assert.deepEqual(body.input, [
    { type: 'image', data: JPEG.toString('base64'), mime_type: 'image/jpeg' },
    { type: 'text', text: 'сценка' },
  ]);
  assert.deepEqual(body.response_format, { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` });
});

test('запуск: ответ потерян или без id — повторяемая ошибка «могла начаться», секунды не возвращаются', async () => {
  const a = fake([new TypeError('fetch failed')]);
  await assert.rejects(startClip(a.deps, 'p', { data: JPEG, mime: 'image/jpeg' }), (e: unknown) => isErr('omni_failed', true)(e) && /могла начаться/.test((e as Error).message));
  const b = fake([{ body: '<html>' }]);
  await assert.rejects(startClip(b.deps, 'p', { data: JPEG, mime: 'image/jpeg' }), isErr('omni_failed', true));
  assert.equal(CLEAR_REFUSALS.has('omni_failed'), false);
  assert.equal(CLEAR_REFUSALS.has('omni_rejected'), true);
  assert.equal(CLEAR_REFUSALS.has('google_quota'), true);
});

test('ожидание: в работе → готово, видео из шага model_output', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps, calls } = fake([inProgress, done(mp4)]);
  assert.deepEqual(await waitClip(deps, 'int-1'), mp4);
  assert.match(calls[0].url, /\/interactions\/int-1$/);
});

test('ожидание: сбой сети, обрыв тела, не-JSON, 5xx, 408, 429 и незнакомый статус не бросают оплаченную генерацию', async () => {
  const mp4 = Buffer.from('MP4');
  const { deps } = fake([new Error('ECONNRESET'), torn, { body: '<html>' }, { status: 503, body: 'x' }, { status: 408, body: '{}' }, { status: 429, body: '{}' }, { body: { status: 'queued' } }, { body: {} }, done(mp4)]);
  deps.pollTimeoutMs = 100;
  assert.deepEqual(await waitClip(deps, 'i'), mp4);
});

test('ожидание: готовый клип ссылкой скачивается с ключом в заголовке', async () => {
  const { deps, calls } = fake([
    { body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'video', uri: 'https://files.example/abc' }] }] } },
    () => new Response(new Uint8Array(Buffer.from('MP4')), { status: 200 }),
  ]);
  assert.deepEqual(await waitClip(deps, 'i'), Buffer.from('MP4'));
  assert.equal(calls[1].url, 'https://files.example/abc');
  assert.equal((calls[1].init?.headers as Record<string, string>)['x-goog-api-key'], deps.apiKey);
});

test('отказ фильтра приходит массивом errors — повторяемый omni_rejected, и с числовым кодом 3', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INVALID_ARGUMENT', message: 'There was a problem processing your request' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_rejected', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 3, status: 'INVALID_ARGUMENT', message: 'problem' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('omni_rejected', true));
});

test('прочий провал и нехватка мощностей после приёма — omni_failed с повтором; 404 опроса — не «модель снята»', async () => {
  const a = fake([{ body: { status: 'failed', errors: [{ code: 'INTERNAL', message: 'boom' }] } }]);
  await assert.rejects(waitClip(a.deps, 'i'), isErr('omni_failed', true));
  const b = fake([{ body: { status: 'failed', errors: [{ code: 'RESOURCE_EXHAUSTED', message: 'quota exceeded' }] } }]);
  await assert.rejects(waitClip(b.deps, 'i'), isErr('omni_failed', true));
  const c = fake([{ status: 404, body: '{"error":{"message":"Interaction not found"}}' }]);
  await assert.rejects(waitClip(c.deps, 'i'), isErr('omni_failed', true));
});

test('готово, но без видео — omni_rejected с текстом модели', async () => {
  const { deps } = fake([{ body: { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Не могу' }] }] } }]);
  await assert.rejects(waitClip(deps, 'i'), (e: unknown) => isErr('omni_rejected', true)(e) && /Не могу/.test((e as Error).message));
});

test('не дождались — omni_failed; срок считается по часам, а не по числу опросов', async () => {
  const a = fake([inProgress, inProgress, inProgress]);
  await assert.rejects(waitClip(a.deps, 'i'), (e: unknown) => isErr('omni_failed', true)(e) && /не дождались/.test((e as Error).message));
  const slow = fake(Array.from({ length: 10 }, () => inProgress), 40);
  slow.deps.pollTimeoutMs = 100;
  await assert.rejects(waitClip(slow.deps, 'i'), isErr('omni_failed', true));
  assert.ok(slow.calls.length <= 3, `опросов ${slow.calls.length} — срок не считает время запросов`);
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/cues.test.ts"` на `src/animate/cues.test.ts src/animate/google.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/google.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): клиент Google — кадр Nano Banana Pro и клип Omni (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts"
```

Expected: FAIL — модуля `./google` нет.

- [ ] **Step 3: Написать клиент**

`studio/src/animate/google.ts`:

```ts
import { StudioError, type StudioErrorCode } from '../errors';

/**
 * Google Generative Language API: кадр-эталон (Nano Banana Pro) и клип сценки
 * (Gemini Omni Flash, Interactions API). Формы запросов сняты живыми вызовами
 * 24–26.10.2026 — см. src/misc/veo.service.ts бэкенда. Ключ — только в
 * заголовке; в сообщения ошибок он не попадает, даже если Google повторил его
 * в ответе.
 */
const API = 'https://generativelanguage.googleapis.com/v1beta';
export const KEYFRAME_MODEL = 'gemini-3-pro-image-preview';
export const OMNI_MODEL = 'gemini-omni-1.1-flash';
/** Длина клипа сценки, секунды: сценки по 8 с, без продления (спека). */
export const CLIP_SEC = 8;

/** Таймаут одного запроса: кадр рисуется до пары минут, запуск и опрос — быстрые. */
const KEYFRAME_TIMEOUT_MS = 180_000;
const START_TIMEOUT_MS = 120_000;
const POLL_TIMEOUT_MS = 120_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Поминутный лимит пережидается на месте, не сжигая попытку: до двух раз, не дольше полутора минут. */
const RATE_RETRIES = 2;
const MAX_RATE_WAIT_MS = 90_000;
const DOWNLOAD_ATTEMPTS = 3;
const MAX_VIDEO_BYTES = 200 * 1024 * 1024;

export interface GoogleDeps {
  apiKey: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Опрос Omni: шаг и срок на одну генерацию — по часам, а не по числу опросов. */
  pollEveryMs?: number;
  pollTimeoutMs?: number;
}

export interface ImageInput {
  data: Buffer;
  mime: string;
}

/**
 * Отказы Google, после которых клип точно не запущен — секунды Omni можно
 * вернуть. После прочих сбоев запуска (5xx, потерянный ответ) генерация могла
 * начаться и будет оплачена.
 */
export const CLEAR_REFUSALS: ReadonlySet<StudioErrorCode> = new Set<StudioErrorCode>(['google_quota', 'google_auth', 'model_gone', 'omni_rejected']);

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const headers = (d: GoogleDeps) => ({ 'x-goog-api-key': d.apiKey, 'Content-Type': 'application/json' });
/** Ключи Google начинаются с «AIza»; Google повторяет ключ, например, в 403 «Consumer … suspended». */
const redact = (s: string): string => s.replace(/AIza[0-9A-Za-z_-]{20,}/g, '<ключ>');
const errText = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));

/** Тип картинки по сигнатуре: Nano Banana Pro отдаёт JPEG, хотя кадры принято звать .png. */
export function imageMime(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return 'image/png';
}

interface GoogleError {
  code?: number;
  status?: string;
  message?: string;
  details?: Array<{ reason?: string; retryDelay?: string; violations?: Array<{ quotaId?: string }> }>;
}

function parseError(body: string): GoogleError | undefined {
  try {
    return (JSON.parse(body) as { error?: GoogleError } | null)?.error ?? undefined;
  } catch {
    return undefined;
  }
}

/** Пауза, которую стоит выждать при поминутном лимите; null — лимит не поминутный (суточный, биллинг). */
export function rateLimitDelayMs(body: string): number | null {
  const err = parseError(body);
  const details = err?.details ?? [];
  const sec = parseFloat(details.find((x) => x.retryDelay)?.retryDelay ?? '');
  if (Number.isFinite(sec) && sec > 0) return sec * 1000 <= MAX_RATE_WAIT_MS ? Math.ceil(sec * 1000) : null;
  const perMinute = details.some((x) => x.violations?.some((v) => /PerMinute/i.test(v.quotaId ?? ''))) || /per ?minute/i.test(err?.message ?? '');
  return perMinute ? 60_000 : null;
}

/**
 * HTTP-ошибка Google → StudioError. Квота, ключ и снятая модель повтором не
 * лечатся: каждая лишняя попытка Omni стоит денег.
 */
export function googleHttpError(what: 'keyframe' | 'omni', status: number, body: string): StudioError {
  const err = parseError(body);
  const said = redact((err?.message ?? body).slice(0, 300));
  const reasons = (err?.details ?? []).map((x) => x.reason).filter(Boolean).join(', ');
  if (status === 429 || err?.status === 'RESOURCE_EXHAUSTED' || /RESOURCE_EXHAUSTED|exceeded your current quota/i.test(body)) {
    return new StudioError('google_quota', `${what}: лимит Google исчерпан (HTTP ${status}) — суточная квота обновляется ≈ в 11:00 МСК: ${said}`, false);
  }
  if (status === 401 || status === 403 || reasons.includes('API_KEY_INVALID') || /API key not valid/i.test(body)) {
    return new StudioError('google_auth', `${what}: Google отклонил ключ GOOGLE_AI_API_KEY (HTTP ${status}${reasons ? `, ${reasons}` : ''}): ${said}`, false);
  }
  if (status === 404) {
    return new StudioError('model_gone', `${what}: модель недоступна (HTTP 404) — Google её снял; переключите формат на «Только чат». ${said}`, false);
  }
  if (what === 'omni' && status === 400 && (err?.status === 'INVALID_ARGUMENT' || /INVALID_ARGUMENT/.test(body))) {
    return new StudioError('omni_rejected', `omni: Google отклонил запрос (фильтр контента или промпт): ${said}`, true);
  }
  return new StudioError(what === 'omni' ? 'omni_failed' : 'keyframe', `${what}: Google ответил HTTP ${status}: ${said}`, true);
}

/** Запрос с таймаутом; поминутный 429 пережидается здесь же. Сбой сети выходит наружу как есть. */
async function request(d: GoogleDeps, url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; ok: boolean; raw: string }> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? realSleep;
  for (let i = 0; ; i++) {
    const resp = await f(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const raw = await resp.text();
    if (resp.status === 429 && i < RATE_RETRIES) {
      const wait = rateLimitDelayMs(raw);
      if (wait != null) {
        await sleep(wait);
        continue;
      }
    }
    return { status: resp.status, ok: resp.ok, raw };
  }
}

interface KeyframeReply {
  promptFeedback?: { blockReason?: string };
  candidates?: Array<{ finishReason?: string; content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }>;
}

export async function generateKeyframe(d: GoogleDeps, prompt: string, refs: ImageInput[]): Promise<ImageInput> {
  const body = {
    contents: [{ parts: [...refs.map((r) => ({ inlineData: { mimeType: r.mime, data: r.data.toString('base64') } })), { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16' } },
  };
  let r: { status: number; ok: boolean; raw: string };
  try {
    r = await request(d, `${API}/models/${KEYFRAME_MODEL}:generateContent`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) }, KEYFRAME_TIMEOUT_MS);
  } catch (e) {
    throw new StudioError('keyframe', `keyframe: запрос не прошёл — ${errText(e)}`, true);
  }
  if (!r.ok) throw googleHttpError('keyframe', r.status, r.raw);
  let reply: KeyframeReply;
  try {
    reply = (JSON.parse(r.raw) ?? {}) as KeyframeReply;
  } catch {
    throw new StudioError('keyframe', `keyframe: ответ не JSON: ${redact(r.raw.slice(0, 200))}`, true);
  }
  // Заблокированный промпт не пройдёт и со второго раза — не тратим попытки.
  const blocked = reply.promptFeedback?.blockReason;
  if (blocked) throw new StudioError('keyframe', `keyframe: Nano Banana заблокировал промпт (${blocked})`, false);
  const cand = reply.candidates?.[0];
  const part = (cand?.content?.parts ?? []).find((p) => p?.inlineData?.data);
  // RECITATION и прочие отказы приходят без ошибки HTTP — просто без картинки.
  if (!part?.inlineData?.data) throw new StudioError('keyframe', `keyframe: Nano Banana не вернул картинку (${cand?.finishReason ?? 'без причины'})`, true);
  const data = Buffer.from(part.inlineData.data, 'base64');
  return { data, mime: part.inlineData.mimeType || imageMime(data) };
}

export async function startClip(d: GoogleDeps, prompt: string, image: ImageInput): Promise<string> {
  const body = {
    model: OMNI_MODEL,
    background: true,
    input: [
      { type: 'image', data: image.data.toString('base64'), mime_type: image.mime },
      { type: 'text', text: prompt },
    ],
    response_format: { type: 'video', aspect_ratio: '9:16', resolution: '720p', duration: `${CLIP_SEC}s` },
  };
  let r: { status: number; ok: boolean; raw: string };
  try {
    r = await request(d, `${API}/interactions`, { method: 'POST', headers: headers(d), body: JSON.stringify(body) }, START_TIMEOUT_MS);
  } catch (e) {
    throw new StudioError('omni_failed', `omni: запуск — ответ потерян, генерация могла начаться: ${errText(e)}`, true);
  }
  if (!r.ok) throw googleHttpError('omni', r.status, r.raw);
  let id: string | undefined;
  try {
    id = (JSON.parse(r.raw) as { id?: string } | null)?.id;
  } catch {
    id = undefined;
  }
  if (!id) throw new StudioError('omni_failed', `omni: запуск — в ответе нет id, генерация могла начаться: ${redact(r.raw.slice(0, 200))}`, true);
  return id;
}

interface Interaction {
  status?: string;
  errors?: Array<{ code?: string | number; status?: string; message?: string }>;
  error?: { code?: string | number; status?: string; message?: string };
  steps?: Array<{ type?: string; content?: Array<{ type?: string; data?: string; uri?: string; text?: string }> }>;
}

function interactionFailure(st: Interaction): StudioError {
  // Провал приходит массивом errors: [{ code, message }] (живой ответ 24.10.2026).
  const errs = Array.isArray(st.errors) ? st.errors : st.error ? [st.error] : [];
  const first = errs.find((e) => e?.message) ?? errs[0];
  const msg = redact(String(first?.message ?? `взаимодействие ${st.status}`).slice(0, 300));
  const code = String(first?.code ?? '');
  if (code === 'INVALID_ARGUMENT' || code === '3' || first?.status === 'INVALID_ARGUMENT') {
    return new StudioError('omni_rejected', `omni: отказ фильтра — ${msg}`, true);
  }
  return new StudioError('omni_failed', `omni: ${msg}`, true);
}

/** Готовый клип ссылкой (Files API): ключ — в заголовке, размер — с потолком, повтор — здесь же. */
async function download(d: GoogleDeps, uri: string): Promise<Buffer> {
  const f = d.fetch ?? fetch;
  let last = '';
  for (let i = 1; i <= DOWNLOAD_ATTEMPTS; i++) {
    try {
      const resp = await f(uri, { headers: { 'x-goog-api-key': d.apiKey }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_VIDEO_BYTES) throw new StudioError('omni_failed', `omni: клип ссылкой больше ${MAX_VIDEO_BYTES >> 20} МБ`, false);
      return buf;
    } catch (e) {
      if (e instanceof StudioError) throw e;
      last = errText(e);
    }
  }
  throw new StudioError('omni_failed', `omni: клип ссылкой не скачался за ${DOWNLOAD_ATTEMPTS} попытки — ${last}`, true);
}

/**
 * Ждёт клип. Генерация уже оплачена, поэтому сбой опроса (сеть, таймаут,
 * обрыв тела, не-JSON, 5xx, 408, 429) — не повод её бросать: опрос
 * продолжается. Ошибка — только явный провал взаимодействия или срок.
 */
export async function waitClip(d: GoogleDeps, id: string): Promise<Buffer> {
  const sleep = d.sleep ?? realSleep;
  const now = d.now ?? Date.now;
  const every = d.pollEveryMs ?? 10_000;
  const limit = d.pollTimeoutMs ?? 6 * 60_000;
  const deadline = now() + limit;
  while (now() < deadline) {
    await sleep(every);
    let st: Interaction;
    try {
      const r = await request(d, `${API}/interactions/${id}`, { headers: { 'x-goog-api-key': d.apiKey } }, POLL_TIMEOUT_MS);
      if (!r.ok) {
        if (r.status >= 500 || r.status === 408 || r.status === 429) continue;
        if (r.status === 404) throw new StudioError('omni_failed', `omni: взаимодействие ${id} не найдено (HTTP 404)`, true);
        throw googleHttpError('omni', r.status, r.raw);
      }
      st = (JSON.parse(r.raw) ?? {}) as Interaction;
    } catch (e) {
      if (e instanceof StudioError) throw e;
      continue;
    }
    if (st.status === 'completed') {
      const parts = (st.steps ?? []).filter((s) => s?.type === 'model_output').flatMap((s) => s.content ?? []);
      const video = parts.filter((c) => c?.type === 'video').pop();
      if (video?.data) return Buffer.from(video.data, 'base64');
      if (video?.uri) return download(d, video.uri);
      const said = parts
        .filter((c) => c?.type === 'text' && c.text)
        .map((c) => c.text)
        .join(' ')
        .trim();
      throw new StudioError('omni_rejected', `omni: видео нет${said ? ` — модель ответила: ${redact(said.slice(0, 300))}` : ''}`, true);
    }
    if (st.status === 'failed' || st.status === 'cancelled') throw interactionFailure(st);
    // in_progress, queued, пустой или незнакомый статус — ждём дальше.
  }
  throw new StudioError('omni_failed', `omni: не дождались клипа за ${Math.round(limit / 60_000)} мин`, true);
}
```

- [ ] **Step 4: Прогнать тест и типы**

```bash
git -C "$WT" add studio/src/animate/google.ts
git -C "$WT" commit -m "feat(studio): клиент Google — кадр Nano Banana Pro, запуск и ожидание клипа Omni, разбор отказов

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/google.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: `# pass 15`, `# fail 0`, затем `TSC_OK`.

---

### Task 9: Распознавание речи клипа

**Files:**
- Create: `studio/src/animate/stt.ts`
- Test: `studio/src/animate/stt.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/stt.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import { recognize, speechAudio } from './stt';

type Reply = { status?: number; body: unknown } | Error | (() => Response);

function fake(replies: Reply[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const pauses: number[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const r = replies.shift();
    if (!r) throw new Error('fake: ответов больше нет');
    if (r instanceof Error) throw r;
    if (typeof r === 'function') return r();
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  const sleep = async (ms: number) => {
    pauses.push(ms);
  };
  return { f, calls, pauses, sleep };
}

const creds = { apiKey: 'SECRET-SPEECH-KEY', folderId: 'F' };
const sttFailed = (e: unknown) => e instanceof StudioError && e.code === 'stt' && !e.retryable;

/** Тело обрывается посреди чтения — так рвётся соединение. */
const torn = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"result":"обои'));
        c.error(new TypeError('terminated'));
      },
    }),
    { status: 200 },
  );

test('распознавание: ru-RU, oggopus, числа словами, каталог в адресе, ключ в заголовке, тело — звук', async () => {
  const { f, calls, sleep } = fake([{ body: { result: 'обои потерли' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), 'обои потерли');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize');
  assert.equal(url.searchParams.get('lang'), 'ru-RU');
  assert.equal(url.searchParams.get('format'), 'oggopus');
  assert.equal(url.searchParams.get('rawResults'), 'true');
  assert.equal(url.searchParams.get('folderId'), 'F');
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, 'Api-Key SECRET-SPEECH-KEY');
  assert.deepEqual(Buffer.from(calls[0].init?.body as Uint8Array), Buffer.from('OGG'));
  assert.ok(calls[0].init?.signal, 'у запроса нет таймаута');
});

test('пустой результат — пустая строка', async () => {
  const { f, sleep } = fake([{ body: {} }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), '');
});

test('сбой сети, обрыв тела, не-JSON, 5xx и 429 повторяются здесь же, с нарастающими паузами', async () => {
  const { f, calls, pauses, sleep } = fake([new Error('ECONNRESET'), torn, { body: '<html>' }, { status: 429, body: 'quota' }, { body: { result: 'да' } }]);
  await assert.rejects(recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), sttFailed);
  assert.equal(calls.length, 4);
  assert.deepEqual(pauses, [2000, 10000, 30000]);
  const second = fake([{ status: 503, body: 'busy' }, { body: { result: 'да' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: second.f, sleep: second.sleep }), 'да');
});

test('все попытки неудачны — ошибка stt без повтора: клип уже оплачен, пересъёмка не поможет', async () => {
  const { f, calls, sleep } = fake([{ status: 503, body: 'a' }, { status: 503, body: 'b' }, { status: 503, body: 'c' }, { status: 503, body: 'd' }]);
  await assert.rejects(recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), sttFailed);
  assert.equal(calls.length, 4);
});

test('4xx (ключ, права) — сразу ошибка без повтора, ключ из текста ответа вырезан', async () => {
  const { f, calls, sleep } = fake([{ status: 401, body: 'unauthorized: SECRET-SPEECH-KEY' }]);
  await assert.rejects(
    recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }),
    (e: unknown) => sttFailed(e) && /401/.test((e as Error).message) && !(e as Error).message.includes('SECRET-SPEECH-KEY'),
  );
  assert.equal(calls.length, 1);
});

test('ответ 200 с ошибкой вместо текста — повтор, а не пустая строка', async () => {
  const { f, sleep } = fake([{ body: { error_code: 'BAD_REQUEST', error_message: 'x' } }, { body: { result: 'ладно' } }]);
  assert.equal(await recognize(Buffer.from('OGG'), creds, { fetch: f, sleep }), 'ладно');
});

test('звук клипа — ogg/opus, один канал, 48 кГц', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-stt-'));
  const clip = path.join(dir, 'clip.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '2', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip]);
  return speechAudio(clip, path.join(dir, 'speech.webm')).then((out) => {
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', out]).toString());
    assert.equal(probe.format.format_name, 'ogg');
    assert.equal(probe.streams[0].codec_name, 'opus');
    assert.equal(probe.streams[0].channels, 1);
    assert.equal(probe.streams[0].sample_rate, '48000');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/google.test.ts"` на `src/animate/google.test.ts src/animate/stt.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/stt.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): распознавание речи клипа в SpeechKit (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/stt.test.ts"
```

Expected: FAIL — модуля `./stt` нет.

- [ ] **Step 3: Написать модуль**

`studio/src/animate/stt.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { StudioError } from '../errors';

const run = promisify(execFile);
const STT_URL = 'https://stt.api.cloud.yandex.net/speech/v1/stt:recognize';
/** Паузы перед повторами: сбой SpeechKit на десятки секунд пережидается здесь, а не пересъёмкой. */
const STT_PAUSES_MS = [2_000, 10_000, 30_000];
/** Распознавание 10 секунд звука занимает секунды; без таймаута fetch ждёт до 5 минут. */
const STT_TIMEOUT_MS = 30_000;
/** Предел SpeechKit v1 — 30 с звука. */
const MAX_SPEECH_SEC = 29;

export interface SttCreds {
  apiKey: string;
  folderId: string;
}

export interface SttOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Звук клипа → ogg/opus, моно 48 кГц, не длиннее 29 с: так его принимает
 * SpeechKit v1 (до 30 с и 1 МБ). Минус 6 дБ — запас: сведение стерео в моно
 * поднимает громкий звук выше 0 dBFS.
 */
export async function speechAudio(clip: string, out: string): Promise<string> {
  try {
    await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', clip,
      '-vn', '-t', String(MAX_SPEECH_SEC), '-ac', '1', '-af', 'volume=-6dB', '-ar', '48000', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg',
      out,
    ]);
  } catch (e) {
    const stderr = String((e as { stderr?: string }).stderr ?? '').trim().split('\n').pop();
    throw new Error(`ffmpeg: звук клипа не извлёкся — ${stderr || (e instanceof Error ? e.message.split('\n')[0] : String(e))}`);
  }
  return out;
}

/** Текст сетевой ошибки с причиной: у fetch она лежит в cause.code (ECONNREFUSED и т. п.). */
function netError(e: unknown): string {
  const cause = (e as { cause?: { code?: string } })?.cause?.code;
  return `${e instanceof Error ? e.message : String(e)}${cause ? ` (${cause})` : ''}`;
}

/**
 * Распознавание SpeechKit v1 (те же ключи, что у синтеза). Числа — словами
 * (`rawResults=true`): реплики сценок пишутся словами. Сбой сети, таймаут,
 * обрыв или не-JSON тела, 5xx и 429 повторяются здесь же: клип Omni уже
 * оплачен, и пересъёмка из-за моргнувшего SpeechKit стоила бы денег. Поэтому
 * наружу ошибка выходит только `stt` и без повтора. Ключ из текста ответа
 * вырезается.
 */
export async function recognize(ogg: Buffer, creds: SttCreds, o: SttOptions = {}): Promise<string> {
  const f = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const url = `${STT_URL}?${new URLSearchParams({ lang: 'ru-RU', format: 'oggopus', rawResults: 'true', folderId: creds.folderId })}`;
  const hide = (s: string): string => (creds.apiKey ? s.split(creds.apiKey).join('***') : s);
  let last = '';
  for (let attempt = 0; attempt <= STT_PAUSES_MS.length; attempt++) {
    if (attempt > 0) await sleep(STT_PAUSES_MS[attempt - 1]);
    let status = 0;
    let raw = '';
    try {
      const resp = await f(url, {
        method: 'POST',
        headers: { Authorization: `Api-Key ${creds.apiKey}` },
        body: new Uint8Array(ogg),
        signal: AbortSignal.timeout(STT_TIMEOUT_MS),
      });
      status = resp.status;
      raw = await resp.text();
    } catch (e) {
      last = netError(e);
      continue;
    }
    if (status >= 200 && status < 300) {
      let reply: { result?: unknown; error_code?: unknown } | null = null;
      try {
        reply = JSON.parse(raw) as { result?: unknown; error_code?: unknown } | null;
      } catch {
        reply = null;
      }
      if (reply && typeof reply.result === 'string') return reply.result;
      if (reply && reply.result === undefined && reply.error_code === undefined) return '';
      last = `SpeechKit ${status}: в ответе нет распознанного текста — ${hide(raw.slice(0, 200))}`;
      continue;
    }
    last = `SpeechKit ${status} ${hide(raw.slice(0, 200))}`;
    if (status < 500 && status !== 429) break;
  }
  throw new StudioError('stt', `stt: распознать речь не удалось — ${last}`, false);
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/stt.ts
git -C "$WT" commit -m "feat(studio): распознавание речи клипа в SpeechKit — повторы внутри, наружу без пересъёмки

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/stt.test.ts"
```

Expected: `# pass 7`, `# fail 0`.

---

### Task 10: Проверка клипа и выравнивание громкости

**Files:**
- Create: `studio/src/animate/clip-check.ts`
- Test: `studio/src/animate/clip-check.test.ts`
- Modify: `studio/package.json` (`scripts.test`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/clip-check.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectSilences, probeFile } from '../ffprobe';
import { CLIP_LIMITS, CLIP_LUFS, checkClip, normalizeLoudness } from './clip-check';

const probe = { durationSec: 8, width: 720, height: 1280, hasAudio: true };

test('нормальный клип Omni проходит', () => {
  assert.deepEqual(checkClip(probe, [{ start: 3, end: 3.8, duration: 0.8 }]), []);
});

test('длина вне 6,5–9,5 с; границы включительно; NaN — «не определена»', () => {
  assert.deepEqual(checkClip({ ...probe, durationSec: 4 }, []), ['длина 4.0 с вне 6.5–9.5 с']);
  assert.deepEqual(checkClip({ ...probe, durationSec: 12 }, []), ['длина 12.0 с вне 6.5–9.5 с']);
  assert.deepEqual(checkClip({ ...probe, durationSec: 6.5 }, []), []);
  assert.deepEqual(checkClip({ ...probe, durationSec: 9.5 }, []), []);
  assert.deepEqual(checkClip({ ...probe, durationSec: Number.NaN }, []), ['длина не определена — ffprobe не вернул длительность']);
});

test('нет видео — ровно одна причина; квадрат и горизонталь — не вертикальный; нет звука', () => {
  assert.deepEqual(checkClip({ ...probe, width: 0, height: 0 }, []), ['нет видеодорожки']);
  assert.deepEqual(checkClip({ ...probe, width: 720, height: 0 }, []), ['нет видеодорожки']);
  assert.deepEqual(checkClip({ ...probe, width: 720, height: 720 }, []), ['кадр 720×720 не вертикальный']);
  assert.deepEqual(checkClip({ ...probe, width: 1280, height: 720 }, []), ['кадр 1280×720 не вертикальный']);
  assert.deepEqual(checkClip({ ...probe, hasAudio: false }, []), ['нет звука']);
});

test('тишина внутри — до 3 с включительно, на краях — до 2,4 с', () => {
  assert.deepEqual(checkClip(probe, [{ start: 4, end: 7, duration: 3 }]), []);
  assert.deepEqual(checkClip(probe, [{ start: 4, end: 7.5, duration: 3.5 }]), ['тишина 3.5 с с 4.0 с']);
  assert.deepEqual(checkClip(probe, [{ start: 0, end: 2.4, duration: 2.4 }]), []);
  assert.deepEqual(checkClip(probe, [{ start: 0, end: 2.6, duration: 2.6 }]), ['тишина 2.6 с с 0.0 с (на краю клипа)']);
  assert.deepEqual(checkClip(probe, [{ start: 5.3, end: 8, duration: 2.7 }]), ['тишина 2.7 с с 5.3 с (на краю клипа)']);
});

test('стартовые пределы и громкость', () => {
  assert.deepEqual(CLIP_LIMITS, { minSec: 6.5, maxSec: 9.5, maxSilenceSec: 3, maxEdgeSilenceSec: 2.4 });
  assert.equal(CLIP_LUFS, -19);
});

test('громкость: звук не сдвигается и не длиннее видео', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-loudnorm-'));
  const raw = path.join(dir, 'raw.mp4');
  const out = path.join(dir, 'clip.mp4');
  // Тон 6,0–6,5 с — в последних трёх секундах; звук 8,05 с при видео 8 с: длина не кратна 100 мс.
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=green:s=720x1280:r=24:d=8',
    '-f', 'lavfi', '-i', 'aevalsrc=0.05*sin(2*PI*300*t)*between(t\\,6\\,6.5):s=48000:d=8.05',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', raw]);
  await normalizeLoudness(raw, out);
  const p = await probeFile(out);
  assert.ok(Math.abs(p.durationSec - 8) < 0.05, `длина ${p.durationSec} с`);
  const [lead] = await detectSilences(out, p.durationSec);
  assert.ok(Math.abs(lead.end - 6) < 0.02, `тон начался в ${lead.end} с вместо 6,0 с`);
  fs.rmSync(dir, { recursive: true, force: true });
});
```

В `studio/package.json` в `scripts.test` заменить хвост `src/animate/stt.test.ts"` на `src/animate/stt.test.ts src/animate/clip-check.test.ts"`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/clip-check.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): проверка клипа сценки (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/clip-check.test.ts"
```

Expected: FAIL — модуля `./clip-check` нет.

- [ ] **Step 3: Написать модуль**

`studio/src/animate/clip-check.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProbeInfo, Silence } from '../ffprobe';
import { CLIP_SEC } from './google';

/**
 * Клип сценки перед тем, как взять его в ролик: проверка (длина, вертикальный
 * кадр, звук, тишина) и выравнивание громкости с голосом ассистента.
 */
const run = promisify(execFile);

/**
 * Пределы клипа сценки. Тишина до 3 с: между репликами бывают паузы. На краях
 * клипа строже — 2,4 с: на стыке со сценой рядом тишина складывается с паузой
 * перед голосом ассистента, и её поймала бы уже проверка готового ролика.
 * Стартовые значения; сверяются на ролике-образце.
 */
export const CLIP_LIMITS = { minSec: CLIP_SEC - 1.5, maxSec: CLIP_SEC + 1.5, maxSilenceSec: 3, maxEdgeSilenceSec: 2.4 };

/**
 * Громкость клипов, LUFS: голос SpeechKit в роликах плана 2 звучит на −19,5
 * (замер 26.10.2026), клип Omni без выравнивания — около −16. Стартовая; на
 * образце сверяется (ffmpeg -af ebur128).
 */
export const CLIP_LUFS = -19;

/**
 * Проблемы клипа; пустой список — клип годен. Тишина — из detectSilences с
 * порогами по умолчанию (−45 дБ, от 0,5 с), по уже выровненному клипу.
 */
export function checkClip(probe: ProbeInfo, silences: Silence[]): string[] {
  const problems: string[] = [];
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0) {
    problems.push('длина не определена — ffprobe не вернул длительность');
  } else if (probe.durationSec < CLIP_LIMITS.minSec || probe.durationSec > CLIP_LIMITS.maxSec) {
    problems.push(`длина ${probe.durationSec.toFixed(1)} с вне ${CLIP_LIMITS.minSec}–${CLIP_LIMITS.maxSec} с`);
  }
  if (!probe.width || !probe.height) problems.push('нет видеодорожки');
  else if (probe.height <= probe.width) problems.push(`кадр ${probe.width}×${probe.height} не вертикальный`);
  if (!probe.hasAudio) problems.push('нет звука');
  for (const s of silences) {
    const edge = s.start <= 0.05 || (Number.isFinite(probe.durationSec) && s.end >= probe.durationSec - 0.05);
    const limit = edge ? CLIP_LIMITS.maxEdgeSilenceSec : CLIP_LIMITS.maxSilenceSec;
    if (s.duration > limit) problems.push(`тишина ${s.duration.toFixed(1)} с с ${s.start.toFixed(1)} с${edge ? ' (на краю клипа)' : ''}`);
  }
  return problems;
}

/**
 * Громкость клипа — к CLIP_LUFS, видео не перекодируется. Запас тишины (apad)
 * уводит выдачу буфера loudnorm за конец клипа: без него метки времени звука
 * в последних секундах сдвигаются, и Remotion срезает конец. -shortest
 * обрезает звук по видео.
 */
export async function normalizeLoudness(input: string, output: string, lufs = CLIP_LUFS): Promise<void> {
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-i', input,
    '-c:v', 'copy', '-af', `apad=pad_dur=3,loudnorm=I=${lufs}:TP=-1.5:LRA=11`, '-ar', '48000', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', output,
  ]);
}
```

- [ ] **Step 4: Прогнать тест**

```bash
git -C "$WT" add studio/src/animate/clip-check.ts
git -C "$WT" commit -m "feat(studio): проверка клипа сценки и выравнивание громкости

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/clip-check.test.ts"
```

Expected: `# pass 6`, `# fail 0`.

---

### Task 11: Задание «оживление»

Сердце плана. Порядок: кадр конфликта → обе сценки параллельно (кадр развязки рисуется по кадру конфликта). У каждой сценки — до трёх клипов Omni. Готовое не переделывается: кадр лежит в `keyframes/<отпечаток кадра>.png`, клип — в `skits/<отпечаток клипа>/`. После отказа фильтра кадр не перерисовывается: по нему уже могла быть нарисована развязка.

**Files:**
- Create: `studio/src/animate/run-animate.ts`
- Test: `studio/src/animate/run-animate.test.ts`
- Modify: `studio/package.json` (`scripts.test`, `scripts.animate`)

- [ ] **Step 1: Написать падающий тест**

`studio/src/animate/run-animate.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StudioError } from '../errors';
import type { Script, ShortAnimation, SkitKind, SkitPlan } from '../types';
import { animateRun, type AnimateDeps } from './run-animate';

const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

const LINES: Record<SkitKind, string[]> = {
  conflict: ['Обои потёрли! Залог мой!', 'Спокойно. Спрошу у юриста.'],
  punchline: ['Три года — нормальный износ.', 'Га-га… ладно.'],
};

function plan(kind: SkitKind, lines = LINES[kind], fingerprint = `fp-${kind}`, keyframeFingerprint = `kf-${kind}`): SkitPlan {
  return {
    skit: {
      cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }],
      setting: 'hallway',
      opening: 'at the door',
      action: 'argue',
      lines: lines.map((text, i) => ({ hero: i % 2 ? 'kesha' : 'galina', text })),
    },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: `kf ${kind} ${keyframeFingerprint}`,
    videoPrompt: `video ${kind}: ${lines.join(' / ')}`,
    keyframeFingerprint,
    fingerprint,
  };
}

/** Папка ролика с script.json и портретами; клип-фикстура — 8 с, 720×1280, синус. */
function setup(skits = { conflict: plan('conflict'), punchline: plan('punchline') }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  const runDir = path.join(root, 'run');
  const troupeDir = path.join(root, 'troupe');
  fs.mkdirSync(runDir);
  fs.mkdirSync(path.join(troupeDir, 'v1'), { recursive: true });
  for (const h of ['galina', 'kesha']) ff('-f', 'lavfi', '-i', 'color=c=white:s=64x128', '-frames:v', '1', path.join(troupeDir, 'v1', `${h}.png`));
  const clip = path.join(root, 'clip.mp4');
  ff('-f', 'lavfi', '-i', 'color=c=green:s=720x1280:d=8', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=8', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip);
  writeScript(runDir, skits);
  return { root, runDir, troupeDir, clip: fs.readFileSync(clip), png: fs.readFileSync(path.join(troupeDir, 'v1', 'kesha.png')) };
}

function writeScript(runDir: string, skits: { conflict: SkitPlan; punchline: SkitPlan }) {
  const script = { hook: 'Зацепка', voice: 'madirus', lines: [], final: { assistantsCount: 18 }, skits } as unknown as Script;
  fs.writeFileSync(path.join(runDir, 'script.json'), JSON.stringify(script));
}

const kindOf = (prompt: string): SkitKind => (prompt.includes('punchline') ? 'punchline' : 'conflict');

/** Подделка Google и SpeechKit. «Услышанное» по умолчанию — реплики своей сценки. */
function fakes(
  env: ReturnType<typeof setup>,
  o: {
    heard?: (kind: SkitKind, attempt: number) => string;
    start?: (kind: SkitKind, n: number) => void;
    clip?: (kind: SkitKind, n: number) => Buffer;
    keyframeDelayMs?: Partial<Record<SkitKind, number>>;
    keyframeImage?: { data: Buffer; mime: string };
    recognize?: (kind: SkitKind, attempt: number) => string;
  } = {},
) {
  const calls = { keyframe: [] as Array<{ kind: SkitKind; refs: number }>, start: [] as SkitKind[], startMime: [] as string[] };
  const ids = new Map<string, { kind: SkitKind; n: number }>();
  const deps: AnimateDeps = {
    keyframe: async (prompt, refs) => {
      const kind = kindOf(prompt);
      calls.keyframe.push({ kind, refs: refs.length });
      const delay = o.keyframeDelayMs?.[kind] ?? 0;
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return o.keyframeImage ?? { data: env.png, mime: 'image/png' };
    },
    startClip: async (prompt, image) => {
      const kind = kindOf(prompt);
      const n = calls.start.filter((k) => k === kind).length + 1;
      calls.start.push(kind);
      calls.startMime.push(image.mime);
      o.start?.(kind, n);
      const id = `id-${calls.start.length}`;
      ids.set(id, { kind, n });
      return id;
    },
    waitClip: async (id) => {
      const { kind, n } = ids.get(id)!;
      return o.clip ? o.clip(kind, n) : env.clip;
    },
    recognize: async (_ogg, ctx) => (o.recognize ?? o.heard ?? ((kind: SkitKind) => LINES[kind].join(' ')))(ctx.kind, ctx.attempt),
    troupeDir: env.troupeDir,
  };
  return { deps, calls };
}

const readAnim = (runDir: string): ShortAnimation => JSON.parse(fs.readFileSync(path.join(runDir, 'animation.json'), 'utf8'));

test('обе сценки: кадры по очереди, клипы, речь сошлась, секунды Omni посчитаны', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env);
  const anim = await animateRun(env.runDir, deps);
  assert.deepEqual(calls.keyframe, [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual([...calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.omniSeconds, 16);
  for (const kind of ['conflict', 'punchline'] as const) {
    const s = anim.skits[kind]!;
    assert.equal(s.fingerprint, `fp-${kind}`);
    assert.equal(s.keyframe, `keyframes/kf-${kind}.png`);
    assert.equal(s.attempts, 1);
    assert.equal(s.cues.length, 2);
    assert.ok(Math.abs(s.durationMs - 8000) < 200, `длина ${s.durationMs}`);
    assert.ok(fs.statSync(path.join(env.runDir, s.clip)).size > 1000);
    assert.ok(fs.existsSync(path.join(env.runDir, s.keyframe)));
  }
  assert.deepEqual(readAnim(env.runDir), anim);
});

test('повторный запуск с теми же сценками ничего не генерирует', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const again = fakes(env);
  const anim = await animateRun(env.runDir, again.deps);
  assert.deepEqual(again.calls, { keyframe: [], start: [], startMime: [] });
  assert.equal(anim.omniSeconds, 16);
});

test('правка реплик развязки — новый клип с прежнего кадра, конфликт не трогается', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  const lines = ['Это износ, верните залог.', 'Га-га… ладно.'];
  LINES.punchline = lines;
  try {
    writeScript(env.runDir, { conflict: plan('conflict'), punchline: plan('punchline', lines, 'fp-punchline-2') });
    const second = fakes(env);
    const anim = await animateRun(env.runDir, second.deps);
    assert.deepEqual(second.calls.keyframe, []);
    assert.deepEqual(second.calls.start, ['punchline']);
    assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
    assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline-2');
    assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline.png');
    assert.equal(anim.omniSeconds, 24);
  } finally {
    LINES.punchline = ['Три года — нормальный износ.', 'Га-га… ладно.'];
  }
});

test('новое место конфликта перерисовывает обе сценки: развязка — по новому кадру конфликта', { timeout: 120_000 }, async () => {
  const env = setup();
  await animateRun(env.runDir, fakes(env).deps);
  writeScript(env.runDir, {
    conflict: plan('conflict', LINES.conflict, 'fp-conflict-2', 'kf-conflict-2'),
    punchline: plan('punchline', LINES.punchline, 'fp-punchline-2', 'kf-punchline-2'),
  });
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.keyframe, [{ kind: 'conflict', refs: 2 }, { kind: 'punchline', refs: 3 }]);
  assert.deepEqual([...second.calls.start].sort(), ['conflict', 'punchline']);
  assert.equal(anim.skits.punchline!.keyframe, 'keyframes/kf-punchline-2.png');
  assert.equal(anim.omniSeconds, 32);
});

test('речь не сошлась — пересъёмка клипа без нового кадра', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, { heard: (kind, attempt) => (kind === 'conflict' && attempt === 1 ? '' : LINES[kind].join(' ')) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.length, 2);
  assert.equal(anim.omniSeconds, 24);
});

test('отказ фильтра — новая попытка с прежним кадром: по нему уже нарисована развязка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_rejected', 'omni: отказ фильтра', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(calls.keyframe.filter((k) => k.kind === 'conflict').length, 1);
  assert.equal(anim.omniSeconds, 16, 'несостоявшийся запуск не списывается');
});

test('битый файл от Omni — пересъёмка', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { clip: (kind, n) => (kind === 'conflict' && n === 1 ? Buffer.from('not a video') : env.clip) });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
});

test('квота — сразу ошибка без повтора, секунды не списаны, готовая сценка сохранена', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps, calls } = fakes(env, {
    start: (kind) => {
      if (kind === 'conflict') throw new StudioError('google_quota', 'omni: квота', false);
    },
  });
  await assert.rejects(animateRun(env.runDir, deps), (e: unknown) => e instanceof StudioError && e.code === 'google_quota');
  assert.equal(calls.start.filter((k) => k === 'conflict').length, 1);
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.equal(anim.skits.conflict, undefined);
  assert.equal(anim.skits.punchline!.fingerprint, 'fp-punchline');
});

test('предел секунд Omni на ролик', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { keyframeDelayMs: { punchline: 50 } });
  await assert.rejects(
    animateRun(env.runDir, { ...deps, maxOmniSeconds: 8 }),
    (e: unknown) => e instanceof StudioError && e.code === 'omni_budget' && !e.retryable && /предел — 8 с/.test(e.message),
  );
  const anim = readAnim(env.runDir);
  assert.equal(anim.omniSeconds, 8);
  assert.ok(anim.skits.conflict);
});

test('три несовпадения речи — сдаётся с причиной', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, { heard: (kind) => (kind === 'conflict' ? 'совсем другое' : LINES[kind].join(' ')) });
  await assert.rejects(
    animateRun(env.runDir, deps),
    (e: unknown) => e instanceof StudioError && e.code === 'speech_mismatch' && !e.retryable && /после 3 попыток/.test(e.message),
  );
  assert.equal(readAnim(env.runDir).omniSeconds, 32);
});

test('в сценарии нет сценок — ошибка до трат', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-animate-'));
  fs.writeFileSync(path.join(root, 'script.json'), JSON.stringify({ hook: 'x', voice: 'v', lines: [], final: { assistantsCount: 18 } }));
  await assert.rejects(
    animateRun(root, {} as AnimateDeps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('нет портрета героя — ошибка без повтора', async () => {
  const env = setup();
  fs.rmSync(path.join(env.troupeDir, 'v1', 'kesha.png'));
  await assert.rejects(
    animateRun(env.runDir, fakes(env).deps),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid' && /kesha/.test(e.message),
  );
});

test('кадр в JPEG сохраняется .jpg и уходит в Omni как image/jpeg', { timeout: 120_000 }, async () => {
  const env = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  const { deps, calls } = fakes(env, { keyframeImage: { data: jpeg, mime: 'image/jpeg' } });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.keyframe, 'keyframes/kf-conflict.jpg');
  assert.deepEqual(calls.startMime, ['image/jpeg', 'image/jpeg']);
});

test('запуск с потерянным ответом — секунды не возвращаются: генерация могла начаться', { timeout: 120_000 }, async () => {
  const env = setup();
  const { deps } = fakes(env, {
    start: (kind, n) => {
      if (kind === 'conflict' && n === 1) throw new StudioError('omni_failed', 'omni: запуск — ответ потерян, генерация могла начаться', true);
    },
  });
  const anim = await animateRun(env.runDir, deps);
  assert.equal(anim.skits.conflict!.attempts, 2);
  assert.equal(anim.omniSeconds, 24);
});

test('распознавание упало — перезапуск берёт уже оплаченный клип, а не снимает новый', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = fakes(env, {
    recognize: (kind) => {
      if (kind === 'conflict') throw new StudioError('stt', 'stt: распознать речь не удалось', false);
      return LINES[kind].join(' ');
    },
  });
  await assert.rejects(animateRun(env.runDir, first.deps), (e: unknown) => e instanceof StudioError && e.code === 'stt');
  assert.equal(readAnim(env.runDir).omniSeconds, 16);
  const second = fakes(env);
  const anim = await animateRun(env.runDir, second.deps);
  assert.deepEqual(second.calls.start, []);
  assert.equal(anim.skits.conflict!.fingerprint, 'fp-conflict');
  assert.equal(anim.omniSeconds, 16);
});

test('новая громкость — сценка переобрабатывается из оплаченного клипа, без Omni', { timeout: 120_000 }, async () => {
  const env = setup();
  const first = await animateRun(env.runDir, fakes(env).deps);
  assert.match(first.skits.conflict!.post, /^lufs=-19;/);
  const second = fakes(env);
  const anim = await animateRun(env.runDir, { ...second.deps, lufs: -23 });
  assert.deepEqual(second.calls.start, []);
  assert.deepEqual(second.calls.keyframe, []);
  assert.match(anim.skits.conflict!.post, /^lufs=-23;/);
  assert.match(anim.skits.punchline!.post, /^lufs=-23;/);
  assert.equal(anim.omniSeconds, 16);
});
```

В `studio/package.json`:
- в `scripts.test` заменить хвост `src/animate/clip-check.test.ts"` на `src/animate/clip-check.test.ts src/animate/run-animate.test.ts"`;
- после строки `"render": "tsx src/render/run-render.ts",` добавить `"animate": "tsx src/animate/run-animate.ts",`.

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/animate/run-animate.test.ts studio/package.json
git -C "$WT" commit -m "test(studio): задание «оживление» — кадры, клипы, повторы, предел секунд Omni (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts"
```

Expected: FAIL — модуля `./run-animate` нет.

- [ ] **Step 3: Написать задание**

`studio/src/animate/run-animate.ts`:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../config';
import { StudioError, toStudioError } from '../errors';
import { detectSilences, probeFile } from '../ffprobe';
import type { Script, ShortAnimation, SkitClip, SkitKind, SkitPlan } from '../types';
import { checkClip, CLIP_LUFS, normalizeLoudness } from './clip-check';
import { lineCues, PAUSE_DETECT, voicedSpans } from './cues';
import { CLEAR_REFUSALS, CLIP_SEC, generateKeyframe, imageMime, startClip, waitClip, type GoogleDeps, type ImageInput } from './google';
import { speechCheck } from './match';
import { recognize, speechAudio } from './stt';

const STUDIO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const SKIT_KINDS: readonly SkitKind[] = ['conflict', 'punchline'];
/** Клипов Omni на сценку — не больше (спека, «Отказы»). */
export const MAX_SKIT_ATTEMPTS = 3;
/** Предел секунд Omni на ролик: шесть клипов, ≈ $4,8 (спека, «Отказы»). */
export const DEFAULT_MAX_OMNI_SECONDS = 48;

export interface AnimateDeps {
  keyframe(prompt: string, refs: ImageInput[]): Promise<ImageInput>;
  startClip(prompt: string, image: ImageInput): Promise<string>;
  waitClip(id: string): Promise<Buffer>;
  recognize(ogg: Buffer, ctx: { kind: SkitKind; attempt: number }): Promise<string>;
  /** Корень портретов труппы; по умолчанию studio/assets/troupe. */
  troupeDir?: string;
  /** Громкость клипов, LUFS; по умолчанию CLIP_LUFS. */
  lufs?: number;
  maxOmniSeconds?: number;
  log?(msg: string): void;
}

/** Расширение кадра по его типу: Nano Banana Pro отдаёт JPEG. */
const KEYFRAME_EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

/**
 * Оживление сценок папки ролика: script.json (со сценками) → animation.json,
 * keyframes/<отпечаток кадра>.<jpg|png> и skits/<отпечаток клипа>/{raw.mp4, speech.ogg, clip.mp4}.
 *
 * Кадр развязки рисуется по кадру конфликта (то же место и костюмы), поэтому
 * сначала кадр конфликта, потом обе сценки параллельно. Готовое не
 * переделывается: кадр с тем же отпечатком кадра не перерисовывается, клип с
 * тем же отпечатком клипа не переснимается. Новая реплика переснимает только
 * клип своей сценки, новое место конфликта перерисовывает и развязку — это
 * решают отпечатки (src/shorts/short-skit-prompts.ts бэкенда). Оплаченный клип
 * (raw.mp4) лежит, пока его не забраковали: если задание упало уже после
 * клипа (распознавание, ffmpeg), перезапуск возьмёт его, а не снимет новый.
 * Так же, без Omni, клип переобрабатывается, когда меняются громкость или
 * пороги пауз (поле post у готовой сценки).
 */
export async function animateRun(runDir: string, deps: AnimateDeps): Promise<ShortAnimation> {
  const script = JSON.parse(fs.readFileSync(path.join(runDir, 'script.json'), 'utf8')) as Script;
  const plans = script.skits;
  if (!plans?.conflict || !plans?.punchline) {
    throw new StudioError('script_invalid', 'animate: в сценарии нет сценок (skits.conflict и skits.punchline)', false);
  }
  const animPath = path.join(runDir, 'animation.json');
  const anim: ShortAnimation = fs.existsSync(animPath) ? JSON.parse(fs.readFileSync(animPath, 'utf8')) : { omniSeconds: 0, skits: {} };
  const save = () => fs.writeFileSync(animPath, JSON.stringify(anim, null, 2));
  const budget = deps.maxOmniSeconds ?? DEFAULT_MAX_OMNI_SECONDS;
  const lufs = deps.lufs ?? CLIP_LUFS;
  // Настройки бесплатной части обработки: при их смене готовая сценка переобрабатывается из raw.mp4.
  const post = `lufs=${lufs};pause=${PAUSE_DETECT.noiseDb}dB/${PAUSE_DETECT.minSec}s`;
  const troupeDir = deps.troupeDir ?? path.join(STUDIO_ROOT, 'assets', 'troupe');
  const log = deps.log ?? (() => {});
  const abs = (rel: string) => path.join(runDir, rel);
  const rel = (kind: SkitKind, name: string) => path.posix.join('skits', plans[kind].fingerprint, name);
  const keyframeBase = (kind: SkitKind) => path.posix.join('keyframes', plans[kind].keyframeFingerprint);
  const findKeyframe = (kind: SkitKind): string | null => {
    for (const ext of Object.values(KEYFRAME_EXT)) {
      const rel = `${keyframeBase(kind)}.${ext}`;
      if (fs.existsSync(abs(rel))) return rel;
    }
    return null;
  };
  const readImage = (file: string): ImageInput => {
    const data = fs.readFileSync(file);
    return { data, mime: imageMime(data) };
  };
  const giveUp = (e: StudioError) => new StudioError(e.code, `${e.message} — после ${MAX_SKIT_ATTEMPTS} попыток`, false);

  const reusable = (kind: SkitKind): boolean => {
    const prev = anim.skits[kind];
    return (
      !!prev &&
      prev.fingerprint === plans[kind].fingerprint &&
      prev.post === post &&
      fs.existsSync(abs(prev.clip)) &&
      fs.existsSync(abs(prev.keyframe))
    );
  };

  const portraits = (plan: SkitPlan): ImageInput[] =>
    plan.heroes.map((h) => {
      const f = path.join(troupeDir, plan.troupeVersion, `${h}.png`);
      if (!fs.existsSync(f)) throw new StudioError('script_invalid', `animate: нет портрета героя ${h} (труппа ${plan.troupeVersion})`, false);
      return readImage(f);
    });

  /** Кадр-эталон сценки; нарисованный с тем же отпечатком кадра не перерисовывается. */
  const ensureKeyframe = async (kind: SkitKind): Promise<string> => {
    const have = findKeyframe(kind);
    if (have) return have;
    const refs = portraits(plans[kind]);
    if (kind === 'punchline') {
      const conflictKeyframe = findKeyframe('conflict');
      if (!conflictKeyframe) throw new StudioError('unknown', 'animate: развязку не нарисовать — нет кадра конфликта', false);
      refs.push(readImage(abs(conflictKeyframe)));
    }
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      try {
        const img = await deps.keyframe(plans[kind].keyframePrompt, refs);
        const kf = `${keyframeBase(kind)}.${KEYFRAME_EXT[img.mime] ?? 'png'}`;
        fs.mkdirSync(path.dirname(abs(kf)), { recursive: true });
        fs.writeFileSync(abs(kf), img.data);
        return kf;
      } catch (e) {
        last = toStudioError(e);
        if (!last.retryable) throw last;
        log(`animate ${kind}: кадр, попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  /** Сбой ffmpeg на уже проверенном файле — не повод платить за новый клип. */
  const local = async <T>(kind: SkitKind, what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudioError) throw e;
      throw new StudioError('unknown', `animate ${kind}: ${what} — ${e instanceof Error ? e.message : String(e)}`, false);
    }
  };

  const animateSkit = async (kind: SkitKind): Promise<SkitClip> => {
    const plan = plans[kind];
    const texts = plan.skit.lines.map((l) => l.text);
    const raw = abs(rel(kind, 'raw.mp4'));
    const clip = rel(kind, 'clip.mp4');
    let last: StudioError | null = null;
    for (let attempt = 1; attempt <= MAX_SKIT_ATTEMPTS; attempt++) {
      let reserved = false;
      let started = false;
      try {
        const kf = await ensureKeyframe(kind);
        if (!fs.existsSync(raw)) {
          if (anim.omniSeconds + CLIP_SEC > budget) {
            throw new StudioError('omni_budget', `animate: на ролик ушло ${anim.omniSeconds} с Omni, предел — ${budget} с: лимит пересъёмок сценок`, false);
          }
          // Секунды резервируются до запуска: сценки идут параллельно, и обе не
          // должны пройти предел, когда места осталось на одну.
          anim.omniSeconds += CLIP_SEC;
          reserved = true;
          const id = await deps.startClip(plan.videoPrompt, readImage(abs(kf)));
          started = true;
          save();
          fs.mkdirSync(path.dirname(raw), { recursive: true });
          fs.writeFileSync(raw, await deps.waitClip(id));
        }

        // Нечитаемый файл — вина клипа, а не студии: такой клип переснимается.
        // Забракованный клип удаляется: следующая попытка снимет новый.
        const reject = (code: 'clip_invalid' | 'speech_mismatch', msg: string): never => {
          fs.rmSync(raw, { force: true });
          fs.rmSync(abs(clip), { force: true });
          throw new StudioError(code, msg, true);
        };
        const probe = await probeFile(raw).catch((e: unknown) =>
          reject('clip_invalid', `animate ${kind}: файл от Omni не читается — ${e instanceof Error ? e.message : String(e)}`),
        );
        // Сначала громкость: тишину проверяет и готовый ролик — уже по выровненному звуку.
        await local(kind, 'громкость', () => normalizeLoudness(raw, abs(clip), lufs));
        const problems = checkClip(probe, await local(kind, 'поиск тишины', () => detectSilences(abs(clip), probe.durationSec)));
        if (problems.length) reject('clip_invalid', `animate ${kind}: клип не прошёл проверку — ${problems.join('; ')}`);

        const ogg = await local(kind, 'звук для распознавания', () => speechAudio(abs(clip), abs(rel(kind, 'speech.ogg'))));
        const heard = await deps.recognize(fs.readFileSync(ogg), { kind, attempt });
        const check = speechCheck(texts, heard);
        if (!check.ok) {
          const why = check.silentLines.length
            ? `не услышаны реплики ${check.silentLines.map((i) => i + 1).join(', ')}`
            : `речь не сошлась с репликами (${Math.round(check.share * 100)}%)`;
          reject('speech_mismatch', `animate ${kind}: ${why}, услышано: «${heard.slice(0, 200)}»`);
        }

        const totalMs = Math.round(probe.durationSec * 1000);
        const pauses = await local(kind, 'поиск пауз', () => detectSilences(abs(clip), probe.durationSec, PAUSE_DETECT));
        log(`animate ${kind}: готово с попытки ${attempt}, речь ${Math.round(check.share * 100)}%`);
        return {
          fingerprint: plan.fingerprint,
          keyframe: kf,
          clip,
          durationMs: totalMs,
          heard,
          cues: lineCues(texts, voicedSpans(pauses, totalMs), totalMs),
          attempts: attempt,
          post,
        };
      } catch (e) {
        const err = toStudioError(e);
        // Секунды возвращаются, только если Google явно отказал в запуске: при
        // потерянном ответе генерация могла начаться и будет оплачена.
        if (reserved && !started && CLEAR_REFUSALS.has(err.code)) anim.omniSeconds -= CLIP_SEC;
        save();
        last = err;
        if (!last.retryable) throw last;
        // Кадр не перерисовывается и после отказа фильтра: по кадру конфликта уже
        // могла быть нарисована развязка, и новый кадр развёл бы место и костюмы сценок.
        log(`animate ${kind}: попытка ${attempt} — ${last.message}`);
      }
    }
    throw giveUp(last!);
  };

  const todo = SKIT_KINDS.filter((k) => !reusable(k));
  if (todo.length) {
    await ensureKeyframe('conflict');
    const results = await Promise.allSettled(
      todo.map(async (kind) => {
        anim.skits[kind] = await animateSkit(kind);
        save();
      }),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed) throw toStudioError(failed.reason);
  }
  save();
  return anim;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runDir = process.argv[2];
  if (!runDir) {
    console.error('usage: npm run animate -- <out/папка-ролика>   (MAX_OMNI_SECONDS — предел секунд Omni, по умолчанию 48)');
    process.exit(2);
  }
  const cfg = parseConfig(process.env, { capture: false, tts: true, animate: true });
  const g: GoogleDeps = { apiKey: cfg.googleKey };
  const stt = { apiKey: cfg.speechkitKey, folderId: cfg.speechkitFolder };
  try {
    const anim = await animateRun(path.resolve(runDir), {
      keyframe: (prompt, refs) => generateKeyframe(g, prompt, refs),
      startClip: (prompt, image) => startClip(g, prompt, image),
      waitClip: (id) => waitClip(g, id),
      recognize: (ogg) => recognize(ogg, stt),
      maxOmniSeconds: Number(process.env.MAX_OMNI_SECONDS || DEFAULT_MAX_OMNI_SECONDS),
      log: (m) => console.log(m),
    });
    for (const k of SKIT_KINDS) {
      const s = anim.skits[k];
      console.log(`animate ${k}: попыток ${s?.attempts}, услышано «${s?.heard}»`);
    }
    console.log(`animate: готово — Omni ${anim.omniSeconds} с (≈ $${(anim.omniSeconds * 0.1).toFixed(2)})`);
  } catch (e) {
    const err = toStudioError(e);
    console.error(`animate: ${err.code} — ${err.message}`);
    process.exit(1);
  }
}
```

- [ ] **Step 4: Прогнать тест и типы**

```bash
git -C "$WT" add studio/src/animate/run-animate.ts
git -C "$WT" commit -m "feat(studio): задание «оживление» — кадр по портретам, клип Omni, сверка речи, громкость, время реплик

Готовая сценка с тем же отпечатком не переснимается. Секунды Omni
резервируются до запуска и возвращаются, если запуск не состоялся.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/animate/run-animate.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: `# pass 16`, `# fail 0`, затем `TSC_OK`. Если тест «предел секунд Omni» нестабилен (конфликт и развязка резервируют в другом порядке) — увеличить `keyframeDelayMs.punchline` до 200 мс, а не ослаблять проверку.

---

### Task 12: Таймлайн и проверка сценария со сценками

**Files:**
- Modify: `studio/src/timeline.ts`, `studio/src/timeline.test.ts`
- Modify: `studio/src/script.ts`, `studio/src/script.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В `studio/src/timeline.test.ts` заменить строку импорта:

```ts
import { buildSkitTimeline, buildTimeline, MIN_ANSWER_LINE_MS } from './timeline';
```

и дописать в конец файла:

```ts
const skitLines = (): VoicedLine[] => [line('q', 'question', 4000), line('a1', 'answer', 8000, 1), line('a2', 'answer', 8000, 2), line('f', 'final', 4000)];
const clips = { conflict: 8000, punchline: 8000 };

test('сценки: конфликт → вопрос → ответ → развязка → финал', () => {
  const t = buildSkitTimeline(skitLines(), clips, 30);
  assert.deepEqual(t.scenes.conflict, { from: 0, duration: 240 });
  assert.deepEqual(t.scenes.question, { from: 240, duration: 128 });
  assert.deepEqual(t.scenes.answer, { from: 368, duration: 496 });
  assert.deepEqual(t.scenes.punchline, { from: 864, duration: 240 });
  assert.deepEqual(t.scenes.final, { from: 1104, duration: 128 });
  assert.equal(t.totalFrames, 1232);
  assert.deepEqual(t.segments.map((s) => [s.lineId, s.from]), [['q', 240], ['a1', 368], ['a2', 616], ['f', 1104]]);
});

test('сценки: реплики hook нет — зацепка идёт надписью поверх сценки', () => {
  assert.throws(
    () => buildSkitTimeline([line('h', 'hook', 1500), ...skitLines()], clips, 30),
    (e: unknown) => e instanceof StudioError && e.code === 'script_invalid',
  );
});

test('сценки: ролик 25–45 с', () => {
  const ls = skitLines();
  const long = [...ls.slice(0, 3), line('a3', 'answer', 8000, 3), ls[3]];
  assert.throws(() => buildSkitTimeline(long, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_long');
  const short = [line('q', 'question', 2000), line('a1', 'answer', 2000, 1), line('f', 'final', 2000)];
  assert.throws(() => buildSkitTimeline(short, { conflict: 6000, punchline: 6000 }, 30), (e: unknown) => e instanceof StudioError && e.code === 'too_short');
});

test('сценки: короткая реплика ответа — line_too_short, как у обычного ролика', () => {
  const ls = skitLines();
  ls[1] = line('a1', 'answer', 1000, 1);
  assert.throws(() => buildSkitTimeline(ls, clips, 30), (e: unknown) => e instanceof StudioError && e.code === 'line_too_short');
});
```

В `studio/src/script.test.ts` заменить строку `import type { Script } from './types';` на `import type { Script, SkitPlan } from './types';` и дописать в конец файла:

```ts
const skitPlan = (lines: Array<{ hero: string; text: string; box?: number }>): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка квартиры' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  keyframeFingerprint: 'kf',
  fingerprint: 'f',
});

const skitScript = (): Script => {
  const s = good();
  return {
    ...s,
    lines: s.lines.filter((l) => l.scene !== 'hook'),
    skits: { conflict: skitPlan([{ hero: 'galina', text: 'Залог мой!' }]), punchline: skitPlan([{ hero: 'kesha', text: 'Это износ.', box: 1 }]) },
  };
};

test('ролик со сценками: корректный проходит', () => {
  assert.deepEqual(validateScript(skitScript(), capture), []);
});

test('ролик со сценками: реплика hook лишняя', () => {
  const s = skitScript();
  s.lines.unshift({ id: 'h', scene: 'hook', text: s.hook });
  assert.ok(validateScript(s, capture).some((p) => /реплики hook быть не должно/.test(p)));
});

test('ролик со сценками: сценка без реплик и реплика с несуществующим абзацем', () => {
  const s = skitScript();
  s.skits = { conflict: skitPlan([]), punchline: skitPlan([{ hero: 'kesha', text: 'Износ.', box: 7 }]) };
  const problems = validateScript(s, capture);
  assert.ok(problems.includes('в сценке conflict нет реплик'));
  assert.ok(problems.some((p) => /сценки punchline ссылается на абзац 7/.test(p)));
});

test('ролик со сценками: без отпечатков студия не поймёт, что переснимать', () => {
  const s = skitScript();
  s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: '' } };
  assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
  s.skits = { ...s.skits!, conflict: { ...s.skits!.conflict, fingerprint: 'f', keyframeFingerprint: '' } };
  assert.ok(validateScript(s, capture).includes('у сценки conflict нет отпечатка'));
});
```

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/timeline.test.ts studio/src/script.test.ts
git -C "$WT" commit -m "test(studio): таймлайн и проверка сценария со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/timeline.test.ts src/script.test.ts"
```

Expected: FAIL — нет экспорта `buildSkitTimeline`; проверки сценок в `validateScript` нет.

- [ ] **Step 3: Таймлайн со сценками**

В `studio/src/timeline.ts`:

1. Импорт типов заменить на:

```ts
import type { LineScene, Segment, SkitKind, SkitTimeline, Timeline, VoicedLine } from './types';
```

2. После `export const MIN_ANSWER_LINE_MS = 1500;` добавить:

```ts
/** Ролик со сценками: 25–45 с (спека сценок, «Ролик»). */
export const SKIT_MIN_TOTAL_MS = 25_000;
export const SKIT_MAX_TOTAL_MS = 45_000;
/** Зацепка ролика со сценками — немая надпись поверх конфликта: её читают, а не слушают, поэтому дольше. */
export const SKIT_HOOK_MS = 3000;
```

3. После `const ORDER: LineScene[] = ['hook', 'question', 'answer', 'final'];` добавить:

```ts
/** Озвученные сцены ролика со сценками: зацепка — надпись поверх конфликта, реплики hook нет. */
const SKIT_LINE_ORDER: LineScene[] = ['question', 'answer', 'final'];
```

4. Вынести проверки порядка и длины реплик ответа в две функции перед `buildTimeline`:

```ts
function assertOrder(lines: VoicedLine[], order: LineScene[]): void {
  let at = 0;
  for (const l of lines) {
    const i = order.indexOf(l.scene);
    if (i < at) throw new StudioError('script_invalid', `timeline: сцена ${l.scene} после ${order[at]}; порядок ${order.join(' → ')}`, false);
    at = i;
  }
  for (const s of order) {
    if (!lines.some((l) => l.scene === s)) throw new StudioError('script_invalid', `timeline: в сцене ${s} нет реплик`, false);
  }
}

function assertAnswerLines(lines: VoicedLine[]): void {
  for (const l of lines) {
    if (l.scene === 'answer' && l.durationMs < MIN_ANSWER_LINE_MS) {
      throw new StudioError(
        'line_too_short',
        `timeline: реплика ${l.id} звучит ${(l.durationMs / 1000).toFixed(1)} с — короче ${MIN_ANSWER_LINE_MS / 1000} с: приближение к абзацу не успеет`,
        false,
      );
    }
  }
}
```

5. В `buildTimeline` заменить блок от `let at = 0;` до конца цикла проверки длины реплик ответа (три цикла подряд) на два вызова:

```ts
  assertOrder(lines, ORDER);
  assertAnswerLines(lines);
```

Сообщения ошибок от этого не меняются: `order.join(' → ')` для `ORDER` даёт прежнее «hook → question → answer → final».

6. В конец файла:

```ts
/**
 * Таймлайн ролика со сценками: конфликт (клип) → вопрос → ответ → развязка
 * (клип) → финал. Длину сценок задают клипы, длину остального — озвучка.
 */
export function buildSkitTimeline(lines: VoicedLine[], clips: Record<SkitKind, number>, fps = FPS): SkitTimeline {
  if (lines.some((l) => l.scene === 'hook')) {
    throw new StudioError('script_invalid', 'timeline: у ролика со сценками зацепка — надпись поверх сценки, реплики hook нет', false);
  }
  assertOrder(lines, SKIT_LINE_ORDER);
  assertAnswerLines(lines);

  const gap = msToFrames(GAP_MS, fps);
  const segments: Segment[] = [];
  const scenes = {} as SkitTimeline['scenes'];
  let cursor = 0;
  const clip = (kind: SkitKind) => {
    const duration = Math.max(1, msToFrames(clips[kind], fps));
    scenes[kind] = { from: cursor, duration };
    cursor += duration;
  };
  const voiced = (scene: 'question' | 'answer' | 'final') => {
    const from = cursor;
    for (const l of lines.filter((x) => x.scene === scene)) {
      const duration = Math.max(1, msToFrames(l.durationMs, fps));
      segments.push({ lineId: l.id, scene, text: l.text, box: l.box, audio: l.audio, from: cursor, duration });
      cursor += duration + gap;
    }
    scenes[scene] = { from, duration: cursor - from };
  };
  clip('conflict');
  voiced('question');
  voiced('answer');
  clip('punchline');
  voiced('final');

  const sec = cursor / fps;
  if (sec * 1000 < SKIT_MIN_TOTAL_MS) throw new StudioError('too_short', `timeline: ролик ${sec.toFixed(1)} с — короче 25 с`, false);
  if (sec * 1000 > SKIT_MAX_TOTAL_MS) throw new StudioError('too_long', `timeline: ролик ${sec.toFixed(1)} с — длиннее 45 с`, false);
  return { segments, scenes, totalFrames: cursor };
}
```

- [ ] **Step 4: Проверка сценария со сценками**

В `studio/src/script.ts` перед строкой `const count = script.final?.assistantsCount;` вставить:

```ts
  if (script.skits) {
    if (script.lines.some((l) => l.scene === 'hook')) {
      problems.push('у ролика со сценками зацепка — надпись поверх сценки, реплики hook быть не должно');
    }
    for (const kind of ['conflict', 'punchline'] as const) {
      const p = script.skits[kind];
      if (!p) {
        problems.push(`нет сценки ${kind}`);
        continue;
      }
      if (!p.fingerprint || !p.keyframeFingerprint) problems.push(`у сценки ${kind} нет отпечатка`);
      if (!p.skit?.lines?.length) problems.push(`в сценке ${kind} нет реплик`);
      for (const l of p.skit?.lines ?? []) {
        if (l.box != null && !known.has(l.box)) {
          problems.push(`реплика сценки ${kind} ссылается на абзац ${l.box}, а снято абзацев: ${capture.boxes.length}`);
        }
      }
    }
  }
```

В комментарий над `validateScript` дописать: «У ролика со сценками — ещё сценки: реплики есть, абзацы существуют, отпечаток задан».

- [ ] **Step 5: Прогнать тесты**

```bash
git -C "$WT" add studio/src/timeline.ts studio/src/script.ts
git -C "$WT" commit -m "feat(studio): таймлайн ролика со сценками и проверка сценок в сценарии

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/timeline.test.ts src/script.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: все `pass` (прежние тесты таймлайна и сценария тоже), `# fail 0`, затем `TSC_OK`.

---

### Task 13: Композиция `SkitShort` и её пропсы

**Files:**
- Modify: `studio/src/remotion/Caption.tsx`, `studio/src/remotion/scenes/Hook.tsx`, `studio/src/remotion/Root.tsx`
- Create: `studio/src/remotion/scenes/Clip.tsx`, `studio/src/remotion/SkitShort.tsx`
- Modify: `studio/src/render/props.ts`, `studio/src/render/props.test.ts`

- [ ] **Step 1: Падающий тест пропсов**

В `studio/src/render/props.test.ts` заменить импорты на:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProps, buildSkitProps } from './props';
import type { CaptureResult, Script, ShortAnimation, SkitPlan } from '../types';
import { StudioError } from '../errors';
```

и дописать в конец:

```ts
const skitPlan = (fingerprint: string, lines: string[]): SkitPlan => ({
  skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines: lines.map((text) => ({ hero: 'kesha', text })) },
  troupeVersion: 'v1',
  heroes: ['galina', 'kesha'],
  keyframePrompt: 'k',
  videoPrompt: 'v',
  keyframeFingerprint: `kf-${fingerprint}`,
  fingerprint,
});

const skitScript: Script = {
  hook: 'Хозяйка оставит залог?',
  voice: 'madirus',
  lines: [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист.' },
    { id: 'a1', scene: 'answer', text: 'Первая.', box: 1 },
    { id: 'a2', scene: 'answer', text: 'Вторая.', box: 2 },
    { id: 'f', scene: 'final', text: 'Ссылка в описании.' },
  ],
  final: { assistantsCount: 18 },
  skits: { conflict: skitPlan('fc', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: skitPlan('fp', ['Это износ.']) },
};

const skitMs: Record<string, number> = { q: 4000, a1: 8000, a2: 8000, f: 4000 };
const skitVoiced = skitScript.lines.map((l) => ({ id: l.id, file: `/run/voice/${l.id}.mp3`, durationMs: skitMs[l.id] }));

const animation: ShortAnimation = {
  omniSeconds: 16,
  skits: {
    conflict: { fingerprint: 'fc', keyframe: 'keyframes/kf-fc.png', clip: 'skits/fc/clip.mp4', durationMs: 8000, heard: '', attempts: 1, post: 'lufs=-19',
      cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }] },
    punchline: { fingerprint: 'fp', keyframe: 'keyframes/kf-fp.png', clip: 'skits/fp/clip.mp4', durationMs: 8000, heard: '', attempts: 1, post: 'lufs=-19',
      cues: [{ line: 0, startMs: 500, endMs: 3000 }] },
  },
};

test('пропсы со сценками: клипы и субтитры реплик на своих кадрах', () => {
  const p = buildSkitProps(capture, skitScript, skitVoiced, animation, '/run');
  assert.equal(p.clips.conflict.video, 'skits/fc/clip.mp4');
  assert.equal(p.clips.punchline.video, 'skits/fp/clip.mp4');
  assert.deepEqual(p.clips.conflict.cues[0], { key: 'conflict-0-0', text: 'Обои потёрли! Залог мой!', from: 15, duration: 90 });
  assert.equal(p.timeline.scenes.punchline.from, 864);
  assert.deepEqual(p.clips.punchline.cues[0], { key: 'punchline-0-0', text: 'Это износ.', from: 879, duration: 75 });
  assert.equal(p.hook, 'Хозяйка оставит залог?');
  assert.equal(p.timeline.segments[0].audio, 'voice/q.mp3');
});

test('клип снят под другую сценку — no_input без повтора', () => {
  const stale: ShortAnimation = { ...animation, skits: { ...animation.skits, punchline: { ...animation.skits.punchline!, fingerprint: 'old' } } };
  assert.throws(
    () => buildSkitProps(capture, skitScript, skitVoiced, stale, '/run'),
    (e: unknown) => e instanceof StudioError && e.code === 'no_input' && !e.retryable && /punchline/.test(e.message),
  );
});

test('субтитры реплик сценки не наезжают друг на друга и не выходят за сценку', () => {
  const conflict = { ...animation.skits.conflict!, cues: [{ line: 0, startMs: 1017, endMs: 2035 }, { line: 1, startMs: 2035, endMs: 9000 }] };
  const cues = buildSkitProps(capture, skitScript, skitVoiced, { ...animation, skits: { ...animation.skits, conflict } }, '/run').clips.conflict.cues;
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].from >= cues[i - 1].from + cues[i - 1].duration, `субтитр ${i} начинается внутри предыдущего`);
  const last = cues[cues.length - 1];
  assert.ok(last.from + last.duration <= 240, 'субтитр вылез за сценку конфликта');
});
```

- [ ] **Step 2: Закоммитить красный тест и убедиться, что он падает**

```bash
git -C "$WT" add studio/src/render/props.test.ts
git -C "$WT" commit -m "test(studio): пропсы композиции со сценками (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/props.test.ts"
```

Expected: FAIL — нет экспорта `buildSkitProps`.

- [ ] **Step 3: Пропсы**

`studio/src/render/props.ts` целиком:

```ts
import path from 'node:path';
import { captionCues, splitCaption } from '../captions';
import { StudioError } from '../errors';
import { FRAME } from '../frame';
import { buildSkitTimeline, buildTimeline, FPS, msToFrames } from '../timeline';
import type { TtsResult } from '../tts';
import type { CaptureResult, ClipCue, Script, ShortAnimation, ShortProps, SkitClip, SkitKind, SkitShortProps, VoicedLine } from '../types';

function assertFrame(capture: CaptureResult): void {
  if (capture.answerShotWidth !== FRAME.width) {
    throw new StudioError(
      'frame_size',
      `props: снимок ответа шириной ${capture.answerShotWidth} px, нужен ${FRAME.width} — съёмка шла не в кадре ${FRAME.width}×${FRAME.height}`,
      false,
    );
  }
}

function voicedLines(script: Script, voiced: TtsResult[], runDir: string): VoicedLine[] {
  const byId = new Map(voiced.map((v) => [v.id, v]));
  return script.lines.map((l) => {
    const v = byId.get(l.id);
    if (!v) throw new Error(`props: нет озвучки реплики ${l.id}`);
    return { ...l, durationMs: v.durationMs, audio: path.relative(runDir, v.file) };
  });
}

/**
 * Склеивает съёмку, сценарий и озвучку в пропсы композиции Short. Пути к
 * файлам — относительно папки съёмки: она же publicDir бандла, staticFile()
 * ищет файлы в ней.
 */
export function buildProps(capture: CaptureResult, script: Script, voiced: TtsResult[], runDir: string): ShortProps {
  assertFrame(capture);
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline: buildTimeline(voicedLines(script, voiced, runDir), FPS),
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
  };
}

/** Пропсы композиции SkitShort: то же плюс клипы сценок и субтитры их реплик в кадрах ролика. */
export function buildSkitProps(capture: CaptureResult, script: Script, voiced: TtsResult[], animation: ShortAnimation, runDir: string): SkitShortProps {
  assertFrame(capture);
  const skits = script.skits;
  if (!skits) throw new StudioError('script_invalid', 'props: в сценарии нет сценок', false);
  const clips = {} as Record<SkitKind, SkitClip>;
  for (const kind of ['conflict', 'punchline'] as const) {
    const c = animation.skits[kind];
    if (!c || c.fingerprint !== skits[kind].fingerprint) {
      throw new StudioError('no_input', `props: клип сценки ${kind} не снят под этот сценарий — сначала npm run animate`, false);
    }
    clips[kind] = c;
  }
  const timeline = buildSkitTimeline(voicedLines(script, voiced, runDir), { conflict: clips.conflict.durationMs, punchline: clips.punchline.durationMs }, FPS);
  // Начало и конец реплики переводятся в кадры по отдельности: округление
  // длины давало кадр с двумя субтитрами. Конец не выходит за сценку.
  const cues = (kind: SkitKind): ClipCue[] =>
    clips[kind].cues.flatMap((c) => {
      const scene = timeline.scenes[kind];
      const a = msToFrames(c.startMs, FPS);
      const b = Math.min(msToFrames(c.endMs, FPS), scene.duration);
      if (a >= b) return [];
      const text = skits[kind].skit.lines[c.line]?.text ?? '';
      return captionCues(splitCaption(text), scene.from + a, b - a).map((q, i) => ({ key: `${kind}-${c.line}-${i}`, ...q }));
    });
  return {
    fps: FPS,
    hook: script.hook,
    badge: script.badge,
    questionShot: capture.questionShot,
    answerShot: capture.answerShot,
    answerShotHeight: capture.answerShotHeight,
    boxes: capture.boxes,
    timeline,
    final: { assistantsCount: script.final.assistantsCount, disclaimer: script.final.disclaimer },
    clips: {
      conflict: { video: clips.conflict.clip, cues: cues('conflict') },
      punchline: { video: clips.punchline.clip, cues: cues('punchline') },
    },
  };
}
```

- [ ] **Step 4: Субтитры с готовыми кадрами**

`studio/src/remotion/Caption.tsx` целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import { captionCues, splitCaption } from '../captions';
import type { ClipCue, Segment } from '../types';
import { C, fontFamily } from './theme';

/**
 * Субтитр: крупно, в средней трети кадра — снизу и справа Shorts и Клипы
 * рисуют свои кнопки и подпись.
 */
const CaptionBox: React.FC<{ text: string }> = ({ text }) => (
  <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 160px 560px 80px' }}>
    <div
      style={{
        fontFamily,
        fontWeight: 900,
        fontSize: 62,
        lineHeight: 1.15,
        color: C.white,
        background: C.shade,
        borderRadius: 28,
        padding: '18px 30px',
        textAlign: 'center',
      }}
    >
      {text}
    </div>
  </AbsoluteFill>
);

/** Субтитры с готовыми кадрами — у реплик сценок. */
export const CueCaptions: React.FC<{ cues: ClipCue[] }> = ({ cues }) => (
  <>
    {cues.map((c) => (
      <Sequence key={c.key} from={c.from} durationInFrames={c.duration}>
        <CaptionBox text={c.text} />
      </Sequence>
    ))}
  </>
);

/** Субтитры озвученных реплик: длинная режется на куски по словам. */
export const Captions: React.FC<{ segments: Segment[] }> = ({ segments }) => (
  <CueCaptions
    cues={segments.flatMap((s) => captionCues(splitCaption(s.text), s.from, s.duration).map((cue, i) => ({ key: `${s.lineId}-${i}`, ...cue })))}
  />
);
```

- [ ] **Step 5: Текст зацепки отдельным компонентом**

`studio/src/remotion/scenes/Hook.tsx` целиком:

```tsx
import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { C, fontFamily } from '../theme';

/** Крупный текст зацепки с «выскакиванием». Им же подписан конфликт ролика со сценками (Clip). */
export const HookText: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 14 } });
  return (
    <div
      style={{
        fontFamily,
        fontWeight: 900,
        fontSize: 92,
        lineHeight: 1.08,
        color: C.white,
        textAlign: 'center',
        textShadow: '0 6px 24px rgba(0,0,0,0.45)',
        transform: `scale(${interpolate(pop, [0, 1], [0.85, 1])})`,
      }}
    >
      {text}
    </div>
  );
};

/** Зацепка: снимок вопроса под затемнением, поверх — крупный текст. */
export const Hook: React.FC<{ hook: string; questionShot: string }> = ({ hook, questionShot }) => (
  <AbsoluteFill style={{ backgroundColor: C.ink }}>
    <Img src={staticFile(questionShot)} style={{ width: '100%', height: '100%', objectFit: 'cover', opacity: 0.3 }} />
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', padding: '0 90px' }}>
      <HookText text={hook} />
    </AbsoluteFill>
  </AbsoluteFill>
);
```

- [ ] **Step 6: Сцена-клип и композиция**

`studio/src/remotion/scenes/Clip.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, OffthreadVideo, Sequence, staticFile } from 'remotion';
import { HookText } from './Hook';

/**
 * Сценка — клип Omni на весь кадр (720×1280 растягивается до 1080×1920),
 * со своим звуком. У конфликта первые секунды поверх идёт надпись-зацепка:
 * в верхней трети, выше субтитров реплик.
 */
export const Clip: React.FC<{ video: string; hook?: string; hookFrames?: number }> = ({ video, hook, hookFrames = 0 }) => (
  <AbsoluteFill style={{ backgroundColor: '#000' }}>
    <OffthreadVideo src={staticFile(video)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    {hook && hookFrames > 0 ? (
      <Sequence durationInFrames={hookFrames}>
        <AbsoluteFill
          style={{
            justifyContent: 'flex-start',
            alignItems: 'center',
            padding: '260px 90px 0',
            background: 'linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 45%)',
          }}
        >
          <HookText text={hook} />
        </AbsoluteFill>
      </Sequence>
    ) : null}
  </AbsoluteFill>
);
```

`studio/src/remotion/SkitShort.tsx`:

```tsx
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { msToFrames, SKIT_HOOK_MS } from '../timeline';
import type { SkitShortProps } from '../types';
import { Captions, CueCaptions } from './Caption';
import { Answer } from './scenes/Answer';
import { Clip } from './scenes/Clip';
import { Final } from './scenes/Final';
import { Question } from './scenes/Question';

/**
 * Ролик со сценками: конфликт (Omni) → вопрос → настоящий ответ → развязка
 * (Omni) → финал. Зацепка — надпись поверх первых секунд конфликта.
 */
export const SkitShort: React.FC<SkitShortProps> = (p) => {
  const { scenes, segments } = p.timeline;
  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <Sequence from={scenes.conflict.from} durationInFrames={scenes.conflict.duration}>
        <Clip video={p.clips.conflict.video} hook={p.hook} hookFrames={msToFrames(SKIT_HOOK_MS, p.fps)} />
      </Sequence>
      <Sequence from={scenes.question.from} durationInFrames={scenes.question.duration}>
        <Question questionShot={p.questionShot} durationInFrames={scenes.question.duration} badge={p.badge} />
      </Sequence>
      <Sequence from={scenes.answer.from} durationInFrames={scenes.answer.duration}>
        <Answer
          answerShot={p.answerShot}
          imageHeight={p.answerShotHeight}
          boxes={p.boxes}
          segments={segments.filter((s) => s.scene === 'answer')}
          sceneFrom={scenes.answer.from}
        />
      </Sequence>
      <Sequence from={scenes.punchline.from} durationInFrames={scenes.punchline.duration}>
        <Clip video={p.clips.punchline.video} />
      </Sequence>
      <Sequence from={scenes.final.from} durationInFrames={scenes.final.duration}>
        <Final assistantsCount={p.final.assistantsCount} disclaimer={p.final.disclaimer} />
      </Sequence>
      <Captions segments={segments.filter((s) => s.scene === 'question' || s.scene === 'answer')} />
      <CueCaptions cues={[...p.clips.conflict.cues, ...p.clips.punchline.cues]} />
      {segments.map((s) => (
        // У каждой реплики своя длина: отыгравший звук размонтируется (урок веб-плеера мультфильма).
        <Sequence key={s.lineId} from={s.from} durationInFrames={s.duration}>
          <Audio src={staticFile(s.audio)} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};
```

`studio/src/remotion/Root.tsx` целиком:

```tsx
import React from 'react';
import { Composition, type CalculateMetadataFunction } from 'remotion';
import type { ShortProps, SkitShortProps } from '../types';
import { Short } from './Short';
import { SkitShort } from './SkitShort';
import { H, W } from './theme';

/** Длина ролика — из таймлайна в пропсах: её задаёт озвучка (и клипы сценок). */
const calculateMetadata: CalculateMetadataFunction<ShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});
const calculateSkitMetadata: CalculateMetadataFunction<SkitShortProps> = ({ props }) => ({
  durationInFrames: props.timeline.totalFrames,
  fps: props.fps,
});

/** Пропсы-заглушки. Настоящие приходят из src/render/run-render.ts. */
const PLACEHOLDER: ShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      hook: { from: 0, duration: 60 },
      question: { from: 60, duration: 90 },
      answer: { from: 150, duration: 600 },
      final: { from: 750, duration: 150 },
    },
    totalFrames: 900,
  },
  final: { assistantsCount: 18 },
};

const SKIT_PLACEHOLDER: SkitShortProps = {
  fps: 30,
  hook: 'Зацепка',
  questionShot: 'question.png',
  answerShot: 'answer.png',
  answerShotHeight: 1920,
  boxes: [{ n: 1, top: 400, height: 200, text: '' }],
  timeline: {
    segments: [],
    scenes: {
      conflict: { from: 0, duration: 240 },
      question: { from: 240, duration: 120 },
      answer: { from: 360, duration: 360 },
      punchline: { from: 720, duration: 240 },
      final: { from: 960, duration: 120 },
    },
    totalFrames: 1080,
  },
  final: { assistantsCount: 18 },
  clips: { conflict: { video: 'conflict.mp4', cues: [] }, punchline: { video: 'punchline.mp4', cues: [] } },
};

export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="Short"
      component={Short}
      width={W}
      height={H}
      fps={30}
      durationInFrames={PLACEHOLDER.timeline.totalFrames}
      defaultProps={PLACEHOLDER}
      calculateMetadata={calculateMetadata}
    />
    <Composition
      id="SkitShort"
      component={SkitShort}
      width={W}
      height={H}
      fps={30}
      durationInFrames={SKIT_PLACEHOLDER.timeline.totalFrames}
      defaultProps={SKIT_PLACEHOLDER}
      calculateMetadata={calculateSkitMetadata}
    />
  </>
);
```

- [ ] **Step 7: Прогнать тесты и типы**

```bash
git -C "$WT" add studio/src/render/props.ts studio/src/remotion
git -C "$WT" commit -m "feat(studio): композиция SkitShort — клипы сценок, зацепка поверх конфликта, субтитры реплик

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/props.test.ts src/captions.test.ts && npm run typecheck && echo TSC_OK"
```

Expected: все `pass`, `# fail 0`, затем `TSC_OK`.

---

### Task 14: Сборка ролика со сценками

**Files:**
- Modify: `studio/src/ffprobe.ts` (`SKIT_LIMITS`)
- Modify: `studio/src/render/run-render.ts`
- Create: `studio/src/render/render-skit.fixture.ts`
- Modify: `studio/package.json` (`scripts.test:render`)

- [ ] **Step 1: Падающая фикстура сборки**

`studio/src/render/render-skit.fixture.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ttsKey } from '../tts';
import { renderRun } from './run-render';

/**
 * Сборка ролика со сценками из фикстуры без сети: клипы сценок, картинки и
 * «голос» (синус) делает ffmpeg, озвучка берётся из кеша. Папка не удаляется —
 * по ней смотрят кадры.
 */
test('рендер фикстуры со сценками: 1080×1920, 25–45 с, звук по всей длине', { timeout: 15 * 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-skit-fixture-'));
  console.log(`fixture: ${dir}`);
  const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  ff('-f', 'lavfi', '-i', 'color=c=0xedfaed:s=1080x1920', '-frames:v', '1', path.join(dir, 'question.png'));
  ff('-f', 'lavfi', '-i', 'color=c=white:s=1080x5400', '-frames:v', '1', path.join(dir, 'answer.png'));
  for (const [kind, color] of [['conflict', 'orange'], ['punchline', 'purple']] as const) {
    const d = path.join(dir, 'skits', `fx-${kind}`);
    fs.mkdirSync(d, { recursive: true });
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280:d=8`, '-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-shortest',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(d, 'clip.mp4'));
    ff('-f', 'lavfi', '-i', `color=c=${color}:s=720x1280`, '-frames:v', '1', path.join(d, 'keyframe.png'));
  }

  const lines = [
    { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Жилец спросил про залог.', ms: 5000 },
    { id: 'a1', scene: 'answer', text: 'Квартиру возвращают с учётом нормального износа.', ms: 6000, box: 1 },
    { id: 'a2', scene: 'answer', text: 'Ущерб хозяйка должна доказать.', ms: 6000, box: 2 },
    { id: 'f', scene: 'final', text: 'Linkeon. Ссылка — в описании.', ms: 4000 },
  ] as const;
  fs.mkdirSync(path.join(dir, 'voice'));
  const manifest: Record<string, { key: string; durationMs: number }> = {};
  for (const l of lines) {
    ff('-f', 'lavfi', '-i', `sine=frequency=440:duration=${l.ms / 1000}`, '-ac', '1', '-ar', '44100', path.join(dir, 'voice', `${l.id}.mp3`));
    manifest[l.id] = { key: ttsKey({ text: l.text, voice: 'madirus', speed: 1 }), durationMs: l.ms };
  }
  fs.writeFileSync(path.join(dir, 'voice', 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, 'capture.json'),
    JSON.stringify({
      scene: { kind: 'chat', assistantId: 10, assistantName: 'Алексей', question: 'Хозяйка не отдаёт залог', followups: [] },
      cabinetUrl: 'fixture',
      capturedAt: new Date(0).toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: 1080,
      answerShotHeight: 5400,
      answerText: 'x'.repeat(500),
      turns: 1,
      boxes: [{ n: 1, top: 900, height: 300, text: 'a' }, { n: 2, top: 2400, height: 300, text: 'b' }],
      paragraphs: [{ n: 1, text: 'a' }, { n: 2, text: 'b' }],
    }),
  );
  const plan = (kind: string, texts: string[]) => ({
    skit: { cast: [{ hero: 'galina', role: 'хозяйка' }, { hero: 'kesha', role: 'жилец' }], setting: 's', opening: 'o', action: 'a', lines: texts.map((text) => ({ hero: 'kesha', text })) },
    troupeVersion: 'v1',
    heroes: ['galina', 'kesha'],
    keyframePrompt: 'k',
    videoPrompt: 'v',
    keyframeFingerprint: `fx-kf-${kind}`,
    fingerprint: `fx-${kind}`,
  });
  fs.writeFileSync(
    path.join(dir, 'script.json'),
    JSON.stringify({
      hook: 'Хозяйка оставит весь залог?',
      voice: 'madirus',
      speed: 1,
      lines: lines.map((l) => ({ id: l.id, scene: l.scene, text: l.text, ...('box' in l ? { box: l.box } : {}) })),
      final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
      skits: { conflict: plan('conflict', ['Обои потёрли! Залог мой!', 'Спокойно.']), punchline: plan('punchline', ['Это износ.', 'Га-га… ладно.']) },
    }),
  );
  const clip = (kind: string) => ({
    fingerprint: `fx-${kind}`,
    keyframe: `skits/fx-${kind}/keyframe.png`,
    clip: `skits/fx-${kind}/clip.mp4`,
    durationMs: 8000,
    heard: '',
    attempts: 1,
    post: 'lufs=-19',
    cues: [{ line: 0, startMs: 500, endMs: 3500 }, { line: 1, startMs: 4000, endMs: 7000 }],
  });
  fs.writeFileSync(path.join(dir, 'animation.json'), JSON.stringify({ omniSeconds: 16, skits: { conflict: clip('conflict'), punchline: clip('punchline') } }));

  const r = await renderRun(dir, { skipTts: true });
  assert.deepEqual(r.problems, []);
  assert.ok(r.durationSec >= 25 && r.durationSec <= 45, `длина ${r.durationSec}`);
  assert.ok(fs.statSync(r.cover).size > 10_000, 'обложка подозрительно мала');
});
```

В `studio/package.json` заменить `"test:render": "tsx --test src/render/render.fixture.ts",` на `"test:render": "tsx --test src/render/render.fixture.ts src/render/render-skit.fixture.ts",`.

- [ ] **Step 2: Закоммитить красное и убедиться, что падает**

```bash
git -C "$WT" add studio/src/render/render-skit.fixture.ts studio/package.json
git -C "$WT" commit -m "test(studio): сборка ролика со сценками из фикстуры (красный)

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npx tsx --test src/render/render-skit.fixture.ts"
```

Запускать с `run_in_background`. Expected: FAIL — `validateScript` пропускает сценарий, но `buildProps` строит обычный таймлайн и падает на отсутствии реплики `hook` («зацепка (hook) — первая и единственная реплика своей сцены»).

- [ ] **Step 3: Пределы ролика со сценками**

В `studio/src/ffprobe.ts` к импортам добавить `import { CLIP_LIMITS } from './animate/clip-check';` (clip-check импортирует из ffprobe только типы — цикла нет), а после `export const SHORT_LIMITS …;`:

```ts
/**
 * Ролик со сценками: 25–45 с; паузы — те же, что внутри клипа сценки
 * (CLIP_LIMITS, animate/clip-check.ts): между репликами сценок бывают паузы.
 */
export const SKIT_LIMITS: VerifyLimits = { ...SHORT_LIMITS, minSec: 25, maxSec: 45, maxSilenceSec: CLIP_LIMITS.maxSilenceSec };
```

- [ ] **Step 4: Сборка по формату сценария**

В `studio/src/render/run-render.ts`:

1. Импорты заменить на:

```ts
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { parseConfig } from '../config';
import { StudioError } from '../errors';
import { detectSilences, probeFile, SHORT_LIMITS, SKIT_LIMITS, verifyVideo } from '../ffprobe';
import { validateScript } from '../script';
import { synthesizeAll } from '../tts';
import type { CaptureResult, Script, ShortAnimation, ShortProps, SkitShortProps } from '../types';
import { buildProps, buildSkitProps } from './props';
```

2. Строку `const inputProps = buildProps(capture, script, voiced, runDir);` заменить на:

```ts
  // Ролик со сценками собирается своей композицией из клипов задания animate.
  let compositionId = 'Short';
  let limits = SHORT_LIMITS;
  let inputProps: ShortProps | SkitShortProps;
  if (script.skits) {
    const animPath = path.join(runDir, 'animation.json');
    if (!fs.existsSync(animPath)) throw new StudioError('no_input', 'render: у ролика со сценками нет animation.json — сначала npm run animate', false);
    const animation = JSON.parse(fs.readFileSync(animPath, 'utf8')) as ShortAnimation;
    inputProps = buildSkitProps(capture, script, voiced, animation, runDir);
    compositionId = 'SkitShort';
    limits = SKIT_LIMITS;
  } else {
    inputProps = buildProps(capture, script, voiced, runDir);
  }
```

3. `selectComposition({ serveUrl, id: 'Short', inputProps })` → `selectComposition({ serveUrl, id: compositionId, inputProps })`.

4. `verifyVideo(probe, silences)` → `verifyVideo(probe, silences, limits)`.

5. В комментарий над `renderRun` дописать: «Сценарий со сценками собирается композицией SkitShort: нужен animation.json задания animate (npm run animate)».

- [ ] **Step 5: Прогнать обе фикстуры сборки и типы**

```bash
git -C "$WT" add studio/src/ffprobe.ts studio/src/render/run-render.ts
git -C "$WT" commit -m "feat(studio): сборка ролика со сценками — композиция SkitShort, пределы 25–45 с

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
"$WT"/studio/scripts/node-run.sh "npm run test:render && npm run typecheck && echo TSC_OK"
```

Запускать с `run_in_background`. Expected: обе фикстуры `pass` (прежняя — обычный ролик — тоже), затем `TSC_OK`. Скопировать кадр середины конфликта и развязки и посмотреть глазами — на них видны зацепка (первые 3 с) и субтитры реплик:

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'd=$(ls -dt /tmp/studio-skit-fixture-* | head -1); ffmpeg -hide_banner -loglevel error -y -i $d/video.mp4 -vf "select=eq(n\,30)+eq(n\,100)+eq(n\,900),scale=360:-1,tile=3x1" -frames:v 1 /tmp/skit-fixture-strip.jpg && echo $d'
scp -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231:/tmp/skit-fixture-strip.jpg /tmp/skit-fixture-strip.jpg
```

Открыть `/tmp/skit-fixture-strip.jpg` (Read). Expected: кадр 30 — оранжевый фон с крупной зацепкой сверху и субтитром «Обои потёрли! Залог мой!» ниже середины; кадр 100 — субтитр «Обои потёрли! Залог мой!» или «Спокойно.» без зацепки; кадр 900 — фиолетовая развязка с субтитром.

---

### Вторая волна правок по ревью (26.10.2026)

После задач 11–14 ревью качества (по каждой задаче и повторные — по правкам первой волны) дали вторую волну правок. Код был собран и прогнан целиком на проверочном воркдереве ноды до коммитов, затем внесён парами «красный тест → правка»:

| Коммиты | Что |
|---|---|
| `fe9aade`, `142d032` | API: проверка сценки внутри сборщиков промптов, поля сценки — только английские строки, герои названы в строке состава, отпечаток кадра конфликта — только развязке; двусторонний сторож контракта; CLI проверяет, что второй файл — сценарий студии; образец — обои вместо краски |
| `a1aa097`, `e62e41c` | Модули студии: опрос Omni по часам, `omni_timeout`, скачивание без новой генерации, суточная и нулевая квота не пережидаются, FAILED_PRECONDITION — ключ, ключ вырезается до обрезки текста; SpeechKit — пустой ответ повторяется; сверка речи по гласным и предложениям; громкость через `apad`; длина по видеодорожке (`ProbeInfo.videoSec`); `SKIT_MAX_SILENCE_SEC` и `SKIT_LIMITS` из констант таймлайна; `SKIT_KINDS`, `pending` и `keyframes` в `ShortAnimation` |
| `8e7ca9d`, `c63f1db` | Задание `animate`: id генерации в `animation.json` и дожидание вместо новой оплаты, брак в `rejected-*.mp4`, переобработка без Omni и SpeechKit, кадр — только под новый клип, атомарная запись, сценка в тексте ошибки, предел — целое число |
| `407219a`, `f9dc5ae` | Сборка: длина клипов в таймлайне, время реплик сценок сверяется со сценарием, клипы — до озвучки и бандла, обложка без субтитров, зацепка гаснет, длина ролика с двумя знаками и разбивкой; фикстура — паузы клипов как у Omni и проверка пикселя обложки |

Итог на `f9dc5ae`: студия 186/186, typecheck, обе фикстуры сборки; бэкенд `src/shorts` 591 тест, гейт типов.

Повторные ревью второй волны одобрили все четыре пары и дали третью, мелкую (`6ded776..3e26b69`, тесты одним блоком, затем правки):

| Что | |
|---|---|
| API | латинские кавычки в английских полях; правило 17 до промптов; паспорт — зверь целым словом |
| Google и сверка речи | `omni_unreadable` — готовую генерацию, которую не забрать, не переснимать; ключ вырезается буквально; ключ — только по https; опрос не выходит за срок; 429 без вида лимита — не «жди до утра»; междометие или крик последним предложением и повтор слога через тире не дают ложного брака; таймаут ffmpeg громкости |
| Оживление | переобработка через `clip.next.mp4`; кадр конфликта не перерисовывается, если по нему нарисована развязка; принятый клип без `raw.mp4` — ошибка; предел до кадра; id не забранной генерации сохраняется с подсказкой |
| Сборка | реплика сценки без единого кадра — ошибка; клип длиннее 9,5 с — ошибка, а не «сократите озвучку»; путь клипа — файл; тип сборки связывает композицию и пропсы; пиксель обложки — по центру плашки |

Отложенное — в задаче 17 и плане 4.

---

### Task 15: Полный прогон на ноде

**Files:** —

- [ ] **Step 1: Все тесты студии, типы и обе фикстуры сборки**

```bash
"$WT"/studio/scripts/node-run.sh "npm test && npm run typecheck && echo TSC_OK && npm run test:render"
```

Запускать с `run_in_background`. Expected: `npm test` — `# fail 0`; `TSC_OK`; `test:render` — обе фикстуры `pass`.

- [ ] **Step 2: Модуль роликов бэкенда и гейт типов**

```bash
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx jest src/shorts && npx tsc --noEmit -p tsconfig.build.json && echo TSC_OK"
```

Expected: все сюиты `src/shorts` зелёные (интеграционная `shorts.integration.spec.ts` без базы пропускается так же, как в плане 2), затем `TSC_OK`.

- [ ] **Step 3: Итоговое ревью кода плана**

Отдать ревьюеру (субагент `superpowers:code-reviewer`, модель opus) диапазон `96bf5b8..HEAD` ветки `feat/promo-shorts` со ссылкой на спеку сценок и этот план. Важные замечания исправляются до задачи 16 (тест → правка → прогон → коммит), мелкие — записываются в «Итоги образца» задачи 17.

---

### Task 16: Ролик-образец

Сценарий образца (задача 4) построен на настоящей съёмке стенда: папка `~/ci/wt/promo-shorts/studio/out/jobs/987f6045-3275-42fe-8922-7305630782dd/render-1/` на ноде. Живые вызовы Google стоят денег: ожидаемо ≈ $1,9 (два клипа Omni по $0,80 и два кадра).

**Files:** — (только папка `studio/out/skit-sample-1/` на ноде, она вне git)

- [ ] **Step 1: Ключ Google в `.env` студии на ноде — без вывода на экран**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'f=~/ci/wt/promo-shorts/studio/.env; grep -q "^GOOGLE_AI_API_KEY=." "$f" || grep "^GOOGLE_AI_API_KEY=" ~/spirits_back/.env >> "$f"; grep -c "^GOOGLE_AI_API_KEY=." "$f"'
```

Expected: `1`. Если `0` — ключа нет и в `~/spirits_back/.env`: остановиться и спросить владельца.

- [ ] **Step 2: Папка образца из настоящей съёмки**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'cd ~/ci/wt/promo-shorts/studio && src=out/jobs/987f6045-3275-42fe-8922-7305630782dd/render-1 && mkdir -p out/skit-sample-1 && cp $src/capture.json $src/question.png $src/answer.png out/skit-sample-1/ && ls out/skit-sample-1'
```

Expected: `answer.png  capture.json  question.png`. Если папки съёмки нет — остановиться и сообщить: нужна новая съёмка через рабочий процесс стенда, это отдельное решение.

- [ ] **Step 3: Сценарий с промптами**

```bash
NODE_RUN_DIR=. "$WT"/studio/scripts/node-run.sh "npx ts-node scripts/shorts-skit-plan.ts studio/samples/zalog/skits.json studio/samples/zalog/script.base.json studio/out/skit-sample-1/script.json"
```

Expected: `skit-plan: studio/out/skit-sample-1/script.json — conflict <16 hex>, punchline <16 hex>`.

- [ ] **Step 4: Оживление**

```bash
"$WT"/studio/scripts/node-run.sh "npm run animate -- out/skit-sample-1"
```

Запускать с `run_in_background`. Expected (через 3–10 минут): строки `animate conflict: попыток 1…3, услышано «…»`, `animate punchline: …`, затем `animate: готово — Omni 16 с, кадров 2 (≈ $1.86)` (больше, если были пересъёмки).

Если упало (текст ошибки начинается с имени сценки):
- `google_quota` — поминутный лимит или квота на сегодня (текст говорит, какой); повторить тем же шагом — после суточной квоты ≈ после 11:00 МСК. Готовая сценка не переснимется, запущенная генерация дождётся;
- `omni_timeout` — Omni не уложился в срок; повторить тем же шагом: запуск дождётся той же генерации, а не заплатит снова;
- `keyframe` без повтора (промпт кадра заблокирован) — переписать `setting` или `opening` сценки в `studio/samples/zalog/skits.json`, шаг 3 и снова шаг 4;
- `model_gone` или `google_auth` — остановиться и сообщить владельцу;
- `omni_unreadable` — генерация готова и оплачена, но студия её не забрала: остановиться, поправить разбор ответа в `studio/src/animate/google.ts` тестом на этом ответе и повторить шаг 4 — запуск заберёт ту же генерацию без оплаты;
- `speech_mismatch` после 3 попыток — посмотреть `heard` в выводе и забракованные клипы `skits/<отпечаток>/rejected-*.mp4`. Если Omni говорит, но SpeechKit систематически пишет иначе (имена, междометия), — это правка нормализации в `match.ts` тестом на этом самом `heard` (задача 17), а не повод перезапускать вслепую. Порог `MATCH_THRESHOLD` трогать только от случайного шума: снижение ради нормализации затупит проверку для всех клипов.

- [ ] **Step 5: Сборка**

```bash
"$WT"/studio/scripts/node-run.sh "npm run render -- out/skit-sample-1"
```

Запускать с `run_in_background`. Expected: `render: готово → …/out/skit-sample-1/video.mp4 (обложка …/cover.jpg)`. Если `too_long` — ролик длиннее 45 с (в тексте — разбивка «сценки / озвучка»): сократить реплику `q` в `studio/samples/zalog/script.base.json`, закоммитить и повторить шаги 3 и 5 (шаг 4 ничего не переснимет: сценки не менялись). Если проверка файла пишет «тишина 3.x с» около начала развязки — это стык «ответ → развязка» (ревью задачи 14, п. 3): записать замер и решить в задаче 17, без пересъёмки.

- [ ] **Step 6: Самопроверка до показа владельцу**

```bash
ssh -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 'cd ~/ci/wt/promo-shorts/studio/out/skit-sample-1 && ffmpeg -hide_banner -loglevel error -y -i video.mp4 -vf "fps=1/3,scale=270:-1,tile=7x2" -frames:v 1 strip.jpg && for f in skits/*/clip.mp4 voice/a1.mp3; do printf "%s " $f; ffmpeg -hide_banner -nostats -i $f -af ebur128 -f null - 2>&1 | grep -E "^ +I:" | tail -1; done'
mkdir -p ~/Downloads/linkeon_shorts
scp -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231:ci/wt/promo-shorts/studio/out/skit-sample-1/video.mp4 ~/Downloads/linkeon_shorts/skit-sample-1.mp4
scp -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231:ci/wt/promo-shorts/studio/out/skit-sample-1/strip.jpg /tmp/skit-sample-1-strip.jpg
scp -o ConnectTimeout=15 -o ServerAliveInterval=30 -o ServerAliveCountMax=6 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231:ci/wt/promo-shorts/studio/out/skit-sample-1/cover.jpg /tmp/skit-sample-1-cover.jpg
```

Открыть `/tmp/skit-sample-1-strip.jpg` и `/tmp/skit-sample-1-cover.jpg` (Read) и проверить:
- обложка — первый кадр конфликта с надписью-зацепкой, без субтитра реплики;
- герои узнаваемы по листу труппы, их ровно двое, лишних персонажей нет;
- в кадрах Omni нет надписей, экранов телефона и логотипов;
- зацепка видна в первые 3 с, субтитры реплик сценок стоят ниже середины и не наезжают на зацепку;
- морды героев не под зацепкой (верхняя треть кадра) и не под субтитрами;
- в кадре развязки то же место и те же костюмы, что в конфликте;
- вопрос, ответ с рамкой абзаца и финал — как у принятого образца плана 1.

Громкость: `I:` клипов и `voice/a1.mp3` расходятся не больше чем на 2 LU. Если больше — записать замер для задачи 17 (там меняется `CLIP_LUFS`).

Если что-то из списка не так — не показывать владельцу, а сначала разобраться (задача 17, шаг 2, без ворот).

- [ ] **Step 7: Показать владельцу**

Сообщение владельцу: путь `~/Downloads/linkeon_shorts/skit-sample-1.mp4`, длина, сколько ушло на Omni (из вывода шага 4), что распознал SpeechKit в каждой сценке, и прямой вопрос: «Принимаешь образец или что поправить — юмор, героев, голоса, темп, субтитры?».

---

### Task 17: Ворота владельца, донастройка и итоги

**Files:**
- Modify (по замечаниям): `studio/samples/zalog/*.json`, `src/shorts/short-troupe.ts`, `src/shorts/short-skit-prompts.ts`, `studio/src/animate/match.ts`, `studio/src/animate/clip-check.ts`, `studio/src/animate/cues.ts`, `studio/src/ffprobe.ts`
- Modify: `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` (раздел «Что уточнил образец»)

- [ ] **Step 1: Дождаться ответа владельца**

Без ответа владельца план 4 не начинается.

- [ ] **Step 2: Итерация по замечанию**

Каждое замечание — отдельный цикл:
1. Решить, где правка: реплики и действие — `studio/samples/zalog/skits.json`; облик и голос героя — паспорт в `src/shorts/short-troupe.ts`; общая манера, стиль, запреты — константы `SKIT_*` в `src/shorts/short-skit-prompts.ts`; громкость — `CLIP_LUFS`; порог речи — `MATCH_THRESHOLD`; паузы между репликами — `PAUSE_DETECT`; долгая тишина в клипе и ролике — `SKIT_MAX_SILENCE_SEC` (`studio/src/ffprobe.ts`), на краях клипа — `CLIP_LIMITS.maxEdgeSilenceSec`. Новая громкость или пороги пауз переобработают принятые клипы без Omni; поднять `PROCESSING_VERSION` в `run-animate.ts`, если поменялась сама логика обработки.
2. Правка кода — тестом вперёд, как в задачах 2–14; правка JSON образца — без теста.
3. Коммит, затем задача 16 с шага 3 (папка та же: сценки с прежним отпечатком не переснимаются). Если после смены громкости или порогов шаг 4 пишет «принятый клип при новых настройках не проходит проверку» — не повторять: вернуть прежнее значение или решить с владельцем, переснимать ли сценку (удалить её `raw.mp4` и запись в `animation.json`). Если на ролик уже ушло 48 с Omni, шаг 4 запускать как `"MAX_OMNI_SECONDS=96 npm run animate -- out/skit-sample-1"`.
4. Новый файл — `~/Downloads/linkeon_shorts/skit-sample-<N>.mp4`, владельцу — что изменилось.

Траты на образец со всеми итерациями — не больше $10 без отдельного вопроса владельцу (сумма — по `omniSeconds` в `animation.json` × $0,10 плюс кадры).

- [ ] **Step 3: Итоги образца в спеке**

Когда владелец принял образец, дописать в конец спеки `docs/superpowers/specs/2026-10-26-shorts-skits-design.md` раздел:

```markdown
## Что уточнил образец (план 3)

- <дата>: владелец принял образец `skit-sample-<N>.mp4` (<что именно сказал>).
- Пороги: `MATCH_THRESHOLD` = <значение>, `CLIP_LUFS` = <значение>, `PAUSE_DETECT` = <значение>, пауза в клипе — до <N> с.
- Паспорта и шаблоны промптов: <что поменялось и почему>.
- Omni: <сколько попыток ушло, были ли отказы фильтра, как звучали голоса, держится ли облик героев>.
- Время этапа «оживление»: <минут>; траты на образец: <$>.
```

плюс пункты из раздела «Что план уточняет в спеке» этого плана, отложенное по ревью (свекровь или тёща — вопрос владельцу; предел слов зацепки сценок; запас паузы на стыке «ответ → развязка»; README студии — раздел про `npm run animate` и пределы 25–45 с) и мелкие замечания итогового ревью (задача 15, шаг 3).

```bash
git -C "$WT" add docs/superpowers/specs/2026-10-26-shorts-skits-design.md
git -C "$WT" commit -m "docs(spec): ролики со сценками — что уточнил образец

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Переход к плану 4**

Обновить заметку памяти `project_promo_shorts_studio.md` (образец принят, где лежит, итоговые пороги) и строку в `MEMORY.md`. Затем — скилл `superpowers:writing-plans` для плана 4 «Сценки в конвейере» по разделу «Вне этого плана» выше и итогам образца.
