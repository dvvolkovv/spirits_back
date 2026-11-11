# Relay Session Upload Directory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both exact upload paths and `/tmp/agent-uploads/<fs_key>/*.docx` work for new relay uploads without breaking legacy flat paths.

**Architecture:** Expand sandbox read rules first, then store new uploads in a per-session `0700` directory while preserving the existing safe filename and legacy flat-path permission. The two commits map to independently deployable expand/use stages.

**Tech Stack:** Node.js 22, Express, Multer, `node:test`, TypeScript backend repo containing JavaScript ESM relay modules.

---

## File map

- `relay-agent/sandbox-policy.mjs`: allow own session upload directory plus the legacy flat prefix.
- `relay-agent/sandbox-policy.test.mjs`: executable contract for both read permissions.
- `relay-agent/paths.mjs`: create and validate the per-session upload directory.
- `relay-agent/server.mjs`: place newly renamed uploads in that directory in every sandbox mode.
- `relay-agent/server-sandbox.test.mjs`: real multipart regression tests with two files and captured model prompt.

Local implementation worktree: `/Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads`.
Isolated test-node worktree: `~/ci/wt/relay-uploads-1111` on `dv@85.192.61.231`.
Do not run npm, Jest, builds, or relay tests on the Mac.

### Task 1: Expand sandbox read permissions without changing storage

**Files:**
- Modify: `relay-agent/sandbox-policy.test.mjs:197-221`
- Modify: `relay-agent/sandbox-policy.mjs:131-153`

- [ ] **Step 1: Establish the clean baseline on the test node**

Push the current branch, then create an isolated detached worktree at its exact SHA:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/spirits_back fetch -q origin && git -C ~/ci/spirits_back worktree add --detach ~/ci/wt/relay-uploads-1111 $SHA"
ssh dv@85.192.61.231 'cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && npm ci && node --test relay-agent/paths.test.mjs relay-agent/sandbox-policy.test.mjs relay-agent/server-sandbox.test.mjs'
```

Expected: existing tests PASS with `fail 0`. If the isolated worktree already exists, do not delete or reuse it blindly; inspect its HEAD and choose the unique path `~/ci/wt/relay-uploads-1111-b` for every later command instead.

- [ ] **Step 2: Add the failing permission assertion**

In the existing test `инструменты: on ограничивает Read/Glob/Grep и Write/Edit, но оставляет свои uploads`, add the new root before the legacy root:

```js
for (const root of [
  `/tmp/agent-output/${FS_KEY}/**`,
  `/tmp/agent-scratch/${FS_KEY}/**`,
  `/tmp/agent-uploads/${FS_KEY}/**`,
  `/tmp/agent-uploads/${FS_KEY}_*`,
  '/opt/linkeon-agent/**', '/usr/**', '/etc/**',
]) assert.ok(rules.includes(`${name}(${root})`), `${name}(${root})`);
assert.equal(rules.some((rule) => rule.includes('fedcba0987654321fedcba0987654321')), false);
```

Do not add the implementation yet: the next step must prove that this assertion is red on the old policy.

- [ ] **Step 3: Commit and run the focused test to confirm the intended red result**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads add relay-agent/sandbox-policy.test.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads commit -m "test(relay): чтение каталога загрузок сессии (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/sandbox-policy.test.mjs"
```

Expected: FAIL in the edited test; `Read(/tmp/agent-uploads/0123456789abcdef0123456789abcdef/**)` is missing. No other test should be newly red.

- [ ] **Step 4: Add the minimal implementation**

In `buildSandboxTools`, add the directory rule immediately before the legacy prefix:

```js
const readRoots = [
  `${output}/${fsKey}/**`,
  `${scratch}/${fsKey}/**`,
  `${uploads}/${fsKey}/**`,
  `${uploads}/${fsKey}_*`,
  `${opt}/**`, '/usr/**', '/etc/**',
];
```

- [ ] **Step 5: Commit, publish, and verify green**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads add relay-agent/sandbox-policy.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads commit -m "fix(relay): разрешить каталог загрузок сессии" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
EXPAND_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $EXPAND_SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/sandbox-policy.test.mjs"
```

Expected: PASS, `fail 0`. Record `EXPAND_SHA` in the task state; the next task starts from this exact commit.

### Task 2: Reproduce the flat-upload failure with real multipart requests

**Files:**
- Modify: `relay-agent/server-sandbox.test.mjs:24-39`
- Modify: `relay-agent/server-sandbox.test.mjs:140-160`
- Modify: `relay-agent/server-sandbox.test.mjs` after the existing `server dirs` test

- [ ] **Step 1: Capture the prompt sent to the fake Claude process**

Replace the stdin line in `fakeChild` with:

```js
child.input = '';
child.stdin = new Writable({
  write(chunk, encoding, callback) {
    child.input += chunk.toString();
    callback();
  },
});
```

- [ ] **Step 2: Add a multipart helper beside the existing JSON request helper**

```js
const requestUpload = async (files, { sessionId = 'server-upload-session', fsKey = FS_KEY } = {}) => {
  const payload = new FormData();
  payload.append('message', 'test uploaded documents');
  payload.append('sessionId', sessionId);
  if (fsKey) payload.append('fs_key', fsKey);
  payload.append('noFallback', '1');
  for (const file of files) {
    payload.append('files', new Blob([file.body], {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }), file.name);
  }
  const response = await fetch(baseUrl + '/chat', {
    method: 'POST',
    headers: { 'x-agent-secret': SECRET },
    body: payload,
  });
  return { response, text: await response.text() };
};
```

Include `requestUpload` in the object returned by `fixture`:

```js
return { root, dirs, env, calls, runtime, request, requestUpload, turnFiles };
```

- [ ] **Step 3: Add the two-file regression test for both modes**

```js
for (const mode of ['on', 'off']) {
  test(`server ${mode}: два DOCX доступны по точным путям и через каталог сессии`, async (t) => {
    const f = await fixture(t, { mode });
    const { response } = await f.requestUpload([
      { name: 'first.docx', body: 'first-document-body' },
      { name: 'second.docx', body: 'second-document-body' },
    ]);
    assert.equal(response.status, 200);

    const dir = path.join(f.dirs.uploadDir, FS_KEY);
    const expected = [`${FS_KEY}_first.docx`, `${FS_KEY}_second.docx`];
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.docx')).sort(), expected);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.readFileSync(path.join(dir, expected[0]), 'utf8'), 'first-document-body');
    assert.equal(fs.readFileSync(path.join(dir, expected[1]), 'utf8'), 'second-document-body');

    const prompt = f.calls[0].child.input;
    for (const name of expected) {
      const full = path.join(dir, name);
      assert.ok(prompt.includes(`- ${full} (name: `), full);
      assert.equal(fs.existsSync(full), true);
    }
  });
}
```

The `readdirSync(dir)` assertion is the regression: it is equivalent to the observed `glob('*.docx')` recovery path.

- [ ] **Step 4: Commit the red regression tests and confirm the failure at that exact SHA**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads add relay-agent/server-sandbox.test.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads commit -m "test(relay): загрузки доступны через каталог сессии (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/server-sandbox.test.mjs"
```

Expected: both new tests FAIL with `ENOENT` while reading `<fixture>/uploads/0123456789abcdef0123456789abcdef`; existing tests remain green. Record the failing output in the task state before implementing the fix.

- [ ] **Step 5: Confirm the red commit contains no implementation**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads show --stat --oneline HEAD
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads diff --name-only HEAD^..HEAD
```

Expected: the only changed file is `relay-agent/server-sandbox.test.mjs`; `paths.mjs`, `server.mjs`, and `sandbox-policy.mjs` are absent.

### Task 3: Store new uploads in the session directory

**Files:**
- Modify: `relay-agent/paths.mjs:109-127`
- Modify: `relay-agent/server.mjs:10`
- Modify: `relay-agent/server.mjs:546-580`
- Test: `relay-agent/server-sandbox.test.mjs`

- [ ] **Step 1: Add the focused directory helper**

Append to `paths.mjs` after `ensureSessionDirs`:

```js
export async function ensureSessionUploadDir(fsKey, { uploads = "/tmp/agent-uploads" } = {}) {
  const dir = sessionOutputDir(uploads, fsKey);
  if (!dir) throw new TypeError("invalid fsKey");
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.chmod(dir, 0o700);
  return dir;
}
```

`sessionOutputDir` already rejects separators, dot segments, and escapes outside the upload root.

- [ ] **Step 2: Import and call the helper before renaming any upload**

Add `ensureSessionUploadDir` to the import from `./paths.mjs` in `server.mjs`.

Immediately after the `if (sbxOn) { ... } else { ... }` block that creates `outDir`, add:

```js
// Вложенный каталог — только для непредсказуемого fs_key от бэка. Legacy
// fallback остаётся плоским: его sessionId предсказуем, а scrub/backfill
// знают именно прежние плоские пути.
const uploadSessionDir = req.files?.length && req.body.fs_key === fsKey
  ? await ensureSessionUploadDir(fsKey, { uploads: UPLOAD_DIR })
  : UPLOAD_DIR;
```

The directory is created only for multipart with a valid server `fs_key`. Text turns and legacy fallback keep the previous root behavior; this also prevents predictable legacy directories, scrub/mask regressions, and the reserved `mcp` directory collision.

- [ ] **Step 3: Change only the parent directory of primary and fallback names**

Replace the two destination computations, keeping the existing filename functions and error handling:

```js
const newPath = path.join(uploadSessionDir, uploadFileName(f.originalname, fsKey));
```

```js
const fallback = path.join(uploadSessionDir, fallbackFileName(f.originalname, fsKey, randomUUID()));
```

Do not move old files, change output directories, alter prompt formatting, or add filename-decoding changes.

- [ ] **Step 3A: Clean only Multer source paths in the common finally**

Add this loop before the existing settings cleanup in `server.mjs`:

```js
// Multer записывает исходники до настройки хода. После renameSync их уже
// нет (ENOENT); при ранней ошибке удаляем, чтобы ответ 500 не оставлял
// сотни мегабайт осиротевших файлов в корне uploads.
for (const file of req.files || []) {
  try { fs.unlinkSync(file.path); } catch (e) {
    if (e?.code !== "ENOENT") console.log("исходник Multer не удалён: " + (e?.code || e?.name || "?"));
  }
}
```

`ENOENT` after a successful rename is expected. Any pre-existing conflict file is not in `req.files` and must remain untouched.

- [ ] **Step 3B: Keep review regression tests beside the two-mode test**

`requestUpload` accepts `{ sessionId = 'server-upload-session', fsKey = FS_KEY } = {}` and appends `fs_key` only when `fsKey` is truthy. The following cases must be red before the implementation and green afterward:

```js
for (const legacyKey of ['70000000000_12_ru', 'mcp']) {
  test(`server on: legacy ${legacyKey} сохраняет плоскую схему загрузок`, async (t) => {
    const f = await fixture(t);
    const { response } = await f.requestUpload([
      { name: 'first.docx', body: 'legacy-document-body' },
    ], { sessionId: legacyKey, fsKey: null });
    assert.equal(response.status, 200);
    const flat = path.join(f.dirs.uploadDir, `${legacyKey}_first.docx`);
    assert.equal(fs.readFileSync(flat, 'utf8'), 'legacy-document-body');
    assert.equal(fs.existsSync(path.join(f.dirs.uploadDir, legacyKey)), false);
    assert.ok(f.calls[0].child.input.includes(`- ${flat} (name: `));
    assert.ok(arg(f.calls[0].args, '--allowedTools').includes(`Read(${f.dirs.uploadDir}/${legacyKey}_*)`));
  });
}

test('server off: текстовый ход без вложений не обращается к каталогу загрузок', async (t) => {
  const f = await fixture(t, { mode: 'off' });
  const conflict = path.join(f.dirs.uploadDir, FS_KEY);
  fs.writeFileSync(conflict, 'not-a-directory');
  const { response } = await f.request();
  assert.equal(response.status, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'not-a-directory');
});

test('server off: ошибка создания каталога очищает исходные Multer temp', async (t) => {
  const f = await fixture(t, { mode: 'off' });
  const conflict = path.join(f.dirs.uploadDir, FS_KEY);
  fs.writeFileSync(conflict, 'not-a-directory');
  const { response } = await f.requestUpload([
    { name: 'first.docx', body: 'first-document-body' },
    { name: 'second.docx', body: 'second-document-body' },
  ]);
  assert.equal(response.status, 500);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(fs.readdirSync(f.dirs.uploadDir).sort(), [FS_KEY]);
  assert.equal(fs.readFileSync(conflict, 'utf8'), 'not-a-directory');
});
```

The legacy tests fail because the flat file is absent; the text test returns 500 instead of 200; the Multer test shows two extra source files. After the fix, all 19 tests in `server-sandbox.test.mjs` pass.

- [ ] **Step 4: Commit, publish, and verify the regression is green**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads add relay-agent/paths.mjs relay-agent/server.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads commit -m "fix(relay): хранить новые загрузки в каталоге сессии" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
USE_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $USE_SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/server-sandbox.test.mjs relay-agent/sandbox-policy.test.mjs relay-agent/paths.test.mjs"
```

Expected: both new modes PASS and all existing focused tests PASS with `fail 0`.

- [ ] **Step 5: Record the use-stage SHA and verify the implementation diff boundary**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads show --stat --oneline "$USE_SHA"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads diff --name-only "$USE_SHA^..$USE_SHA"
```

Expected: only `relay-agent/paths.mjs` and `relay-agent/server.mjs` changed. Record `USE_SHA` in the task state.

### Task 4: Full verification, review, and staged rollout gate

**Files:**
- Verify: all `relay-agent/*.test.mjs`
- Verify: `docs/superpowers/specs/2026-11-11-relay-session-upload-directory-design.md`

- [ ] **Step 1: Run the complete relay suite at USE_SHA**

```bash
USE_SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads rev-parse HEAD)
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $USE_SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/*.test.mjs"
```

Expected: all relay tests PASS, `fail 0`. Also run locally without executing tests:

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads diff --check origin/main...HEAD
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads status --short --branch
```

Expected: no whitespace errors and no uncommitted files.

- [ ] **Step 2: Perform spec and code-quality reviews**

Use `superpowers:requesting-code-review`. Verify explicitly:

- the exact failing scenario from the spec is covered in both `on` and `off`;
- legacy `${uploads}/${fsKey}_*` remains present;
- no old file is moved or deleted;
- the upload directory is `0700`, the root guard remains `0311`;
- no unrelated encoding or LibreOffice change entered the diff;
- `EXPAND_SHA` is an ancestor of `USE_SHA`, so rollback from use to expand retains both read rules.

Do not claim success from code inspection alone: the complete suite output from Step 1 is mandatory.

- [ ] **Step 3: Push the verified branch and obtain the owner rollout decision**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-session-uploads push origin fix/relay-session-uploads
```

Present the two SHAs, test evidence, and review outcome. Obtain explicit OK before merging or touching the live relay.

- [ ] **Step 4: After OK, deploy expand and use as separate live stages**

Integrate the reviewed commits into `main` without force-push. From a fresh clone of that `main`, verify both SHAs are ancestors of `origin/main`. For each stage use the live relay HEAD as `BASE_SHA` and run only the official script:

```bash
BASE_SHA=$(ssh dv@5.101.115.184 'git -C /home/dv/file-agent rev-parse HEAD')
bash scripts/deploy-relay.sh "$BASE_SHA" "$EXPAND_SHA"
```

Verify health and one ordinary flat upload. Then deploy the use stage from the updated live HEAD:

```bash
BASE_SHA=$(ssh dv@5.101.115.184 'git -C /home/dv/file-agent rev-parse HEAD')
bash scripts/deploy-relay.sh "$BASE_SHA" "$USE_SHA"
```

Verify `/health`, zero unexpected `SANDBOX-FAIL`, two new DOCX through both access patterns, and one pre-existing flat upload. Do not use manual `git pull`, PM2 restart, rsync, or direct edits on the live relay.
