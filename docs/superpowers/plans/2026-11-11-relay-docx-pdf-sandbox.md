# Relay DOCX PDF Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent deterministic LibreOffice failures under Claude sandbox by directing DOCX/PDF work to the existing python-docx + WeasyPrint path.

**Architecture:** Change only `applySandboxPrompt` in `relay-agent/sandbox-policy.mjs`. The off prompt remains identical; on/canary gets a seccomp explanation, an explicit LibreOffice prohibition, and a concrete WeasyPrint conversion/verification path. No sandbox permissions or production binaries change.

**Tech Stack:** Node.js 22 ESM, `node:test`, Claude Code 2.1.280, python-docx, WeasyPrint, poppler-utils.

---

Local worktree: `/Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox`.
Test-node worktree: `~/ci/wt/relay-uploads-1111` (reuse only after checking out the exact pushed SHA; do not run tests on the Mac).

### Task 1: Red prompt contract and clean baseline

**Files:**
- Modify: `relay-agent/sandbox-policy.test.mjs` after the existing prompt tests

- [ ] **Step 1: Establish the baseline at the spec commit**

```bash
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox rev-parse HEAD)
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox push origin fix/relay-docx-pdf-sandbox
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/*.test.mjs"
```

Expected: all current tests PASS with `fail 0`; record the exact count as the baseline.

- [ ] **Step 2: Add the failing prompt test**

```js
test('промпт on: DOCX/PDF идёт через WeasyPrint, а не LibreOffice', () => {
  const input = [
    'PRE-INSTALLED: ffmpeg, ImageMagick, LibreOffice, Inkscape, poppler-utils',
    '4. For pptx: use python-pptx, keep simple, validate with soffice --headless --convert-to pdf.',
  ].join('\n');
  const out = applySandboxPrompt(input, true);
  assert.ok(out.includes('PRE-INSTALLED: ffmpeg, ImageMagick, Inkscape, poppler-utils'));
  assert.equal(out.includes('PRE-INSTALLED: ffmpeg, ImageMagick, LibreOffice'), false);
  assert.equal(out.includes('validate with soffice'), false);
  assert.match(out, /Do NOT run soffice, soffice\.bin, lowriter/);
  assert.match(out, /python-docx/);
  assert.match(out, /import weasyprint/);
  assert.match(out, /pdfinfo/);
  assert.match(out, /pdftoppm/);
  assert.match(out, /seccomp/);
});
```

The existing off test must remain unchanged and continue to assert the original string exactly.

- [ ] **Step 3: Commit and run the red test**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox add relay-agent/sandbox-policy.test.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox commit -m "test(relay): DOCX в PDF через WeasyPrint (красный)" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox push origin fix/relay-docx-pdf-sandbox
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test --test-name-pattern='WeasyPrint' relay-agent/sandbox-policy.test.mjs"
```

Expected: FAIL because `validate with soffice` and the old `PRE-INSTALLED` line remain and the new sandbox rule is absent.

### Task 2: Minimal sandbox prompt implementation

**Files:**
- Modify: `relay-agent/sandbox-policy.mjs:174-188`
- Test: `relay-agent/sandbox-policy.test.mjs`

- [ ] **Step 1: Add the explicit conversion rule**

Immediately before `applySandboxPrompt`, add:

```js
const SANDBOX_DOCX_RULE = `

DOCX/PDF UNDER SANDBOX:
- Do NOT run soffice, soffice.bin, lowriter, or other LibreOffice entry points. Claude Code seccomp blocks the Unix-socket IPC they require; every such attempt exits 1 without producing PDF.
- For DOCX to PDF and page previews, activate /opt/linkeon-agent/venv and use python-docx to read/edit the document plus WeasyPrint (import weasyprint) to render PDF. Preserve source structure, margins, fonts, alignment, tables and non-breaking spaces as faithfully as possible.
- Verify output with pdfinfo and render pages with pdftoppm; inspect them. Report only what these checks prove, never that output was validated with LibreOffice.`;
```

- [ ] **Step 2: Apply the two replacements and append the rule only when sandbox is on**

Inside `applySandboxPrompt`, chain these replacements before the existing `/home/dv` replacements and append `+ SANDBOX_DOCX_RULE` after them:

```js
.replace(
  'PRE-INSTALLED: ffmpeg, ImageMagick, LibreOffice, Inkscape, poppler-utils',
  'PRE-INSTALLED: ffmpeg, ImageMagick, Inkscape, poppler-utils',
)
.replace(
  'validate with soffice --headless --convert-to pdf',
  'validate with python-docx + WeasyPrint (in /opt/linkeon-agent venv), pdfinfo and pdftoppm',
)
```

The return remains a pure transformation of the input plus one `SANDBOX_DOCX_RULE`; `if (!sandboxOn) return prompt;` stays first.

- [ ] **Step 3: Commit and verify green**

```bash
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox add relay-agent/sandbox-policy.mjs
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox commit -m "fix(relay): DOCX в PDF через WeasyPrint в sandbox" -m "Co-Authored-By: Kimi <noreply@anthropic.com>"
git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox push origin fix/relay-docx-pdf-sandbox
SHA=$(git -C /Users/dmitry/Downloads/spirits_back/.worktrees/relay-docx-pdf-sandbox rev-parse HEAD)
ssh dv@85.192.61.231 "git -C ~/ci/wt/relay-uploads-1111 fetch -q origin && git -C ~/ci/wt/relay-uploads-1111 checkout -q $SHA && cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/sandbox-policy.test.mjs"
```

Expected: all prompt tests PASS with `fail 0`.

### Task 3: Real Claude conversion probe and full verification

**Files:**
- Verify: generated DOCX and PDF only in a new `/tmp/linkeon-docx-pdf-probe-*` directory on the relay
- Verify: `relay-agent/sandbox-policy.mjs` from the pushed HEAD, copied only into the probe directory

- [ ] **Step 1: Build a synthetic document and run the actual modified prompt**

Set `PROBE=/tmp/linkeon-docx-pdf-probe-1111` and create that directory on the relay, refusing to reuse any existing path. Create a DOCX with python-docx containing a right-aligned recipient, centered greeting, justified body, bold/italic runs, non-breaking spaces, and a small table. Copy `relay-agent/sandbox-policy.mjs` from the pushed HEAD into the probe directory with `git show HEAD:relay-agent/sandbox-policy.mjs`.

In the probe, compute `applySandboxPrompt('You are a document conversion test harness.', true)` from that file and start `claude --print --model claude-opus-5-5 --output-format stream-json` with the same sandbox settings used by relay, `Bash(*)` and `Read(${PROBE}/**)` tools only. The user request is:

```text
Convert ${PROBE}/input.docx to ${PROBE}/output.pdf and inspect the rendered page. Do not call soffice, soffice.bin, lowriter, apt, or sudo. Use only paths inside ${PROBE}.
```

Expected: model executes Python using `/opt/linkeon-agent/venv`, imports `weasyprint`, writes `output.pdf`, and runs `pdfinfo`/`pdftoppm`. No tool command may contain `soffice` or `lowriter`.

- [ ] **Step 2: Assert the generated PDF independently**

```bash
pdfinfo ${PROBE}/output.pdf
pdftotext ${PROBE}/output.pdf - | grep -E 'Recipient|Greeting'
```

Expected: `pdfinfo` exits 0 and reports a valid page count; the text check finds the synthetic recipient and greeting. Inspect the event stream and confirm zero LibreOffice invocations. If either check fails, stop: do not request deployment.

- [ ] **Step 3: Run the complete relay suite at the final pushed HEAD**

```bash
ssh dv@85.192.61.231 'cd ~/ci/wt/relay-uploads-1111 && source ~/.nvm/nvm.sh && node --test relay-agent/*.test.mjs'
```

Expected: all tests PASS with `fail 0`. Also require clean `git status`, `git diff --check origin/main...HEAD`, and no production user identifiers in the diff.

- [ ] **Step 4: Obtain spec and quality reviews**

Use `superpowers:requesting-code-review` twice. Verify the off prompt is unchanged, only sandbox prompt text changes, no `allowAllUnixSockets`, no `excludedCommands` expansion, no production binary/config edits, and the real probe evidence covers both model behavior and PDF validity. Address every Critical/Important finding through a new red-green cycle before rollout.

### Task 4: Owner decision and live rollout

- [ ] **Step 1: Present the final SHA, full test count, reviews, and probe evidence**

Ask for explicit approval to merge and run `scripts/deploy-relay.sh`. Do not merge or deploy without it.

- [ ] **Step 2: Merge through a fresh merge-worktree and verify the merged result**

Protect a concurrently moving `origin/main`: merge only onto the freshly fetched value, run the full suite on the merge commit, and push `HEAD:refs/heads/main` only if `origin/main` has not moved since the merge.

- [ ] **Step 3: Deploy through the official script and run the live probe**

Use the backend SHA named by the live relay commit as BASE and the merged target as TARGET:

```bash
BASE_SHA=$(ssh dv@5.101.115.184 'git -C /home/dv/file-agent log -1 --format=%s' | sed -n 's/^relay-agent из spirits_back //p')
BASE_SHA=$(git rev-parse "$BASE_SHA")
TARGET_SHA=$(git rev-parse HEAD)
bash scripts/deploy-relay.sh "$BASE_SHA" "$TARGET_SHA"
```

`BASE_SHA` must resolve to a full commit present in the local repository and matching the live relay content. Never guess it. After health and drain are green, run the same DOCX conversion through a fresh live relay session with a random test `fs_key`. Require `done.failed=false`, a valid PDF, and zero LibreOffice calls. Remove only probe-owned temporary files after verification.
