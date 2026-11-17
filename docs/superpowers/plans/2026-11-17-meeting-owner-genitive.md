# Родительный падеж владельца в подписи ассистента Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Во всех новых внешних встречах показывать «Роман · ассистент Владимира» вместо «Роман · ассистент Владимир» и использовать ту же строку для распознавания собственного бота.

**Architecture:** Существующий `assistantSignature()` остаётся единственным источником видимой подписи. `MeetingService.attachBot()` начинает использовать его для Attendee, а voice-host использует уже полученный `displayName` как `selfName` для `Presence` и `Roster`; новых зависимостей, полей метаданных и модулей склонения нет.

**Tech Stack:** NestJS 10, TypeScript, Jest 29, LiveKit Agents 1.7.0, Node.js test runner через `tsx`, официальный `scripts/deploy.sh`.

---

## Карта изменений

- `src/meeting/meeting.service.spec.ts` — регрессионные проверки имени, которое реально уходит в `AttendeeClient.createBot()`.
- `src/meeting/meeting.service.ts` — использование существующего `assistantSignature()` при создании Attendee-бота.
- `voice-host/src/agent.ts` — единое значение `displayName`/`selfName`, чтобы фильтрация собственного бота соответствовала подписи Attendee.
- `src/meeting/assistant-signature.ts` и его тесты не меняются: нужные правила и примеры `Владимир → Владимира`, `Дмитрий → Дмитрия` там уже есть.
- Frontend, PostgreSQL, голосовой prompt и формат метаданных не меняются.

## Правила выполнения

- Рабочая ветка: `fix/meeting-owner-genitive`.
- Не использовать amend или force-push; каждое исправление — новый коммит.
- Локально не запускать Jest, TypeScript или build. Все прогоны — только в `~/ci/spirits_back` на `dv@85.192.61.231`, после checkout конкретного SHA.
- Backend и voice-host используют `npm ci`; Jest запускается с `--maxWorkers=2`.
- После каждого коммита проверять `git diff --check`; после каждого CI checkout прогонять именно выбранный SHA, а не живой checkout.
- Завершение ветки и выбор merge/PR выполняются через `superpowers:finishing-a-development-branch`. Деплой разрешён только после интеграции и зелёной проверки итогового SHA.

### Task 1: Регрессионный тест и исправление Attendee-подписи

**Files:**
- Modify: `src/meeting/meeting.service.spec.ts:767-785`
- Modify: `src/meeting/meeting.service.ts:427-435`
- Test: `src/meeting/assistant-signature.spec.ts`
- Test: `src/meeting/meeting.service.spec.ts`

- [ ] **Step 1: Изменить существующее ожидание с именительного на родительный падеж**

В тесте `успех: создаёт бота и запоминает его id` заменить комментарий и ожидаемое имя:

```ts
      expect(attendee.createBot).toHaveBeenCalledWith({
        meetingUrl: 'https://meet.google.com/abc-defg-hij',
        // Подпись собирается центральным assistantSignature(), как и в join().
        botName: 'Андрей · ассистент Дмитрия',
        callId: 'c1',
        wsUrl,
        provider: 'meet',
      });
```

- [ ] **Step 2: Добавить отдельный регрессионный пример из запроса владельца**

Сразу после теста `успех: создаёт бота и запоминает его id` добавить:

```ts
    it('Владимир передаётся Attendee в родительном падеже', async () => {
      withAgent('Владимир');
      calls.load.mockResolvedValue({
        id: 'c1', agent_id: 7, user_id: 'u1', external_room: 'abc-defg-hij',
      });

      await svc.attachBot('c1', wsUrl);

      expect(attendee.createBot).toHaveBeenCalledWith(
        expect.objectContaining({ botName: 'Андрей · ассистент Владимира' }),
      );
    });
```

- [ ] **Step 3: Проверить diff и закоммитить только красные тесты**

```bash
git -C /d/Project/linkeon/spirits_back diff --check
git -C /d/Project/linkeon/spirits_back add src/meeting/meeting.service.spec.ts
git -C /d/Project/linkeon/spirits_back commit -m "test(meeting): родительный падеж владельца Attendee" -m "Co-Authored-By: Kimi Code <noreply@moonshot.cn>"
```

Expected: создан новый коммит; production code в этом коммите не меняется.

- [ ] **Step 4: Доказать красный результат на CI до исправления**

```bash
RED_SHA=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD)
git -C /d/Project/linkeon/spirits_back push -u origin fix/meeting-owner-genitive
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $RED_SHA && source ~/.nvm/nvm.sh && npm ci && npx jest src/meeting/assistant-signature.spec.ts src/meeting/meeting.service.spec.ts --maxWorkers=2"
```

Expected: `assistant-signature.spec.ts` PASS; `meeting.service.spec.ts` FAIL ровно в двух проверках:

- существующий success-тест получает `Андрей · ассистент Дмитрий` вместо ожидаемого `Дмитрия`;
- новый тест получает `Андрей · ассистент Владимир` вместо ожидаемого `Владимира`.

Если падают другие тесты, остановиться и разобрать причину, не маскируя её изменением ожиданий.

- [ ] **Step 5: Использовать существующий assistantSignature в attachBot**

В `src/meeting/meeting.service.ts` оставить существующий импорт:

```ts
import { assistantSignature } from './assistant-signature';
```

Заменить ручную сборку `botName` на:

```ts
      const botName = assistantSignature(
        agentRes.rows[0]?.display_name || 'Ассистент',
        ownerName,
      );
```

Не менять загрузку владельца, вызов `attendee.createBot()`, обработку ошибок или запись `external_bot_id`.

- [ ] **Step 6: Проверить и закоммитить минимальное исправление**

```bash
git -C /d/Project/linkeon/spirits_back diff --check
git -C /d/Project/linkeon/spirits_back add src/meeting/meeting.service.ts
git -C /d/Project/linkeon/spirits_back commit -m "fix(meeting): склонять владельца в имени Attendee" -m "Co-Authored-By: Kimi Code <noreply@moonshot.cn>"
```

Expected: в diff production-кода только замена вычисления `botName`; `ownerName` остаётся в именительном падеже для остальных потребителей.

- [ ] **Step 7: Подтвердить зелёный результат на SHA исправления**

```bash
GREEN_SHA=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD)
git -C /d/Project/linkeon/spirits_back push origin fix/meeting-owner-genitive
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $GREEN_SHA && source ~/.nvm/nvm.sh && npm ci && npx jest src/meeting/assistant-signature.spec.ts src/meeting/meeting.service.spec.ts --maxWorkers=2"
```

Expected: обе suites PASS, failed tests = 0. Проверить по выводу, что новый тест `Владимир передаётся Attendee в родительном падеже` действительно выполнен.

### Task 2: Единое имя бота в voice-host и итоговая проверка

**Files:**
- Modify: `voice-host/src/agent.ts:190-205`
- Test: `voice-host/src/presence.test.ts`
- Test: `voice-host/src/roster.test.ts`
- Test: все существующие suites из `voice-host/package.json`

- [ ] **Step 1: Убрать вторую, расходящуюся сборку selfName**

В `voice-host/src/agent.ts` заменить:

```ts
    const selfName = `${agentName} · ассистент ${meta.ownerName || 'пользователя'}`;
```

на:

```ts
    // Presence и Roster должны исключать бота ровно по той подписи, которую
    // получил Attendee и которую воркер использует для displayName.
    const selfName = displayName;
```

Не добавлять второй экземпляр правил склонения и не менять fallback `displayName` для старых заданий.

- [ ] **Step 2: Проверить wiring по diff до коммита**

```bash
git -C /d/Project/linkeon/spirits_back diff --check
git -C /d/Project/linkeon/spirits_back diff -- voice-host/src/agent.ts
```

Expected: `selfName` ссылается непосредственно на `displayName`; `new Presence(selfName)` и `new Roster(...selfName...)` не изменены; других изменений поведения нет. Это проверка однострочного wiring, а не утверждение, что build сам по себе доказывает правильное имя.

- [ ] **Step 3: Закоммитить унификацию имени**

```bash
git -C /d/Project/linkeon/spirits_back add voice-host/src/agent.ts
git -C /d/Project/linkeon/spirits_back commit -m "fix(voice-host): использовать displayName для selfName" -m "Co-Authored-By: Kimi Code <noreply@moonshot.cn>"
```

- [ ] **Step 4: Прогнать финальные backend и voice-host проверки на точном SHA**

```bash
FINAL_SHA=$(git -C /d/Project/linkeon/spirits_back rev-parse HEAD)
git -C /d/Project/linkeon/spirits_back push origin fix/meeting-owner-genitive
ssh dv@85.192.61.231 "cd ~/ci/spirits_back && git fetch -q origin && git checkout -q $FINAL_SHA && source ~/.nvm/nvm.sh && npm ci && npx jest src/meeting/assistant-signature.spec.ts src/meeting/meeting.service.spec.ts --maxWorkers=2 && npm run build"
ssh dv@85.192.61.231 "cd ~/ci/spirits_back/voice-host && source ~/.nvm/nvm.sh && npm ci && npm test && npm run build"
```

Expected:

- обе целевые backend suites PASS, failed tests = 0;
- backend build завершился с кодом 0;
- все suites из `voice-host/package.json`, включая `presence.test.ts` и `roster.test.ts`, PASS;
- voice-host build завершился с кодом 0;
- в выводе нет skipped вместо выполненных целевых suites.

При падении не запускать повторные случайные исправления: зафиксировать ошибку и использовать systematic debugging.

- [ ] **Step 5: Проверить состояние ветки перед независимым review**

```bash
git -C /d/Project/linkeon/spirits_back status --short --branch
git -C /d/Project/linkeon/spirits_back log -5 --oneline
```

Expected: рабочее дерево чистое; HEAD содержит оба исправления и красный/зелёный TDD-след; ветка отправлена в origin. Передать этот SHA и фактический вывод проверок на spec compliance и code quality review.

## Интеграция и деплой после review

После двух одобренных reviews использовать `superpowers:finishing-a-development-branch` и предложить владельцу варианты merge/PR/keep/discard. Не удалять ветку без подтверждения и не делать force-push.

Если владелец выберет локальный merge в `main`, после merge повторить целевые проверки на итоговом merge SHA. Деплой выполняется только штатной командой:

```bash
bash ~/Downloads/spirits_back/scripts/deploy.sh
```

Ручной `git pull`/`pm2 restart` на серверах, правка серверных файлов и отдельный prod deploy запрещены. После pipeline проверить test/prod smoke; если PHASE 4 products hosts снова недоступны по SSH, сообщить это отдельно и не откатывать здоровый prod только по этой причине.

Для функциональной проверки на test создать новую Attendee-встречу тестового аккаунта и убедиться, что видимое имя — «Роман · ассистент Владимира» (или другое имя тестового владельца в родительном падеже). Уже начатые встречи ретроактивно не переименовываются.
