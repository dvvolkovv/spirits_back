# Фоновые ходы и сообщение на нуле — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Шаги — чекбоксы.

**Goal:** рутины и «Путь» не обрывают ход человека и не шлют обрывки пушем; кабинет не теряет сообщение, отклонённое на нулевом балансе.

**Spec:** `docs/superpowers/specs/2026-11-03-background-turns-and-no-tokens-draft-design.md` — читать первым.

**Tech Stack:** бэк — NestJS 10, jest/ts-jest, Node 22; фронт — React 18, vitest (домашний стенд `src/test/dom.tsx`, без @testing-library), i18next (7 языков).

---

## Где что делается (обязательно)

- Бэк: воркдерево `~/Downloads/spirits_back/.worktrees/followups`, ветка `feat/followups-1103` от `origin/main` `0089aa58`. Фронт: `~/Downloads/spirits_front/.worktrees/followups`, ветка `feat/followups-1103` от `origin/main` `2b3b36a`. Общие чекауты не трогать.
- Тесты, tsc, сборки — **только на ноде** `dv@85.192.61.231`: бэк — `~/ci/wt/fu-back`, фронт — `~/ci/wt/fu-front` (создать: `git -C ~/ci/spirits_back worktree add --detach ~/ci/wt/fu-back origin/feat/followups-1103`, `npm ci --no-audit --no-fund`; фронт — из `~/ci/spirits_front`, `pnpm install --frozen-lockfile`). В ssh — `source ~/.nvm/nvm.sh`; `ssh -n`, если команда не читает stdin. На ноде не трогать `~/spirits_*`, `~/dev`, `~/ci/spirits_*` (кроме fetch и worktree add/remove), чужие `~/ci/wt/*`.
- Код на ноду — через git: коммит → `git push -q` → на ноде `git fetch -q origin && git checkout -q --detach <sha>`. jest — с `--forceExit`. tsc бэка — `npx tsc -p tsconfig.build.json --noEmit`; фронта — `npx tsc -p tsconfig.app.json --noEmit` (база — число ошибок на `2b3b36a`, не больше).
- TDD: красный тест отдельным коммитом с пушем («— красный»), затем реализация. Без `--amend`, `push --force`, rebase, `git stash`; явный pathspec; комментарии по-русски, «почему». Репозитории публичные: в тестах пользователи `u1`, без номеров. Не мерджить, не выкатывать.
- Сообщения коммитов заканчивать строкой `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.

---

## Бэк

### Task Б1: фоновый ход в сессии человека — не стартует при занятой сессии, учитывается, сбой не уходит обрывком

**Files:** Create `src/chat/relay-session-busy.ts`; Modify `src/chat/chat.service.ts` (`agentReply`, поля учёта рядом с `relayRunning`, тип `ChargedAgentReply`); Test `src/chat/chat.service.background-turns.spec.ts` (харнес — как `src/chat/chat.relay-running.spec.ts`: подмена `axios.post` управляемыми потоками SSE релея, `makeService()`).

- [ ] **Step 1: красные тесты** (`chat.service.background-turns.spec.ts`):
  1. идёт ход человека этой сессии (`svc.beginRelayRun(relaySessionKey('u1','14','ru'))`) → `generateAgentReply('u1','14','привет')` бросает `RelaySessionBusyError`, `axios.post` не вызван;
  2. идёт другой фоновый ход этой сессии (первый `generateAgentReply` с неотвеченным потоком) → второй бросает `RelaySessionBusyError`;
  3. с `sessionIdOverride` (`'action_plan_x'`) при занятой сессии человека — НЕ бросает, идёт в релей (эфемерные сессии не проверяются);
  4. фоновый ход идёт → текстовый ход человека той же сессии (`streamUniversalAgent`) НЕ получает `INTERRUPTED_TURN_NOTE` в реплике (фоновый учёт отдельный от `relayRunning`);
  5. `getActiveStreamCount()` во время любого `agentReply` (фонового и с override) = 1, после — 0, в том числе при ошибке потока;
  6. метка фонового хода снимается на любом исходе (успех, `error` потока, `done.failed`): следующий фоновый ход той же сессии стартует;
  7. `done` с `failed: true` (и `failReason: 'preempted'`) после нескольких `delta` → `generateAgentReply` возвращает `''`, `generateAgentReplyWithCharge` — `failed: true` и `text` (обрывок) не пустой; режим теста версии (`testMode`) — по-прежнему бросает.
- [ ] **Step 2: прогон** — FAIL. Коммит «test(chat): фоновые ходы в сессии человека — красный».
- [ ] **Step 3: реализация.**
  - `src/chat/relay-session-busy.ts`:
    ```ts
    /**
     * Фоновый ход (рутина, «Путь») не стартует, пока в той же сессии релея идёт
     * ход человека или другой фоновый ход: релей пре-эмптит процесс сессии, и
     * рутина оборвала бы длинную работу человека (бэклог e777aa94).
     */
    export class RelaySessionBusyError extends Error {
      readonly code = 'RELAY_SESSION_BUSY';
      constructor() {
        super('relay session busy');
        this.name = 'RelaySessionBusyError';
      }
    }
    ```
  - В `ChatService` рядом с `relayRunning`: `private readonly backgroundRunning = new Map<string, number>();` с комментарием (почему отдельно от `relayRunning`: строка о прерывании — только про ходы человека).
  - В `agentReply` после вычисления `relaySid`: `const sharesHumanSession = sessionIdOverride === undefined;` Если `sharesHumanSession && (this.relayRunning.has(relaySid) || this.backgroundRunning.has(relaySid))` → `this.logger.log(`фоновый ход отложен: сессия занята (assistant ${assistantId})`)` и `throw new RelaySessionBusyError()`. Затем (до `axios.post`): `this.beginStream()`; `const bgMark = sharesHumanSession ? this.openMark(this.backgroundRunning, relaySid) : null;` и весь запрос/разбор потока — в `try { … } finally { this.endStream(); if (bgMark !== null) this.closeMark(this.backgroundRunning, relaySid, bgMark); }`.
  - `ChargedAgentReply` + поле `failed?: boolean`; в возврате `failed: turnFailed`. `generateAgentReply`: `const { text, failed } = await this.agentReply(…); return failed ? '' : text;` (комментарий: обрывок прерванного хода наружу не уходит).
- [ ] **Step 4: прогон** нового спека + `src/chat` целиком (`--forceExit`) + tsc — PASS. Коммит «fix(chat): фоновый ход не обрывает человека, сбой не уходит обрывком».

### Task Б2: рутины — перенос на час при занятой сессии и сбое; «Проверить» честно говорит, что случилось

**Files:** Modify `src/routine-push/routine-push.service.ts`, `src/routine-push/routine-store.service.ts`, `src/routine-push/routine-push.controller.ts`; Test — соседние спеки модуля (`ls src/routine-push/*.spec.ts`; если нет подходящего — `src/routine-push/routine-push.busy.spec.ts`).

- [ ] **Step 1: красные тесты:**
  1. `RoutineStore.releaseToday(id, today, prev)` — SQL `UPDATE routine_pushes SET last_sent_date = $3, updated_at = now() WHERE id = $1 AND last_sent_date = $2` (возвращает отметку, только если она всё ещё сегодняшняя);
  2. `runDue`: `generateAgentReply` бросает `RelaySessionBusyError` → `releaseToday(r.id, today, r.last_sent_date)` вызван, пуш не отправлен, цикл продолжает другие рутины;
  3. `runDue`: генерация вернула пустую строку (сбойный ход) → тоже `releaseToday` (перенос на час), пуш не отправлен;
  4. `runDue`: `looksLikeFailure(text)` — как сейчас (день не возвращаем: это сбой CLI, повтор раз в час слал бы алерты);
  5. `fireNow` на занятой сессии → `{ delivered: 0, busy: true }`; на пустой генерации → `{ delivered: 0, failed: true }`; контроллер `action:'test'` пробрасывает `busy`/`failed` в JSON.
- [ ] **Step 2: прогон** — FAIL; коммит красный.
- [ ] **Step 3: реализация.** В `deliver` различать исходы: вернуть объект `{ delivered: number; busy?: boolean; failed?: boolean }` (или бросать `RelaySessionBusyError` наверх — как удобнее), `runDue` до `claimToday` запоминает `prev = r.last_sent_date`, при `busy`/`failed` — `releaseToday`; лог без текста рутины: `routine "${title}" отложена: занята сессия / сбой генерации (user ${userId}, assistant ${assistantId})`. `fireNow` возвращает признаки, контроллер — `res.json({ ok: true, delivered, busy, failed })`. Сводка в TG «Рутинные пуши разосланы: N» — считать только реально доставленные.
- [ ] **Step 4: прогон** `src/routine-push` + tsc — PASS. Коммит.

### Task Б3: «Путь» — пропуск при занятой сессии

**Files:** Modify `src/trip/trip.service.ts` (`generateFramingAsync`); Test — спек `generateFramingAsync` (`ls src/trip/*.spec.ts`).

- [ ] Тест: `chat.generateAgentReply` бросает `RelaySessionBusyError` → `generateFramingAsync` не бросает, `dayFramingStore.upsert` не вызван, в `logger.warn` НЕ пишется «failed» (это не сбой — `logger.log`/`debug` «отложено: сессия занята»). Пустая строка (сбойный ход) — как сейчас (return без записи). Реализация — отдельная ветка `catch` по `instanceof RelaySessionBusyError`. Коммиты красный/зелёный.

### Task Б4: гейты бэка

- [ ] tsc; `npx jest src/chat src/routine-push src/trip src/voice-call src/monitoring src/agents --forceExit` — 0 failed (падение вне наших файлов — сверить с `origin/main` в том же клоне); `npm run build`; скан публичности `git diff origin/main | grep -nE '7[0-9]{10}|sk-|BEGIN'`.

---

## Фронт

### Task Ф1: сообщение, отклонённое на нуле, возвращается в поле

**Files:** Modify `src/components/chat/ChatInterface.tsx` (`sendMessageToAI` — разбор `end`; `handleFileTaskSubmit` — разбор `end`); Create `src/components/chat/noTokensDraft.ts` (+ `.test.ts`) — чистые функции; Test — сторожевой/поведенческий тест подключения (по образцу `remoteTurnWiring.test.ts` / `filesEventsWiring.test.ts`).

- [ ] **Step 1: красные тесты** для `noTokensDraft.ts`:
  - `isNoTokensEnd(event)` — `event?.type === 'end' && event?.reason === 'no_tokens'`;
  - `restoreIntoInput(current, rejected)` — пустое поле → `rejected`; непустое → `${current}\n\n${rejected}` (как подстановка черновика в ChatInterface ~628); пустой `rejected` → `current`;
  - сторож подключения: в `ChatInterface.tsx` обе точки разбора `end` (текстовый ход и загрузка) вызывают `isNoTokensEnd`; при нём — `savePendingDraft(` и снятие пузыря (фильтр по id сообщения пользователя); при обычном завершении — снятие черновика для этого ассистента (`forgetPendingDraft`/проверка `hasPendingDraftFor`).
- [ ] **Step 2: прогон** — FAIL; коммит красный.
- [ ] **Step 3: реализация** в `ChatInterface.tsx`:
  - текстовый ход: в цикле разбора `if (isNoTokensEnd(data)) noTokens = true;`; при фиксации ответа (`completedMessage`) — если `noTokens`: убрать из `messages` пузырь отправленного сообщения (id нужно передать в `sendMessageToAI` или найти последний `type:'user'` с этим текстом — надёжнее передать id), `setInput(prev => restoreIntoInput(prev, userMessage))`, `savePendingDraft(userMessage, streamAssistantId)`; сообщение остановки от бэка оставить в ленте как ответ. Только если пользователь всё ещё в этом чате (`selectedAssistantIdRef.current === streamAssistantId`); иначе — только `savePendingDraft`;
  - очередь: если ход отправлял склеенную очередь — в `userMessage` уже весь текст, вернуть его;
  - загрузка (`handleFileTaskSubmit`): при `isNoTokensEnd(event)` — вернуть `pendingFiles` = отправленные `files` и текст задачи в поле окна задачи (`fileTaskInput`), окно не открывать автоматически, если оно было закрыто, — решай по коду так, чтобы человек повторил отправку одним действием после пополнения; текст задачи — ещё и в `savePendingDraft`;
  - успешное завершение хода (не `no_tokens`) — если для этого ассистента лежит сохранённый черновик (`hasPendingDraftFor(id)`) и он совпадает с только что отправленным текстом — `forgetPendingDraft()` (иначе черновик вернётся в поле при следующем открытии чата);
  - окно пополнения НЕ открывать.
- [ ] **Step 4: прогон** `src/components/chat` + tsc (≤ базы) — PASS. Коммит.

### Task Ф2: «Проверить» у рутин — тексты «занят» и «не получилось»

**Files:** Modify `src/components/settings/RoutinesManager.tsx` (`test`), `src/i18n/locales/{ru,en,es,de,fr,pt,zh}.json` (`settings.routines.test_busy`, `settings.routines.test_failed`; правка JSON — node-скриптом точечно, `git diff` — по строке на ключ).

- [ ] Тексты (обращение — как у соседних строк `settings.routines.*`; ru — на «ты»):
  - ru: `test_busy` — «Ассистент сейчас занят разговором с тобой — попробуй через минуту.», `test_failed` — «Не получилось подготовить сообщение — попробуй ещё раз чуть позже.»;
  - en/es/de/fr/pt/zh — по смыслу, обращение как у соседних `settings.routines.*` в каждой локали (посмотри `test_no_push`).
- [ ] `test`: `d.busy` → `test_busy`; `d.failed` → `test_failed`; иначе как сейчас. Тест (по образцу соседних тестов настроек, если есть; иначе сторож на ветки). Скрипты локалей (`node scripts/check-locales.mjs`, `check-keys-exist.mjs`) — зелёные.

### Task Ф3: гейты фронта

- [ ] `pnpm test` целиком; tsc ≤ база; `pnpm build`; скан публичности.

---

## После плана (контролёр)
Ревью (соответствие → качество), OK владельца → слияние → `deploy.sh` (свежие клоны на ноде, `npm ci` в `spirits_back/tests`, `SKIP_BOTS=1`; сверить, что чужих выкатов нет) → живая проверка (рутина «Проверить» при идущем ходе — busy; текст на нуле — в поле) → бэклог done → уборка.
