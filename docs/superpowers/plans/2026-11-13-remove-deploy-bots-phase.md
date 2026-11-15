# Удаление PHASE 5 (боты встреч) из deploy.sh — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Обычный `deploy.sh` больше не трогает машину ботов встреч; ручной `scripts/deploy-bots.sh` сохраняется.

**Architecture:** Чистое удаление оркестрации из `scripts/deploy.sh` (env-доки, блок PHASE 5, накопление/обработка/финальный exit `BOTS_RC`) плюс регрессионный тест `node:test`, читающий текст скриптов и гоняющий `bash -n`. Код ботов, provisioning и машина не меняются.

**Tech Stack:** bash, node:test (как соседний `deploy-retention-secret.test.js`), существующие deploy-тесты (Jest `deploy-restart-gate.test.js`, node:test `deploy-retention-secret.test.js`).

**Спека:** `docs/superpowers/specs/2026-11-13-remove-deploy-bots-phase-design.md` (коммит `7781f8ab`).

---

## Ограничения среды (читать до старта)

- **Ворктри:** `/Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase`, ветка `chore/remove-deploy-bots-phase`, база `f8b0828b`.
- **Тесты — только на ноде** `dv@85.192.61.231`, CI-клон `~/ci/remove-phase5` (уже создан, `npm ci` выполнен, базовые прогоны зелёные). В каждой ssh-команде `source ~/.nvm/nvm.sh`. Клон ставить на конкретный sha, не на имя ветки.
- На маке допустимы только быстрые проверки: `grep`, `bash -n`, чтение файлов.
- **Выкат `deploy.sh` в этом плане НЕ выполняется** — только отдельное явное подтверждение владельца (вне объёма спеки).
- Коммиты в стиле репозитория: `test(deploy): … (красный)` → `fix(deploy): …`. В конце каждого сообщения:
  `Co-Authored-By: Claude Code <noreply@anthropic.com>`

## File Structure

| Файл | Действие | Ответственность |
|---|---|---|
| `tests/scripts/deploy-no-bots-phase.test.js` | Создать | Регрессия: deploy.sh не знает о машине ботов; оба скрипта синтаксически целы |
| `scripts/deploy.sh` | Править (5 удалений) | Оркестрация выката без PHASE 5 |
| `scripts/deploy-bots.sh` | Править (шапка, 2 строки) | Документация ручного скрипта |
| `infra/meeting-bot/README.md` | Править (1 строка таблицы) | Документация обновления машины |

---

### Task 1: Регрессионный тест (RED)

**Files:**
- Create: `tests/scripts/deploy-no-bots-phase.test.js`

- [ ] **Step 1: Написать тест**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const DEPLOY = path.join(ROOT, 'scripts', 'deploy.sh');
const DEPLOY_BOTS = path.join(ROOT, 'scripts', 'deploy-bots.sh');

test('deploy.sh не вызывает deploy-bots.sh', () => {
  assert.ok(!fs.readFileSync(DEPLOY, 'utf8').includes('deploy-bots.sh'));
});

test('в deploy.sh нет BOTS_RC, SKIP_BOTS и маркера PHASE 5', () => {
  const src = fs.readFileSync(DEPLOY, 'utf8');
  assert.ok(!src.includes('BOTS_RC'), 'BOTS_RC');
  assert.ok(!src.includes('SKIP_BOTS'), 'SKIP_BOTS');
  assert.ok(!src.includes('PHASE 5'), 'PHASE 5');
});

test('ручной scripts/deploy-bots.sh остаётся в репозитории', () => {
  assert.ok(fs.existsSync(DEPLOY_BOTS));
});

test('bash -n проходит для deploy.sh и deploy-bots.sh', () => {
  for (const file of [DEPLOY, DEPLOY_BOTS]) {
    const r = spawnSync('bash', ['-n', file], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${file}: ${r.stderr}`);
  }
});
```

- [ ] **Step 2: Закоммитить красный тест**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase add tests/scripts/deploy-no-bots-phase.test.js
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase commit -m "test(deploy): deploy.sh без PHASE 5 — регрессионный тест (красный)

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 3: Запушить ветку и поставить клон ноды на этот sha**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase push -u origin chore/remove-deploy-bots-phase
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/remove-phase5 && git fetch -q origin && git checkout -q $SHA"
```

- [ ] **Step 4: Прогнать тест на ноде — увидеть RED именно на существующей фазе**

```bash
ssh dv@85.192.61.231 'cd ~/ci/remove-phase5 && source ~/.nvm/nvm.sh && node --test tests/scripts/deploy-no-bots-phase.test.js'
```

Expected: **2 fail / 2 pass**. Падают ровно `deploy.sh не вызывает deploy-bots.sh` и `в deploy.sh нет BOTS_RC, SKIP_BOTS и маркера PHASE 5` (текст найден). Проходят `ручной scripts/deploy-bots.sh остаётся…` и `bash -n…`. Если упало что-то другое — стоп, не продолжать.

---

### Task 2: Удалить PHASE 5 из deploy.sh (GREEN)

**Files:**
- Modify: `scripts/deploy.sh` (env-док ~39–47; блок фазы ~3330–3348; комментарий и блок BOTS_RC ~3370–3390; финальный exit ~3402–3407)

Все правки — удаления/сокращения, новая логика не добавляется.

- [ ] **Step 1: Убрать env-док SKIP_BOTS/BOTS_HOST/FORCE_BOTS (строки 39–47)**

Удалить целиком блок (вместе с завершающей строкой `#`-разделителем), чтобы после `#   LANDING_ONLY=1 …` и `#` сразу шёл `#   SKIP_PRODUCTS_HOST=1 …`:

```
#   SKIP_BOTS=1        — пропустить PHASE 5 (машина ботов встреч). Она входит в
#                        выкат ПО УМОЛЧАНИЮ — ровно потому, что раньше не
#                        входила и молча отстала на три недели (19.10.2026).
#   BOTS_HOST=user@ip  — адрес машины ботов, если он не прежний.
#                        Отдельно её можно догнать в любой момент:
#                        bash scripts/deploy-bots.sh
#                        Идёт встреча — фаза откажется перезапускать сервис;
#                        сорвать сознательно: FORCE_BOTS=1.
#
```

- [ ] **Step 2: Удалить вызов фазы (строки 3330–3347 + примыкающий пустой строкой)**

Удалить целиком:

```bash
# PHASE 5: машина ботов встреч.
#
# Стоит сразу за продом, потому что это его же половина: воркер говорит с
# ботом, и разъехавшиеся версии ломают встречи. До 19.10.2026 фазы не было
# вовсе — deploy.sh не знал о машине ни строкой, — и она тихо отстала на три
# недели, работая на коде от 28 сентября. Та же болезнь, из-за которой
# 07.09.2026 машины продуктов сделали обязательной фазой.
#
# Ненулевой код НЕ откатывает прод: он к этому моменту выкачен и зелёный, а
# отстала соседняя машина. Отдельный случай — «идёт встреча»: фаза тогда
# честно отказывается перезапускать сервис, и это не поломка выкатки.
#
# Догнать отдельно:  bash scripts/deploy-bots.sh
if [[ -z "${TEST_ONLY:-}" && -z "${LANDING_ONLY:-}" && -z "${PRODUCTS_HOST_ONLY:-}" && -z "${SKIP_BOTS:-}" ]]; then
  bold "════════════ PHASE 5: BOTS ════════════"
  BOTS_HOST="${BOTS_HOST:-linkeon@46.101.255.44}" \
    bash "$LOCAL_BACK_DIR/scripts/deploy-bots.sh" || BOTS_RC=$?
fi
```

Комментарий про PHASE 4 («PHASE 4 стоит ЗДЕСЬ, между второй и третьей…») не трогать — он остаётся верен.

- [ ] **Step 3: Сократить комментарий перед блоком BOTS_RC и удалить блок отчёта (строки 3370–3390)**

Заменить:

```bash
# Код фазы 4 отдаём в самом конце, а не сразу: лендинг (если его просили) —
# посторонний продукт, и недоехавшая машина продуктов не повод его не катить.
# Боты — тем же порядком и по той же причине: соседняя машина не повод не
# катить остальное. Код 3 у скрипта означает «идёт встреча, не трогали» — это
# не поломка, и выкатку им валить незачем, достаточно внятно сказать.
if [[ -n "${BOTS_RC:-}" ]]; then
  if [[ "$BOTS_RC" == "3" ]]; then
    bold "════════════════════════════════════════════════════════════════════"
    bold "  ⚠ PHASE 5 (BOTS) пропущена — на машине ботов идёт встреча"
    bold "    Остальные фазы выкачены. Догнать, когда освободится:"
    bold "    bash $LOCAL_BACK_DIR/scripts/deploy-bots.sh"
    bold "════════════════════════════════════════════════════════════════════"
    BOTS_RC=""
  else
    red "════════════════════════════════════════════════════════════════════"
    red "  ✗ PHASE 5 (BOTS) не прошла — остальные фазы выкачены"
    red "    Причина — в выводе фазы выше."
    red "    Повторить:  bash $LOCAL_BACK_DIR/scripts/deploy-bots.sh"
    red "════════════════════════════════════════════════════════════════════"
  fi
fi
```

на:

```bash
# Код фазы 4 отдаём в самом конце, а не сразу: лендинг (если его просили) —
# посторонний продукт, и недоехавшая машина продуктов не повод его не катить.
```

- [ ] **Step 4: Удалить финальный exit BOTS_RC (строки 3402–3407)**

Удалить целиком (вместе с предшествующим комментарием и одной пустой строкой), чтобы после `fi` блока PRODUCTS_HOST_RC сразу шёл пустая строка и `green "═══…"`:

```bash
# Код фазы ботов — последним: машины продуктов отвечают раньше, потому что та
# фаза старше и её коды уже разобраны в привычках. Пропуск по идущей встрече
# сюда не доходит: он обнулён выше, это не отказ.
if [[ -n "${BOTS_RC:-}" ]]; then
  exit "$BOTS_RC"
fi
```

- [ ] **Step 5: Быстрая локальная проверка**

```bash
grep -c "BOTS\|PHASE 5\|deploy-bots" /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase/scripts/deploy.sh   # expected: 0
bash -n /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase/scripts/deploy.sh && echo SYNTAX-OK               # expected: SYNTAX-OK
```

- [ ] **Step 6: Закоммитить**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase add scripts/deploy.sh
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase commit -m "fix(deploy): убрать автоматическую PHASE 5 (машина ботов встреч)

Доступа к машине по SSH нет ни с мака, ни с ноды, фаза краснела после
зелёного прода. Ручной путь сохранён: bash scripts/deploy-bots.sh.

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

- [ ] **Step 7: Нода — новый sha, тест GREEN**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase push
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/remove-phase5 && git fetch -q origin && git checkout -q $SHA"
ssh dv@85.192.61.231 'cd ~/ci/remove-phase5 && source ~/.nvm/nvm.sh && node --test tests/scripts/deploy-no-bots-phase.test.js'
```

Expected: **4 pass / 0 fail**.

---

### Task 3: Документация — deploy-bots.sh и README машины ботов

**Files:**
- Modify: `scripts/deploy-bots.sh:4-5`
- Modify: `infra/meeting-bot/README.md:107`

- [ ] **Step 1: Шапка deploy-bots.sh — только ручной запуск**

Заменить:

```
# Запускается сам по себе:  bash scripts/deploy-bots.sh [user@host]
# и фазой из deploy.sh — по умолчанию, отключается SKIP_BOTS=1.
```

на:

```
# Запускается только вручную:  bash scripts/deploy-bots.sh [user@host]
# Фазы в deploy.sh больше нет (убрана 13.11.2026): обычный выкат эту машину
# не трогает, догоняет её человек с действующим SSH-доступом.
```

Остальную шапку (история «почему он вообще понадобился») не трогать — это по-прежнему правда.

- [ ] **Step 2: README машины ботов — строка таблицы**

Заменить:

```
| Обычная выкатка | PHASE 5 в `scripts/deploy.sh` зовёт то же самое **по умолчанию** |
```

на:

```
| Обычная выкатка | Эту машину НЕ трогает: фаза в `scripts/deploy.sh` убрана 13.11.2026, обновление — только вручную (`bash scripts/deploy-bots.sh`) |
```

- [ ] **Step 3: Проверить и закоммитить**

```bash
bash -n /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase/scripts/deploy-bots.sh && echo SYNTAX-OK
grep -n "PHASE 5\|SKIP_BOTS" /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase/scripts/deploy-bots.sh /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase/infra/meeting-bot/README.md   # expected: пусто
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase add scripts/deploy-bots.sh infra/meeting-bot/README.md
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase commit -m "docs(bots): deploy-bots.sh — только ручной запуск, вне deploy.sh

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: Полная проверка на ноде, ревью, завершение ветки

**Files:** новых нет.

- [ ] **Step 1: Запушить и поставить ноду на финальный sha**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase push
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase rev-parse HEAD)
ssh dv@85.192.61.231 "cd ~/ci/remove-phase5 && git fetch -q origin && git checkout -q $SHA"
```

- [ ] **Step 2: Все три deploy-теста на ноде**

```bash
ssh dv@85.192.61.231 'cd ~/ci/remove-phase5 && source ~/.nvm/nvm.sh && node --test tests/scripts/deploy-no-bots-phase.test.js && node --test tests/scripts/deploy-retention-secret.test.js && npx jest tests/scripts/deploy-restart-gate.test.js --runInBand'
```

Expected: 4 pass (новый), 12 pass (retention-secret), 19 pass (restart-gate). Любой красный — стоп, чинить до продолжения.

- [ ] **Step 3: Проверить объём диффа**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/remove-deploy-bots-phase diff f8b0828b..HEAD --stat
```

Expected: только `scripts/deploy.sh`, `scripts/deploy-bots.sh`, `infra/meeting-bot/README.md`, `tests/scripts/deploy-no-bots-phase.test.js` и файлы `docs/superpowers/` (спека + этот план). Никакого кода ботов, provisioning, worker/.

- [ ] **Step 4: Code review (superpowers:code-reviewer)**

BASE_SHA=`f8b0828b`, HEAD_SHA=финальный. Требования: соответствие спеке `2026-11-13-remove-deploy-bots-phase-design.md`; Critical/Important закрыть до слияния.

- [ ] **Step 5: Завершение ветки (superpowers:finishing-a-development-branch)**

После зелёных тестов и чистого ревью — предложить владельцу варианты (слить в `main` локально / PR / оставить). Слияние в `main`: `merge --no-ff` в свежий `origin/main` (сверить merge-base, без force-push). **Выкат `deploy.sh` — только отдельное явное OK владельца, в этот план не входит.**

- [ ] **Step 6: Обновить память и заметки**

- Заметка `project_deploy_sh_pitfalls` / `feedback_deploy_rules`: флаги `SKIP_BOTS=1` больше нет, старые рецепты выкатов с ним — история (флаг просто игнорируется).
- Work-state список `remove-deploy-phase5-2026-11-13` закрыть.
