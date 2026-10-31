# «Отклонить» у идей роликов — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** в админке «Блог» → «Ролики» любую идею (тему каталога, новость из git, заказ владельца) можно отклонить кнопкой в её строке — она уходит в «Отклонены» и не попадает в автозапуск.

**Architecture:** бэк — ветка `idea` в существующем действии `reject` контроллера (`idea → rejected` с условием на статус в записи, версия необязательна); фронт — `actionsFor('idea')` даёт `start_now` и `reject`, обе кнопки в строке идеи, решение подписывается строкой списка. Спека: `docs/superpowers/specs/2026-10-31-shorts-reject-idea-design.md`.

**Tech Stack:** NestJS 10 + Postgres (jest, ts-jest `isolatedModules`, `strictNullChecks: false`); React 18 + TS 5 strict (vitest + jsdom).

---

## Общие правила

- **Деревья:** бэк — `~/Downloads/spirits_back/.worktrees/reject-idea`, фронт — `~/Downloads/spirits_front/.worktrees/reject-idea`; ветка `feat/shorts-reject-idea` в обоих. Перед коммитом — `git branch --show-current`.
- **Тесты бэка — только на ноде.** Из корня дерева бэка: `NODE_RUN_DIR=. studio/scripts/node-run.sh "<команда>"` (Bash timeout 600000). Скрипт пушит ветку и ставит `~/ci/wt/promo-shorts` на точный коммит; незакоммиченное на ноду не уезжает — **коммитить перед каждым прогоном** (красный тест — с «(красный)» в теме). Коды выхода: 75 — занято, повторить через 2 минуты; 255 — сбой ssh, повторить через 1–2 минуты; 3 — дерево не встало, сообщить.
- **Тесты фронта по одному файлу — на маке**, под Node 22: `PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run <файлы>`. Полный прогон, tsc и сборка — на ноде.
- **tsc своих файлов фронта** — после коммита:
  ```bash
  SHA=$(git rev-parse HEAD) && git push -q origin HEAD:refs/heads/feat/shorts-reject-idea && ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 "set -e; cd ~/ci/wt/reject-idea-front; git fetch -q origin refs/heads/feat/shorts-reject-idea; git checkout -q --detach ${SHA}; source ~/.nvm/nvm.sh >/dev/null; npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E 'components/admin/(short|Short|AdminShorts|AdminBlogView)' || echo OWN_TSC_CLEAN"
  ```
  Ждём `OWN_TSC_CLEAN` (в чужих файлах ~42 известные ошибки). Рабочее дерево ноды `~/ci/wt/reject-idea-front` (от `~/ci/spirits_front`, с установленными зависимостями) готовит контролёр до задачи 4.
- `git add` — только поимённо; в `main` не пушить, не сливать, не выкатывать. Репозитории публичные — в тестах только выдуманные значения.

---

## Часть A. Бэк (`~/Downloads/spirits_back/.worktrees/reject-idea`)

### Task 1: `reject` принимает идею

**Files:**
- Modify: `src/shorts/shorts.controller.ts` (метод `reject`, новый метод `rejectIdea` сразу после него)
- Test: `src/shorts/shorts.controller.spec.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/shorts/shorts.controller.spec.ts`, в первом `describe('POST admin/shorts', …)`, сразу после теста `it('reject — ролик уже вышел на площадке — 409; в работе — 409; ждущий решения без версии — 400', …)`:

```ts
  it('reject идеи — idea → rejected: условие на статус в записи; версия строки, если пришла, — тоже', async () => {
    const idea = video({ status: 'idea', failed_from: null });
    const answer = (sql: string) =>
      sql.includes('RETURNING') ? { rows: [video({ status: 'rejected', failed_from: null })] } : { rows: [idea] };

    const plain = setup(answer);
    const r = res();
    await plain.ctl.action({ action: 'reject', id: ID }, r);
    const upd = plain.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'rejected'")) as any[];
    const sql = String(upd[0]).replace(/\s+/g, ' ');
    expect(sql).toContain("WHERE id = $1 AND status = 'idea'");
    expect(sql).not.toContain('short_publication');
    expect(upd[1]).toEqual([ID]);
    expect(r.body.status).toBe('rejected');

    const withVersion = setup(answer);
    await withVersion.ctl.action({ action: 'reject', id: ID, version: VERSION }, res());
    const upd2 = withVersion.pg.query.mock.calls.find((c: any[]) => String(c[0]).includes("SET status = 'rejected'")) as any[];
    expect(String(upd2[0])).toContain('AND updated_at = $2::timestamptz');
    expect(upd2[1]).toEqual([ID, VERSION]);
  });

  it('reject идеи — не записалось: в работе, уже отклонена, версия разошлась, ролика нет; кривая версия — 400', async () => {
    const race = (row: Record<string, any> | null) =>
      setup((sql) => {
        if (sql.includes('RETURNING')) return { rows: [] };
        if (sql.includes('AS released')) return { rows: row ? [row] : [] };
        return { rows: [video({ status: 'idea', failed_from: null })] };
      });
    await expect(race({ status: 'directing', released: false }).ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(
      'Идея уже в работе — отклонить можно будет готовый ролик. Обновите список.',
    );
    await expect(race({ status: 'rejected', released: false }).ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(
      'Идея уже отклонена. Обновите список.',
    );
    const stale: any = await race({ status: 'idea', released: false })
      .ctl.action({ action: 'reject', id: ID, version: VERSION }, res())
      .catch((e: any) => e);
    expect(stale).toBeInstanceOf(ConflictException);
    expect(stale.getResponse()).toMatchObject({ error: 'version_conflict' });
    await expect(race({ status: 'idea', released: false }).ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(
      'Идея успела измениться — обновите список.',
    );
    await expect(race(null).ctl.action({ action: 'reject', id: ID }, res())).rejects.toBeInstanceOf(NotFoundException);

    const bad = race(null);
    await expect(bad.ctl.action({ action: 'reject', id: ID, version: 'не версия' }, res())).rejects.toBeInstanceOf(BadRequestException);
    expect(bad.pg.query.mock.calls.some((c: any[]) => String(c[0]).startsWith('UPDATE'))).toBe(false);
  });
```

И в тесте `it('reject в работе — отказ словами, без внутренних имён статусов', …)` (второй `describe`) заменить ожидаемый текст:

```ts
    await expect(ctl.action({ action: 'reject', id: ID }, res())).rejects.toThrow(
      'Отклонить можно идею, упавший, ждущий решения или запланированный ролик; этот — у сценариста. Обновите список.',
    );
```

- [ ] **Step 2: Закоммитить красным и убедиться, что падает**

```bash
git add src/shorts/shorts.controller.spec.ts
git commit -m "test(shorts): «Отклонить» у идеи — idea → rejected и отказы (красный)"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts 2>&1 | tail -20"
```

Expected: FAIL трёх тестов — двух новых (у идеи сейчас 409 «Отклонить можно упавший…») и теста с текстом отказа.

- [ ] **Step 3: Реализовать**

В `src/shorts/shorts.controller.ts`, метод `reject`: после строки `if (LEAVE_FROM.includes(v.status)) return this.leave(id, 'rejected', rawVersion);` вставить

```ts
    if (v.status === 'idea') return this.rejectIdea(id, rawVersion);
```

и в том же методе текст отказа «не тот статус» заменить на

```ts
        `Отклонить можно идею, упавший, ждущий решения или запланированный ролик; этот — ${STATUS_WORDS[v.status] ?? v.status}. Обновите список.`,
```

В описание метода `reject` (JSDoc над ним) дописать строку: `Идея — своей записью (rejectIdea).`

Сразу после метода `reject` добавить:

```ts
  /**
   * «Отклонить» идеи — темы каталога, новости из git или заказа владельца:
   * idea → rejected, в архив «Отклонены». Идея действует из строки списка, так
   * что версия необязательна: от гонки защищает условие на статус в самой
   * записи. Автозапуск (`ShortsTopicService.start`) пишет с тем же условием
   * `status = 'idea'` — из двух одновременных решений пройдёт одно. Пришедшая
   * версия проверяется, как везде.
   *
   * Вместо отклонённой темы каталога пополнение недели (`refillWeek`) заведёт
   * другую: оно доводит число открытых идей каталога до числа слотов. Повтор
   * ручного заказа ищется только среди открытых идей — отклонённый заказ можно
   * заказать заново.
   */
  private async rejectIdea(id: string, rawVersion: unknown): Promise<ShortVideo> {
    const version = this.version(rawVersion, false);
    const params: any[] = [id];
    const clause = versionClause(params, version);
    const r = await this.pg.query(
      `UPDATE short_video SET status = 'rejected', updated_at = now()
        WHERE id = $1 AND status = 'idea'${clause}
        RETURNING *`,
      params,
    );
    if (r.rows.length) return rowToShort(r.rows[0]);
    // Не записалось — гонка между чтением и записью: причина чтением, как у решений по готовому ролику.
    const why = await explainRefusal(this.pg, id, ['idea']);
    if (why.reason === 'not_found') throw new NotFoundException('ролик не найден');
    if (why.reason === 'stale') {
      if (version) throw new ConflictException({ statusCode: 409, error: 'version_conflict', message: STALE_SHORT });
      throw new ConflictException('Идея успела измениться — обновите список.');
    }
    if (why.status === 'rejected') throw new ConflictException('Идея уже отклонена. Обновите список.');
    throw new ConflictException('Идея уже в работе — отклонить можно будет готовый ролик. Обновите список.');
  }
```

(`versionClause`, `explainRefusal`, `rowToShort`, `STALE_SHORT`, `NotFoundException` контроллер уже импортирует — их использует ветка упавшего ролика.)

- [ ] **Step 4: Закоммитить и убедиться, что проходит**

```bash
git add src/shorts/shorts.controller.ts
git commit -m "shorts: «Отклонить» у идеи — idea → rejected с условием на статус, отказы словами"
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts/shorts.controller.spec.ts src/shorts/short-review.spec.ts 2>&1 | tail -15"
```

Expected: PASS.

### Task 2: живые тесты — автозапуск, пополнение недели, повтор заказа

**Files:**
- Test: `src/shorts/shorts.integration.spec.ts`

- [ ] **Step 1: Написать тесты**

В `src/shorts/shorts.integration.spec.ts`, внутри `maybe('ролики против живого Postgres', …)`, перед `describe('YouTube против живой базы', …)`:

```ts
  describe('«Отклонить» у идеи на живом SQL', () => {
    const settings = {
      get: async () => ({ slotDays: [2, 4, 6], slotHourMsk: 18, prepareLeadHours: 24, format: 'skit' }),
    };
    const agents = {
      getAgents: async () => [
        { id: 1, name: 'Миша', description: 'Коуч — цели, привычки и источники мотивации' },
        { id: 10, name: 'Алексей', description: 'Юрист — договоры, споры и работа с судами' },
        { id: 22, name: 'Кира', description: 'Дизайнер — логотипы, фирменный стиль и макеты' },
        { id: 4, name: 'Ирина', description: 'Карьера — резюме, собеседования и переговоры' },
      ],
    };
    const reply = () => {
      const r: any = { status: () => r, json: (b: any) => ((r.body = b), r) };
      return r;
    };

    it('отклонённую идею не берёт ни автозапуск, ни «Запустить сейчас» по её id', async () => {
      const idea = await insert({ status: 'idea', topic_key: 'manual:залог', topic_hint: 'Залог при аренде квартиры' });
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      const r = reply();
      await ctl.action({ action: 'reject', id: idea.id }, r);
      expect(r.body.status).toBe('rejected');

      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      expect(await topics.start({ force: true })).toBeNull();
      expect(await topics.start({ id: idea.id, force: true })).toBeNull();
      const row = (await pool.query(`SELECT status, slot_at FROM short_video WHERE id = $1`, [idea.id])).rows[0];
      expect(row).toEqual({ status: 'rejected', slot_at: null });
    });

    it('вместо отклонённой темы каталога пополнение недели заводит другую, на следующей позиции', async () => {
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      const wed = new Date('2026-10-28T15:00:00.000Z'); // ср 18:00 МСК, неделя 44
      expect(await topics.refillWeek(wed)).toBe(3);
      const first = (await pool.query(
        `SELECT id FROM short_video WHERE source = 'catalog' AND status = 'idea' ORDER BY source_ref LIMIT 1`,
      )).rows[0];
      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      await ctl.action({ action: 'reject', id: first.id }, reply());

      expect(await topics.refillWeek(wed)).toBe(1);
      const rows = (await pool.query(
        `SELECT source_ref, status FROM short_video WHERE source = 'catalog' ORDER BY source_ref`,
      )).rows;
      expect(rows.filter((x) => x.status === 'idea')).toHaveLength(3);
      expect(rows.filter((x) => x.status === 'rejected')).toHaveLength(1);
      expect(rows.map((x) => x.source_ref)).toContain('catalog:2026-W44:4');
    });

    it('отклонённый заказ можно заказать снова; открытый — дубль (null)', async () => {
      const topics = new ShortsTopicService(pgLike() as any, agents as any, settings as any);
      const order = { topic: 'Разнос плохого договора аренды квартиры', rubric: 'assistant' as const };
      const first = await topics.addManual(order);
      expect(first).not.toBeNull();
      expect(await topics.addManual(order)).toBeNull();

      const ctl = new ShortsController(pgLike() as any, settings as any, {} as any, { publicUrl: () => 'x' } as any);
      await ctl.action({ action: 'reject', id: first!.id }, reply());
      const again = await topics.addManual(order);
      expect(again).not.toBeNull();
      expect(again!.id).not.toBe(first!.id);
    });
  });
```

- [ ] **Step 2: Закоммитить и прогнать против живой базы**

```bash
git add src/shorts/shorts.integration.spec.ts
git commit -m "test(shorts): «Отклонить» у идеи на живом SQL — автозапуск, пополнение недели, повтор заказа"
NODE_RUN_DIR=. studio/scripts/node-run.sh "SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | tail -25"
```

Expected: PASS всех тестов файла, 0 пропущенных. Если тест про каталог упал на числе тем (`refillWeek` завёл не 3) — проверить, что у всех четырёх ассистентов внятный профиль (`hasClearProfile`), а не ослаблять ожидание.

### Task 3: гейты бэка

**Files:** нет.

- [ ] **Step 1: jest модуля и бота, живая база, tsc и сборка**

```bash
NODE_RUN_DIR=. studio/scripts/node-run.sh "npx jest src/shorts src/tg-bot 2>&1 | tail -8; SHORTS_PG_URL=postgresql://shortsit:shortsit@127.0.0.1:5432/shorts_it npx jest src/shorts/shorts.integration.spec.ts 2>&1 | grep -E '^Tests:'; out=\$(mktemp); if npx tsc -p tsconfig.build.json --noEmit >\$out 2>&1; then echo TSC_OK; else echo TSC_FAIL; tail -20 \$out; fi; if npm run build >\$out 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; tail -20 \$out; fi"
```

Expected: 0 красных (база на `ad086ef0` — 1451 тест, 61 пропущенный; тестов больше на число новых), живые — все зелёные, `TSC_OK`, `BUILD_OK`.

---

## Часть B. Фронт (`~/Downloads/spirits_front/.worktrees/reject-idea`)

### Task 4: `shortStatus.ts` — кнопки, подтверждение и итог идеи

**Files:**
- Modify: `src/components/admin/shortStatus.ts`
- Test: `src/components/admin/shortStatus.test.ts`

- [ ] **Step 1: Написать падающие тесты**

В `src/components/admin/shortStatus.test.ts` строку

```ts
    expect(actionsFor(detail({ status: 'idea' }))).toEqual(['start_now']);
```

заменить на

```ts
    expect(actionsFor(detail({ status: 'idea' }))).toEqual(['start_now', 'reject']);
```

и рядом с тестом `it('итог словами; одобрение — когда выйдет', …)` добавить:

```ts
  it('«Отклонить» идеи — своё подтверждение и итог; у темы каталога — про замену', () => {
    const order = item({ status: 'idea', source: 'manual', title: 'Залог при аренде', version: 'V1' });
    const catalog = item({ status: 'idea', source: 'catalog', title: 'Залог при аренде', version: 'V1' });
    const req = actionRequest('reject', order);
    expect(req.payload).toEqual({ action: 'reject', id: 's1', version: 'V1' });
    expect(req.lock).toBe(false);
    expect(req.confirm).toBe(
      'Отклонить идею «Залог при аренде»?\n\nВ работу она не пойдёт, вернуть нельзя — только заказать заново.',
    );
    expect(actionRequest('reject', catalog).confirm).toBe(
      'Отклонить идею «Залог при аренде»?\n\nВ работу она не пойдёт, вернуть нельзя — только заказать заново.' +
        ' На её место при пополнении недели встанет другая тема.',
    );
    expect(successText('reject', order, null, NOW)).toBe('Идея отклонена — в работу не пойдёт.');
    expect(successText('reject', catalog, null, NOW)).toBe(
      'Идея отклонена — в работу не пойдёт. Замену добавит «Пополнить темы недели» или воскресное пополнение.',
    );
    expect(successText('reject', item({ status: 'pending_review' }), null, NOW)).toBe('Ролик отклонён.');
    expect(actionRequest('reject', item({ status: 'pending_review', title: 'Залог при аренде' })).confirm).toBe(
      'Отклонить ролик «Залог при аренде»?\n\nРолик не выйдет, вернуть его нельзя.',
    );
  });
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
```

Expected: FAIL двух тестов — `actionsFor` идеи и нового.

- [ ] **Step 3: Реализовать**

В `src/components/admin/shortStatus.ts`:

1. В `actionsFor` ветку идеи

```ts
    case 'idea':
      return ['start_now'];
```

заменить на

```ts
    case 'idea':
      // Обе кнопки идеи — в её строке (ShortCard), не в раскрытой карточке.
      return ['start_now', 'reject'];
```

2. Тип цели решения — с `status` и `source`:

```ts
type Target = Pick<
  ShortItem,
  'id' | 'version' | 'title' | 'topicHint' | 'topicKey' | 'failedFrom' | 'publications' | 'format' | 'status' | 'source'
>;
```

3. `named` — через общее «название в кавычках»:

```ts
/** Название в кавычках, не длиннее 80 знаков, — для подтверждений. */
function quoted(d: Target): string {
  const chars = Array.from(shortTitle(d));
  return `«${chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : chars.join('')}»`;
}

function named(d: Target): string {
  return `ролик ${quoted(d)}`;
}
```

4. В `actionRequest` ветка `case 'reject':` — в начале ветки, перед прежним `return`:

```ts
    case 'reject':
      if (d.status === 'idea') {
        return {
          payload: { action: 'reject', id: d.id, version: d.version },
          confirm:
            `Отклонить идею ${quoted(d)}?\n\nВ работу она не пойдёт, вернуть нельзя — только заказать заново.` +
            (d.source === 'catalog' ? ' На её место при пополнении недели встанет другая тема.' : ''),
          lock: false,
        };
      }
      return {
        payload: { action: 'reject', id: d.id, version: d.version },
        confirm: d.failedFrom === 'publishing'
          ? `Отклонить ${named(d)}?\n\nПовторов публикации больше не будет. Если пост всё-таки вышел в канал — сначала отметьте «Пост вышел».`
          : `Отклонить ${named(d)}?\n\nРолик не выйдет, вернуть его нельзя.`,
        lock: false,
      };
```

5. `successText` — сигнатура и ветка `reject`:

```ts
export function successText(
  kind: ShortAction,
  d: Pick<ShortItem, 'failedFrom'> & Partial<Pick<ShortItem, 'status' | 'source'>>,
  res: unknown,
  now: Date,
): string {
```

```ts
    case 'reject':
      if (d.status === 'idea') {
        return d.source === 'catalog'
          ? 'Идея отклонена — в работу не пойдёт. Замену добавит «Пополнить темы недели» или воскресное пополнение.'
          : 'Идея отклонена — в работу не пойдёт.';
      }
      return 'Ролик отклонён.';
```

- [ ] **Step 4: Убедиться, что проходит, закоммитить, tsc на ноде**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/shortStatus.test.ts
git branch --show-current
git add src/components/admin/shortStatus.ts src/components/admin/shortStatus.test.ts
git commit -m "admin: ролики — «Отклонить» у идеи: кнопка по статусу, подтверждение и итог"
```

Затем tsc своих файлов на ноде (команда — в «Общих правилах»). Expected: PASS, `OWN_TSC_CLEAN`.

### Task 5: строка идеи и архив — `ShortCard.tsx`, `ShortActions.tsx`

**Files:**
- Modify: `src/components/admin/ShortCard.tsx`, `src/components/admin/ShortActions.tsx`
- Test: `src/components/admin/ShortCard.test.tsx`

- [ ] **Step 1: Написать падающие тесты**

В `src/components/admin/ShortCard.test.tsx`, рядом с тестом `it('раскрытая идея — без пустой обёртки действий (кнопка только в строке)', …)`:

```ts
  it('строка идеи — «Отклонить» рядом с «Запустить сейчас»; занято гасит обе', () => {
    const { onAction } = render({ item: item({ status: 'idea' }) });
    click(q('short-idea-reject-s1')!);
    expect(onAction).toHaveBeenCalledWith('reject');
    m.unmount();
    render({ item: item({ status: 'idea' }), busy: true });
    expect((q('short-idea-reject-s1') as HTMLButtonElement).disabled).toBe(true);
    expect((q('short-start-s1') as HTMLButtonElement).disabled).toBe(true);
  });

  it('раскрытая идея — «Отклонить» не дублируется в карточке', () => {
    render({ open: true, item: item({ status: 'idea' }), detail: detail({ status: 'idea', videoUrl: null }) });
    expect(q('short-reject')).toBeNull();
    expect(q('short-idea-reject-s1')).not.toBeNull();
  });

  it('отклонённый без видео — текст заказа, а не «Видео ещё нет»', () => {
    render({
      open: true,
      item: item({ status: 'rejected' }),
      detail: detail({ status: 'rejected', videoUrl: null, topicHint: 'Залог при аренде квартиры' }),
    });
    expect(q('short-idea-order-s1')!.textContent).toBe('Залог при аренде квартиры');
    expect(m.container.textContent).not.toContain('Видео ещё нет');
  });
```

(Если `afterEach` файла сам размонтирует `m`, а повторный `render` в первом тесте мешает — разбить его на два теста, не убирая проверок.)

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortCard.test.tsx
```

Expected: FAIL трёх новых тестов: нет `short-idea-reject-s1`; в раскрытой идее появился `short-reject` (после Task 4 `actionsFor` идеи отдаёт `reject`); у отклонённого — «Видео ещё нет».

- [ ] **Step 3: Реализовать**

1. `src/components/admin/ShortActions.tsx` — строку

```ts
  // «Запустить сейчас» — кнопка строки (ShortCard), а не этого блока: без
  // других действий пустая обёртка с отступом никому не нужна.
  if (!actions.length || actions.every((a) => a === 'start_now')) return null;
```

заменить на

```ts
  // Кнопки идеи — «Запустить сейчас» и «Отклонить» — в её строке (ShortCard),
  // а не в этом блоке: пустая обёртка с отступом никому не нужна.
  if (!actions.length || detail.status === 'idea') return null;
```

2. `src/components/admin/ShortCard.tsx`, строка ролика — блок

```tsx
        {item.status === 'idea' && (
          <button type="button" data-testid={`short-start-${item.id}`} onClick={() => onAction('start_now')} disabled={busy}
            className="flex-shrink-0 px-3 py-1 text-xs bg-forest-600 text-white rounded hover:bg-forest-700 disabled:opacity-50">
            Запустить сейчас
          </button>
        )}
```

заменить на

```tsx
        {item.status === 'idea' && (
          <>
            <button type="button" data-testid={`short-start-${item.id}`} onClick={() => onAction('start_now')} disabled={busy}
              className="flex-shrink-0 px-3 py-1 text-xs bg-forest-600 text-white rounded hover:bg-forest-700 disabled:opacity-50">
              Запустить сейчас
            </button>
            <button type="button" data-testid={`short-idea-reject-${item.id}`} onClick={() => onAction('reject')} disabled={busy}
              className="flex-shrink-0 px-3 py-1 text-xs bg-rose-50 text-rose-700 rounded hover:bg-rose-100 disabled:opacity-50">
              Отклонить
            </button>
          </>
        )}
```

3. Там же, `ShortVideo` — условие текста заказа

```tsx
    // У идеи видео не будет никогда: вместо пустой фразы — полный текст
    // заказа (тема или история кейса), иначе владелец не видит его нигде.
    if (detail.status === 'idea' && detail.topicHint) {
```

заменить на

```tsx
    // У идеи видео не будет никогда, у отклонённой без сборки — тоже: вместо
    // пустой фразы — полный текст заказа (тема или история кейса), иначе
    // владелец не видит его нигде.
    if ((detail.status === 'idea' || detail.status === 'rejected') && detail.topicHint) {
```

- [ ] **Step 4: Убедиться, что проходит, закоммитить, tsc на ноде**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/ShortCard.test.tsx src/components/admin/shortStatus.test.ts
git branch --show-current
git add src/components/admin/ShortCard.tsx src/components/admin/ShortActions.tsx src/components/admin/ShortCard.test.tsx
git commit -m "admin: ролики — «Отклонить» в строке идеи; у отклонённого без видео — текст заказа"
```

Затем tsc своих файлов на ноде. Expected: PASS, `OWN_TSC_CLEAN`.

### Task 6: экран — решение строки идеи (`AdminShortsView.tsx`)

**Files:**
- Modify: `src/components/admin/AdminShortsView.tsx` (`act`, строка `const target = …`)
- Test: `src/components/admin/AdminShortsView.test.tsx`

- [ ] **Step 1: Написать падающие тесты**

В `src/components/admin/AdminShortsView.test.tsx`, сразу после теста `it('«Запустить сейчас» у идеи — прямо в строке, после подтверждения (сборка тратит секунды Omni)', …)`:

```ts
  it('«Отклонить» у идеи — из строки, после подтверждения, с версией строки; отмена — ничего', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    serve({
      list: () => res(200, [item({ status: 'idea', slotAt: null, source: 'manual' })]),
      reject: () => res(200, item({ status: 'rejected' })),
    });
    await open();
    await clickAsync(q('short-idea-reject-s1')!);
    await settle();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(sent().some((p: any) => p.action === 'reject')).toBe(false);

    confirm.mockReturnValue(true);
    await clickAsync(q('short-idea-reject-s1')!);
    await settle();
    expect(sent()).toContainEqual({ action: 'reject', id: 's1', version: VERSION });
    expect(q('shorts-notice')!.textContent).toContain('Идея отклонена');
  });

  it('«Отклонить» у идеи, которую успел взять автозапуск, — жёлтая плашка с текстом сервера', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    serve({
      list: () => res(200, [item({ status: 'idea', slotAt: null })]),
      reject: () => res(409, {
        statusCode: 409, error: 'Conflict',
        message: 'Идея уже в работе — отклонить можно будет готовый ролик. Обновите список.',
      }),
    });
    await open();
    await clickAsync(q('short-idea-reject-s1')!);
    await settle();
    expect(q('shorts-error')!.textContent).toContain('Идея уже в работе');
    expect(q('shorts-error')!.getAttribute('data-conflict')).toBe('true');
  });
```

- [ ] **Step 2: Убедиться, что падает**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminShortsView.test.tsx
```

Expected: FAIL двух новых тестов: `act` не находит цели для `reject` без раскрытой карточки и запроса не шлёт.

- [ ] **Step 3: Реализовать**

В `src/components/admin/AdminShortsView.tsx`, в `act`, строку

```ts
    const target = detail?.id === short.id ? detail : kind === 'start_now' ? short : null;
```

заменить на

```ts
    // Решения строки — «Запустить сейчас» и «Отклонить» у идеи — подписываются
    // строкой списка; остальные — только раскрытой карточкой этого ролика.
    const rowAction = kind === 'start_now' || (kind === 'reject' && short.status === 'idea');
    const target = detail?.id === short.id ? detail : rowAction ? short : null;
```

- [ ] **Step 4: Убедиться, что проходит, закоммитить, tsc на ноде**

```bash
PATH=$HOME/.nvm/versions/node/v22.19.0/bin:$PATH ./node_modules/.bin/vitest run src/components/admin/AdminShortsView.test.tsx src/components/admin/ShortCard.test.tsx src/components/admin/shortStatus.test.ts
git branch --show-current
git add src/components/admin/AdminShortsView.tsx src/components/admin/AdminShortsView.test.tsx
git commit -m "admin: ролики — «Отклонить» у идеи подписывается строкой списка"
```

Затем tsc своих файлов на ноде. Expected: PASS, `OWN_TSC_CLEAN`.

### Task 7: гейты фронта на ноде

**Files:** нет.

- [ ] **Step 1: Полный прогон, tsc, сборка на точном коммите**

```bash
cd ~/Downloads/spirits_front/.worktrees/reject-idea
SHA=$(git rev-parse HEAD)
git push -q origin HEAD:refs/heads/feat/shorts-reject-idea
ssh -o ConnectTimeout=15 -o ControlMaster=auto -o "ControlPath=$HOME/.ssh/cm-%C" -o ControlPersist=30m dv@85.192.61.231 \
  "set -e; cd ~/ci/wt/reject-idea-front; git fetch -q origin refs/heads/feat/shorts-reject-idea; git checkout -q --detach ${SHA}; source ~/.nvm/nvm.sh >/dev/null; pnpm install --frozen-lockfile >/dev/null 2>&1; ./node_modules/.bin/vitest run 2>&1 | tail -6; echo TSC_ERRORS=\$(npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c 'error TS' || true); npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -E 'components/admin/(short|Short|AdminShorts|AdminBlogView)' || echo OWN_TSC_CLEAN; if pnpm build >/dev/null 2>&1; then echo BUILD_OK; else echo BUILD_FAIL; fi"
```

Expected: красных файлов нет (база на `7ae8017` — 172 файла, 2411 тестов; тестов больше на число новых), `TSC_ERRORS=42`, `OWN_TSC_CLEAN`, `BUILD_OK`.

---

## Часть C. Ревью и выкат

### Task 8: ревью обеих веток

- [ ] **Step 1:** `superpowers:code-reviewer` на `git -C ~/Downloads/spirits_back/.worktrees/reject-idea diff origin/main...HEAD` и `git -C ~/Downloads/spirits_front/.worktrees/reject-idea diff origin/main...HEAD`. Мерило — спека и этот план. Внимание: гонка с автозапуском и второй вкладкой; версия строки у решения идеи; карточка идеи не дублирует кнопку; тексты отказов и подтверждений.
- [ ] **Step 2:** Critical и Important — тест, потом код; затем гейты задач 3 и 7 заново.

### Task 9 (OK владельца): слияние и выкат

- [ ] **Step 1:** OK владельца на слияние и выкат.
- [ ] **Step 2:** чужого выката нет — отдельным шагом на маке и на ноде:
  ```bash
  ps -eo pid,command | grep -E "^\s*[0-9]+ bash .*scripts/deploy\.sh$" || echo "мак: выката нет"
  ssh dv@85.192.61.231 'pgrep -af "^bash scripts/deploy.sh" || echo "нода: выката нет"'
  ```
  Параллельным сессиям — сообщение до пуша в `main`.
- [ ] **Step 3:** в каждом дереве `git fetch -q origin && git rebase origin/main`; сдвинулся `main` — гейты задач 3 и 7 заново; затем `SHA=$(git rev-parse HEAD) && git push origin "${SHA}:refs/heads/main"` (в zsh — только `${SHA}`).
- [ ] **Step 4:** выкат как 31.10 (`~/deploy-logs/launch-ashp.sh` — образец): свои свежие клоны `~/deploy-clones/<имя>`, `test-server.env.local` и ссылка `tests/node_modules` в клон бэка, `source ~/.nvm/nvm.sh`, `deploy.sh` отвязанно через `setsid -f` с флагами `SKIP_BOTS=1 SKIP_PRODUCTS_HOST=1` (с `TEST_ONLY=1`, если владелец просит только стенд). Следить по логу узким фильтром (без строк `[Nest]`) до `ALL PHASES GREEN` или отказа.
- [ ] **Step 5:** проверка чтением: чанк `AdminPage-*.js` содержит `short-idea-reject-`; `admin/shorts list` под админом через debug-OTP — 200 (на проде — скриптом на самом сервере, секреты не печатать). Ничего не отклонять за владельца.
- [ ] **Step 6:** убрать за собой: клоны выката; рабочее дерево ноды `git -C ~/ci/spirits_front worktree remove ~/ci/wt/reject-idea-front`; деревья мака `.worktrees/reject-idea` в обоих репозиториях и локальные ветки — после слияния.
