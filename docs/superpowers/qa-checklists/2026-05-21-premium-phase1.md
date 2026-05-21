# Premium Phase 1 — Manual QA Checklist

**Period:** 2-4 weeks after deploy (Phase 1 = Linkeon-only, admin-gated)
**Goal:** ~15-20 premium-роликов про коллег-ассистентов Linkeon. Замеряем failure rate, $-cost и латентность. Субъективно оцениваем wow-эффект.

---

## Per-ролик чеклист

Каждая новая премиум-генерация:

- [ ] Тема ролика
- [ ] Жанр (Surreal / POV / Cinematic)
- [ ] Юля сгенерировала превью (1-2 kling-кадра, текст описаний выглядит осмысленно)
- [ ] Подтвердил «Сгенерировать» (как админ — токены условно списываются, для аналитики)
- [ ] Видео-плеер показал прогресс (без длинных зависаний без апдейтов)
- [ ] Терминальный статус:
  - [ ] `ready` → ролик визуально:
    - [ ] Соответствует описанию сцены (motion_prompt просматривается в результате)
    - [ ] Без артефактов лиц / конечностей / неправильного текста
    - [ ] Wow-эффект ощутим («ломает представление»)
  - [ ] `escape_hatch_offered` → выбрал один из трёх вариантов:
    - [ ] `keep_static` — re-render как классика отработал
    - [ ] `switch_genre` — новый жанр поставился, видео отменено
    - [ ] `refund` — токены возвращены, видео отменено
- [ ] Из `smm_video.render_state.kling_scenes`:
  - сколько `attempts` на каждой сцене
  - финальный `status` каждой сцены (ok / escape_hatch)
- [ ] Из `smm_premium_generation`:
  - `tokens_charged`
  - `tokens_refunded` (если был refund)
  - `internal_cost_cents` (если worker заполнит — TODO)
  - `created_at` → `completed_at` total seconds

---

## Аналитика (после 15+ роликов)

```sql
-- Failure rate per genre
SELECT
  genre,
  count(*) FILTER (WHERE status IN ('in_progress', 'completed')) AS ok,
  count(*) FILTER (WHERE status LIKE '%refund%') AS escaped,
  round(100.0 * count(*) FILTER (WHERE status LIKE '%refund%') / count(*), 1) AS escape_pct
FROM smm_premium_generation
GROUP BY genre
ORDER BY genre;
```

```sql
-- Average $-cost per scene_count
SELECT
  genre, scene_count,
  count(*) AS n,
  avg(internal_cost_cents) / 100.0 AS avg_usd
FROM smm_premium_generation
WHERE internal_cost_cents IS NOT NULL
GROUP BY genre, scene_count
ORDER BY genre, scene_count;
```

```sql
-- p95 latency per genre (from start to completion)
SELECT
  genre,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM completed_at - created_at)) AS p50_sec,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(epoch FROM completed_at - created_at)) AS p95_sec
FROM smm_premium_generation
WHERE completed_at IS NOT NULL
GROUP BY genre;
```

```sql
-- Average attempts per kling scene (из render_state)
SELECT
  s.premium_genre,
  AVG((scene->>'attempts')::int) AS avg_attempts
FROM smm_video v
JOIN smm_scenario s ON s.id = v.scenario_id
CROSS JOIN LATERAL jsonb_array_elements(v.render_state->'kling_scenes') AS scene
WHERE s.premium_genre IS NOT NULL
GROUP BY s.premium_genre;
```

---

## Phase 2 gate criteria

Переходим к open-to-all премиум **только** когда все галочки:

- [ ] **Failure rate < 30%** на каждом из трёх жанров (Surreal, POV, Cinematic)
- [ ] **Средний внутренний $-cost ≤ $2.5** для 2-shot варианта
- [ ] **p95 latency ≤ 480 sec (8 min)**
- [ ] **Субъективная оценка:** 12+ из 20 пробных роликов получили вердикт «реально вау» (Дмитрий)

Если хоть один критерий не сошёлся — продлеваем Phase 1, чиним конкретное узкое место:
- **Высокий failure rate на одном жанре** → выключить жанр временно (флаг в фронте + бэке), переработать промпт-стратегию для него в `smm-producer.prompt.ts`.
- **$-cost выше плана** → проверить QA-threshold в `worker/src/media/vision-qa.ts` (значение `GOOD_THRESHOLD = 0.65`). Если QA слишком строгий — много retries, дорого. Снизить до 0.55 → меньше retries, но больше «средних» роликов. Калибровать.
- **Латентность выше 8 min p95** → возможно прокси для Kling API медленный; рассмотреть переход на fal.ai aggregator или альтернативный прокси.

---

## Phase 2 включение

Когда gate criteria сошлись:

1. Добавить миграцию (014) для введения `feature_flags` таблицы (если ещё нет) и установить `premium_smm_public = true`.
2. Убрать `if (!req.user?.isAdmin)` в:
   - `src/smm/scenarios/scenarios.controller.ts:164` (PATCH endpoint)
   - `src/smm/producer/smm-producer-tools.service.ts:101` (generate_scenarios tool)
   - Заменить на проверку `feature_flags.premium_smm_public`.
3. Убрать `if (!user?.isAdmin) return null;` в `src/components/chat/smm/PremiumGenreTabs.tsx:21`.
4. Деплой.
5. Объявить юзерам в чате через welcome-сообщение Юли.

---

## Логирование Phase 1

Рекомендую держать в Notion / GitHub issue таблицу по форме:

| # | Дата | Жанр | Тема | Сцен | Статус | Attempts (per scene) | $-cost | Time | Wow? |
|---|------|------|------|------|--------|---------------------|--------|------|------|
| 1 | YYYY-MM-DD | surreal | психология сна | 2 | ready | [1, 2] | $0.85 | 4m12s | ✅ |
| 2 | YYYY-MM-DD | pov | налоги | 1 | ready | [1] | $0.60 | 2m38s | ⚠️ |
| 3 | YYYY-MM-DD | cinematic | право собственности | 2 | escape_hatch_offered | [3, 1] | (refunded) | 6m04s | — |

После 15-20 строк → анализируем по агрегированной аналитике выше, принимаем решение Phase 2 gate.
