# Premium SMM Mode — Design Spec

**Дата:** 2026-05-21
**Автор:** Дмитрий Волков + Claude (brainstorming session)
**Статус:** Утверждён, передаётся в writing-plans

## Цель

Расширить возможности Юли (SMM-Producer AI) за счёт **премиум-режима** — генерации SMM-роликов с использованием **Kling 2.0 master** для отдельных «оживлённых» кадров на базе **nano-banana (Gemini 2.5 Flash Image)** keyframes. Цель — давать визуально wow-результаты, ломающие представление о стандартных AI-роликах: морфинг, обратная физика, скейл-шифт, POV от лица предметов, кинематик-движение камеры.

Текущий пайплайн Юли (Imagen + Remotion + Yandex TTS) остаётся как «классика». Premium — это **дополнительная ветка**, не замена.

---

## Решения, принятые в брейншторме

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | Триггер премиума | **Per-сценарий** выбор формата на карточке сценария |
| 2 | Структура пайплайна | **Hybrid** — Remotion+Imagen база + 1-2 kling-шотов поверх |
| 3 | Что в меню стилей | **3 фиксированных жанра** (Surreal / POV / Cinematic), визуальный язык под тему уникален |
| 4 | Сколько kling-шотов | **1-2 шота адаптивно**, Юля решает, preview с финальной ценой показывается ДО оплаты |
| 5 | Failure handling | **Юля QA-ит сама** через vision-модель, до 3 retries; при тотальном фейле — **escape hatch** с честным диалогом и refund |
| 6 | Доступ | **Phased rollout** — 2-4 недели Linkeon-only, потом всем |
| 7 | Видео-модель | **Прямой Kling API** (не fal.ai), через прокси для устойчивости с РФ-VPS |

---

## Архитектура (10000-foot view)

```
тема + CTA + жанр выбран (Surreal / POV / Cinematic)
        ↓
Юля генерит сценарий с разметкой kling-кадров (1-2 точки)
        ↓
для каждого kling-кадра:
   1. nano-banana (Gemini 2.5 Flash Image) → стартовый keyframe
   2. kling 2.0 master (прямой API через прокси) → 5-сек motion-клип
   3. vision-QA (Gemini Flash) → если плохо, retry до 3 раз
        ↓
Remotion композирует: kling-клипы как <Video> + Imagen-кадры + TTS + субтитры + CTA + музыка
        ↓
ffmpeg → MinIO → юзер видит готовое
```

**Жанр определяет два аспекта:**
1. **Языковой стиль сценария** — как Юля пишет диалоги (Surreal = метафоры и парадоксы, POV = от первого лица предмета, Cinematic = драматический нарратив).
2. **Промпт-стратегия для kling** — Surreal: «impossible physics, morphing, scale shift»; POV: «first-person handheld from `<object>`»; Cinematic: «epic wide shot, slow camera move, dramatic lighting».

**Модели и API:**
| Роль | Модель | $-cost |
|------|--------|--------|
| Видео-motion | Kling 2.0 master (прямой API) | ~$0.5/5-сек (без агрегаторской маржи) |
| Keyframes | nano-banana (Gemini 2.5 Flash Image) для Surreal/POV; Imagen 4.0 для Cinematic | ~$0.04 |
| QA | Gemini 2.5 Flash (vision-mode) | ~$0.02 |
| Текстогенерация Юли | Claude SDK + MCP (как сейчас) | без изменений |

**Прокси для Kling API:** kuaishou-эндпоинт с РФ-VPS блочат/режут, поэтому через cloudflare-worker или отдельный нерусский VPS. Точная реализация — на этапе implementation.

---

## UX в чате

**Шаг 1: Юля генерит 3 сценария.** Без изменений по сравнению с текущим — каждый сценарий-карточка с title + краткий мудборд.

**Шаг 2: Выбор жанра на карточке** (новое):

```
[ Классика (бесплатно) ]   [ Surreal ]   [ POV ]   [ Cinematic ]
```

Классика выбрана по умолчанию. При клике на premium-вкладку карточка раскрывается:

```
🎬 Surreal
Юля придумывает: «Эксперт превращается в лестницу, по которой
поднимается зритель» + «Дом сжимается в монету и катится в кошелёк»

Будет 2 kling-кадра  •  180 000 токенов  •  рендер 4-6 мин
                                            [ Сгенерировать ]
```

Юля заранее придумала 1-2 конкретные сцены — описание показывает юзеру, что именно будет.

**Шаг 3: Юзер жмёт «Сгенерировать»** → атомарно списываются токены + создаётся запись в `smm_premium_generation` со статусом `in_progress` → видео-плеер появляется в режиме «Юля работает». Прогресс через polling: «генерирую keyframe 1/2», «оживляю кадр», «склеиваю». Время ~4-6 мин (vs ~60 сек у классики).

**Шаг 4: Промежуточные апдейты Юли** при QA-перегонах:

> «Первый вариант кадра «дом сжимается в монету» получился не очень — лестница появлялась криво. Перегенерирую, готово будет через ~2 минуты.»

**Шаг 5: Escape hatch при тотальном фейле** (3 неудачных retries на одной сцене):

> «Не получается оживить этот кадр в Surreal — что-то с физикой ломается каждый раз. Варианты:
> — [ Попробовать другой жанр (Cinematic — реалистичнее) ]
> — [ Оставить статичный кадр, без анимации ]
> — [ Вернуть токены и переделать сценарий ]»

**Что НЕ показываем:**
- Превью kling-кадров до оплаты (kling-генерация = деньги, нельзя сделать бесплатный тизер).
- Технические детали (юзер не знает что такое «keyframe», «nano-banana», «retry» — только описание сцены человеческим языком).

---

## Pipeline integration — как kling встраивается в Remotion

**Структура сценария:** Юля при генерации в premium-режиме помечает 1-2 сцены как `type: 'kling'`, остальные остаются `type: 'imagen'`. Хранится в `smm_scenario.scenes_json`:

```json
{
  "scenes": [
    {
      "type": "kling",
      "duration": 5,
      "keyframe_prompt": "Эксперт в костюме стоит на гигантской монете в золотом тумане, фотореализм",
      "motion_prompt": "Эксперт превращается в вертикальную лестницу; человек поднимается по ней",
      "dialog": [{"speaker": "assistant", "text": "..."}]
    },
    {
      "type": "imagen",
      "duration": 4,
      "image_prompt": "...",
      "dialog": [...]
    }
  ]
}
```

**Worker pipeline (псевдокод):**

```typescript
for (const scene of scenario.scenes) {
  if (scene.type === 'kling') {
    const keyframe = await nanoBanana(scene.keyframe_prompt);              // ~$0.04
    let video = await klingMotion(keyframe, scene.motion_prompt);          // ~$0.5
    for (let attempt = 1; attempt < 4 && !(await visionQA(video, scene.motion_prompt)); attempt++) {
      if (attempt === 3) throw new EscapeHatchError(scene);
      video = await klingMotion(keyframe, scene.motion_prompt, { seed: random() });
    }
    scene.videoUrl = video.url;
  } else {
    scene.imageUrl = await imagenOrPexels(scene.image_prompt);
  }
  scene.audioUrl = await yandexTTS(scene.dialog);
}
await renderRemotion('PremiumChatCase', scenario);
```

**Remotion композиция** — новый компонент `worker/remotion/src/compositions/PremiumChatCase.tsx`, брат текущего `ChatCase.tsx`. В сценах с `type === 'kling'` рендерим `<Video src={klingUrl}>` вместо `<Img>`, субтитры и CTA поверх — как сейчас. Брендинг (logo, slogan, bg) работает идентично, premium ему ортогонален.

**Промпт-стратегия по жанрам** (зашита в `SMM_PRODUCER_SYSTEM_PROMPT`, Юля её знает):

| Жанр | Словарь промпта | Пример (тема «инвестиции») |
|------|-----------------|---------------------------|
| **Surreal** | morphing, scale shift, gravity inversion, object personification | keyframe: «Монеты плавают в чашке кофе как кубики льда» / motion: «Монеты поднимаются и формируют график роста» |
| **POV** | first-person handheld, from-object perspective | keyframe: «Вид от лица купюры в кошельке» / motion: «Купюра вылетает и попадает в офис банка» |
| **Cinematic** | dolly zoom, slow camera, atmospheric haze, dramatic backlight | keyframe: «Силуэт инвестора на крыше небоскрёба на закате» / motion: «Камера отъезжает, город разворачивается» |

**Cost breakdown за premium-ролик:**
- 1 kling-кадр: nano-banana $0.04 + kling 5-сек $0.5 + QA $0.02 ≈ **$0.56**
- 2 kling-кадра: ≈ **$1.1**
- + базовые расходы текущего пайплайна (Imagen, TTS, Remotion compute) ≈ $0.10
- При QA-перегонах добавь +$0.5 за каждый retry, средний на проде ожидаем +$0.4/ролик

Итого внутренний $-cost: **$0.66 - $1.6** на ролик.

---

## Token economy

**Phase 1 (Linkeon-only): токены не списываются.** Юля делает premium-ролики про коллег-ассистентов, расход покрывает Linkeon. Это окно для замера реальной стоимости и failure rate в проде.

**Phase 2 (открыто всем) — pricing model:**

Опираясь на курс ~1 токен ≈ $0.000044 (исходя из 50K = 199₽). Markup для premium выше базового (~2.2x у классики) из-за высокого риска перегонов, R&D-расходов и premium-позиционирования — итоговый markup ~6x от внутреннего $-cost:

| Премиум-вариант | $-cost внутр. (с retry-буфером) | Цена юзеру (токены) | В рублях ≈ |
|-----------------|----------------------------------|---------------------|-----------|
| **1 kling-кадр** (1 шот) | ~$0.66 | **100 000 токенов** | ~400₽ |
| **2 kling-кадра** (2 шота) | ~$1.6 | **180 000 токенов** | ~720₽ |
| Обычный ролик (текущий) | $0.10 | ~5 000 токенов | ~20₽ |

Premium = **18-36× дороже** классики в токенах. Позиционируется как «один Pro-пакет (1M токенов) = 5-10 premium-роликов».

> Цены — стартовые. После Phase 1 пересматриваем на основе реальной стоимости (поле `internal_cost_cents` даст среднее) — если QA-retries сжирают больше буфера, поднимаем; если меньше — можем оставить (выше маржа).

**Когда списываем:**
- На клике **«Сгенерировать»** после превью с финальной ценой — юзер сознательно согласился.
- Атомарная транзакция: «минус N токенов + запись в `smm_premium_generation` со статусом `in_progress`».
- Никаких hidden charges позже (даже если QA-retries сожрали x2 нашего бюджета — это наш риск).

**Refund policy через escape hatch:**

| Сценарий | Возврат |
|----------|---------|
| Все kling-кадры зафейлились → юзер согласился «вернуть токены» | **100% возврат** (запись → `full_refund`) |
| Зафейлился один из двух → юзер согласился «оставить статичный кадр» | **скидка 50%** (запись → `partial_refund`) |
| Зафейлился один из двух → юзер выбрал «попробовать другой жанр» | списываем за новую генерацию (предыдущую списали уже); это второй продакт |
| Юля QA-перегоны прошли успешно (даже с 2-3 retry внутри) | списали как обычно, без сюрпризов (запись → `completed`) |

**Защита от абьюза:** в Phase 2 — **не более 5 premium-роликов в час** с одного аккаунта (защита от token-burn-атак при компрометации). Проверяется индексом по `smm_premium_generation(user_id, created_at)`.

**Polling баланса:** `AuthContext` опрашивает токены каждые 5 сек. Атомарное списание на старте + атомарный возврат при escape hatch гарантируют, что баланс не «прыгает» — юзер видит мгновенное минус, потом возможный плюс при refund.

---

## Data model

**Расширение существующих таблиц:**

```sql
-- smm_scenario: запоминаем выбранный жанр
ALTER TABLE smm_scenario
  ADD COLUMN IF NOT EXISTS premium_genre text NULL,         -- 'surreal' | 'pov' | 'cinematic' | NULL
  ADD COLUMN IF NOT EXISTS kling_scene_count int NOT NULL DEFAULT 0;

-- Constraint: Postgres не поддерживает IF NOT EXISTS на ADD CONSTRAINT,
-- поэтому drop-then-add для идемпотентности.
ALTER TABLE smm_scenario DROP CONSTRAINT IF EXISTS premium_genre_check;
ALTER TABLE smm_scenario ADD CONSTRAINT premium_genre_check
  CHECK (premium_genre IS NULL OR premium_genre IN ('surreal', 'pov', 'cinematic'));
```

**Per-scene разметка** живёт в существующем `smm_scenario.scenes_json` — массив сцен с полями `type: 'kling' | 'imagen'`, `keyframe_prompt`, `motion_prompt`. Новых таблиц не плодим.

**Worker-side состояние** расширяет `smm_video.render_state` (jsonb):

```json
{
  "previous_versions": [...],
  "kling_scenes": [
    { "scene_idx": 0, "keyframe_url": "...", "kling_url": "...", "attempts": 2, "status": "ok" },
    { "scene_idx": 3, "keyframe_url": "...", "attempts": 3, "status": "escape_hatch" }
  ]
}
```

**Новая таблица `smm_premium_generation`** — аудит для refund/billing/rate-limit:

```sql
CREATE TABLE IF NOT EXISTS smm_premium_generation (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id              uuid REFERENCES smm_video(id) ON DELETE CASCADE,
  user_id               text NOT NULL,
  genre                 text NOT NULL,
  scene_count           int NOT NULL,
  tokens_charged        int NOT NULL,
  tokens_refunded       int NOT NULL DEFAULT 0,
  status                text NOT NULL,         -- 'in_progress' | 'completed' | 'partial_refund' | 'full_refund'
  internal_cost_cents   int,                   -- для аналитики
  created_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz
);
CREATE INDEX IF NOT EXISTS idx_premium_gen_user_created
  ON smm_premium_generation(user_id, created_at DESC);
```

**Миграция:** `011_premium_mode.sql` — idempotent (используем `IF NOT EXISTS`). Backfill не нужен: старые сценарии получают `premium_genre = NULL`, что трактуется как «классика».

---

## Rollout + testing

### Phase 1 (Linkeon-only, 2-4 недели)

Premium включаем только когда `req.user.isAdmin === true` (фронт скрывает premium-вкладки для не-админов, бэк отбивает 403 на попытку отправить `premium_genre`). Юля делает premium-ролики только про коллег-ассистентов Linkeon.

**Цели Phase 1:**
1. Замерить реальный failure rate kling по каждому жанру (ожидаем 20-30%; считаем по полю `attempts` в `render_state.kling_scenes`).
2. Замерить реальный $-cost после QA-retries (поле `internal_cost_cents` → среднее по жанру).
3. Замерить латентность от старта до финала в проде (включая kling-очередь, иногда лагает в часы пик).
4. Накопить ~15-20 premium-роликов, оценить субъективно: действительно ли «ломает представление» или техно-фокус без вау-эффекта.

### Phase 2 gate (открываем всем когда)

- Failure rate < 30% по каждому жанру (если Surreal фейлит чаще — выключаем его временно или меняем промпт-стратегию).
- Средний $-cost ≤ $2.5 на 2-шот вариант (если выше — поднимаем токен-цену перед открытием).
- p95 латентность ≤ 8 минут (чтобы юзеры не уходили с зависшего прогресса).
- Subjective check от Дмитрия: «выглядит реально вау» на 12+ из 20 пробных роликов.

Если хоть один критерий не сошёлся — продлеваем Phase 1, чиним конкретное узкое место.

**Phase 2 включение:** одной строкой в `feature_flags` таблице (`premium_smm_public = true`); фронт начинает показывать premium-вкладки всем, бэк убирает `isAdmin` чек.

### Testing strategy

| Уровень | Что проверяем | Где |
|---------|---------------|-----|
| **Unit** | normalizeSpeaker, prompt-builder под жанры, парсинг scenes_json с kling-сценами, refund-калькулятор | `spirits_back/tests/unit/smm/` |
| **Integration** | Kling-клиент с mocked HTTP (200/timeout/non-200), nano-banana ретраи, vision-QA scoring | `tests/integration/smm/kling-pipeline.test.ts` |
| **API** | POST /scenarios с premium_genre, GET/PATCH /scenarios ownership на premium-полях, refund-запись в premium_generation при escape hatch | добавить кейсы в `tests/smoke/api/` |
| **E2E** | Полный путь: Юля → выбор жанра → preview → списание токенов → polling → готовый ролик → `kling_scenes.status === 'ok'`. Kling-эндпоинт мокаем локально. | новый `tests/e2e/premium-smm-flow.test.ts` |
| **Manual (Phase 1)** | Дмитрий делает premium-ролики, оценивает визуал и QA-вердикты Юли | tracker в Notion/issue, заполняется по ходу Phase 1 |

**Что НЕ покрываем автотестами:**
- Реальные kling-генерации в CI (дорого, медленно, недетерминированно). Только Phase 1 production usage.
- Vision-QA точность — калибруется на Phase 1 данных.

---

## Открытые вопросы (определяются на implementation)

1. **Прокси для Kling API** — конкретная реализация (cloudflare-worker / отдельный VPS / sshuttle). Определяется при сравнении надёжности и стоимости.
2. **Vision-QA scoring threshold** — какой порог «приемлемости» возвращает Gemini Flash как «good». Калибруется на первых 20 роликах Phase 1.
3. **Промпт-инжиниринг для жанров** — конкретные формулировки motion/keyframe-промптов внутри `SMM_PRODUCER_SYSTEM_PROMPT`. Может потребовать 2-3 итераций по результатам Phase 1.

---

## Связанные файлы

**Backend (spirits_back):**
- `src/smm/producer/scenario.service.ts` — генерация сценария с premium_genre
- `src/smm/producer/smm-producer.prompt.ts` — расширение системного промпта Юли (промпт-словари по жанрам)
- `src/smm/scenarios/scenarios.controller.ts` — приём premium_genre в POST/PATCH с валидацией
- `src/smm/entities/smm-scenario.entity.ts` — новые поля premium_genre, kling_scene_count
- `src/smm/billing/premium-generation.service.ts` (новый) — атомарное списание/refund
- `src/smm/migrations/011_premium_mode.sql` (новый)

**Worker (spirits_back/worker):**
- `src/media/kling.ts` (новый) — прямой Kling API клиент через прокси
- `src/media/nano-banana.ts` (extend) — keyframe-генерация для kling-сцен
- `src/media/vision-qa.ts` (новый) — Gemini Flash QA-loop
- `src/pipeline.ts` — branch на type === 'kling', escape hatch
- `remotion/src/compositions/PremiumChatCase.tsx` (новый) — рендер kling-клипов как `<Video>`

**Frontend (spirits_front):**
- `src/components/chat/smm/ScenarioCard.tsx` — добавить вкладки жанров + preview-блок
- `src/components/chat/smm/PremiumGenreTabs.tsx` (новый) — компонент-таб с жанрами
- `src/components/chat/smm/PremiumPreviewBlock.tsx` (новый) — описание сцен + цена + кнопка
- `src/components/chat/smm/smm-api.ts` — типы PremiumGenre, CreatorSettings.premiumGenre
- `src/components/chat/smm/SmmVideoPlayer.tsx` — escape hatch UI при partial/full_refund

---

**Готов к передаче в `superpowers:writing-plans` для построения детального плана задач.**
