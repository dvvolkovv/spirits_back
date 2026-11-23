# Zoom OBF Token Payload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Гарантировать, что при создании Zoom-бота с OBF-токеном запрос содержит одновременно `sdk: 'web'` и `obf_token`.

**Architecture:** Меняется только литерал тела запроса в существующем `AttendeeClient.createBot()`: два конкурирующих свойства `zoom_settings` заменяются одним условным свойством, внутри которого независимо собираются веб-адаптер и OBF. Сначала дефект фиксируется падающим unit-тестом; публичные контракты и остальные компоненты не меняются.

**Tech Stack:** TypeScript, NestJS, Jest, Node.js; прогоны и сборка — в CI-клоне на `dv@85.192.61.231`, не в живом checkout.

---

## Структура файлов

- Modify: `src/meeting/attendee.client.spec.ts` — регрессионный тест совместной передачи веб-адаптера и OBF.
- Modify: `src/meeting/attendee.client.ts` — одна сборка `zoom_settings` без перезаписи.
- Reference: `docs/superpowers/specs/2026-11-23-zoom-obf-token-payload-design.md` — утверждённая матрица поведения и границы изменения.

### Task 1: Сохранить OBF рядом с веб-адаптером Zoom

**Files:**
- Modify: `src/meeting/attendee.client.spec.ts:146-159`
- Modify: `src/meeting/attendee.client.ts:285-334`
- Test: `src/meeting/attendee.client.spec.ts`

- [ ] **Step 1: Добавить падающий регрессионный тест**

Вставить сразу после теста `для Zoom обязателен веб-адаптер`:

```ts
    it('для Zoom передаёт веб-адаптер и OBF-токен вместе', async () => {
      const spy = jest.fn().mockResolvedValue(ok({ id: 'bot_1' }));
      global.fetch = spy as any;

      await new AttendeeClient().createBot({
        meetingUrl: 'https://us04web.zoom.us/j/71077562785?pwd=SECRET.1',
        botName: 'Роман', callId: 'c1', wsUrl: 'wss://my.linkeon.io/attendee/8142?callId=c1',
        provider: 'zoom',
        obfToken: 'обф-токен',
      });

      expect(JSON.parse(spy.mock.calls[0][1].body).zoom_settings).toEqual({
        sdk: 'web',
        obf_token: 'обф-токен',
      });
    });
```

- [ ] **Step 2: Запустить регрессионный тест до исправления**

В CI-клоне, содержащем изменение из Step 1, выполнить:

```bash
cd ~/ci/spirits_back
source ~/.nvm/nvm.sh
npx jest src/meeting/attendee.client.spec.ts -t 'для Zoom передаёт веб-адаптер и OBF-токен вместе' --maxWorkers=2
```

Ожидается **FAIL**: ожидается объект с `sdk: 'web'` и `obf_token: 'обф-токен'`, а получен только `{ sdk: 'web' }`. Это доказывает, что тест воспроизводит исходный дефект.

- [ ] **Step 3: Собрать `zoom_settings` один раз**

В `src/meeting/attendee.client.ts` удалить оба прежних условных spread-свойства `zoom_settings` и относящиеся к ним раздельные комментарии. На месте первого свойства оставить единый блок:

```ts
        // Zoom: только веб-адаптер — нативный молча не отдаёт наш звук.
        // OBF независим от выбора адаптера: оба значения живут в ОДНОМ объекте,
        // иначе поздний spread перезапишет ранний и токен потеряется.
        ...(p.provider === 'zoom' || p.obfToken
          ? {
              zoom_settings: {
                ...(p.provider === 'zoom' ? { sdk: 'web' } : {}),
                ...(p.obfToken ? { obf_token: p.obfToken } : {}),
              },
            }
          : {}),
```

Это сохраняет матрицу из спеки: Zoom без OBF получает только `sdk`; Zoom с OBF — оба поля; не Zoom без OBF не получает `zoom_settings`; не Zoom с OBF сохраняет прежний `{ obf_token }`.

- [ ] **Step 4: Повторить регрессионный тест после исправления**

```bash
cd ~/ci/spirits_back
source ~/.nvm/nvm.sh
npx jest src/meeting/attendee.client.spec.ts -t 'для Zoom передаёт веб-адаптер и OBF-токен вместе' --maxWorkers=2
```

Ожидается **PASS**, 1 выбранный тест.

- [ ] **Step 5: Прогнать весь файл клиента**

```bash
cd ~/ci/spirits_back
source ~/.nvm/nvm.sh
npx jest src/meeting/attendee.client.spec.ts --maxWorkers=2
```

Ожидается **PASS** без сбоев; прежние проверки Zoom без OBF и Meet без `zoom_settings` сохранены.

- [ ] **Step 6: Прогнать Zoom/meeting-набор и тесты meeting-bot**

```bash
cd ~/ci/spirits_back
source ~/.nvm/nvm.sh
npx jest src/zoom src/meeting/attendee.client.spec.ts src/meeting/meeting.service.spec.ts src/meeting/meeting-link.spec.ts src/meeting/meeting.controller.spec.ts --maxWorkers=2
npm --prefix infra/meeting-bot test
```

Ожидается для Jest: **6 suites passed, 204 tests passed** (203 прежних плюс новый регрессионный). Для meeting-bot: **61 tests, 61 pass, 0 fail**.

- [ ] **Step 7: Проверить сборку backend**

```bash
cd ~/ci/spirits_back
source ~/.nvm/nvm.sh
npm run build
```

Ожидается exit code 0 без ошибок TypeScript/NestJS.

- [ ] **Step 8: Проверить итоговый diff**

В локальном репозитории:

```bash
git -C /d/Project/linkeon/spirits_back diff --check
git -C /d/Project/linkeon/spirits_back diff -- src/meeting/attendee.client.ts src/meeting/attendee.client.spec.ts
```

Ожидается отсутствие whitespace-ошибок и только два вида изменений: новый регрессионный тест и единая сборка `zoom_settings`. Коммит, push, живая встреча и деплой выполняются только по отдельному запросу владельца.
