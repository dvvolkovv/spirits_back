#!/usr/bin/env python3
"""Врезка Qwen в relay server.mjs (spec spirits_back
docs/superpowers/specs/2026-10-30-llm-provider-switch-design.md).
Одна и та же для копии relay-agent/ в main и живого релея: каждый якорь
обязан встретиться ровно один раз, иначе — выход без записи.
Запуск: python3 qwen-patch.py <путь к server.mjs>"""
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "qwen-provider.mjs" in s:
    sys.exit("уже пропатчено")


def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {old[:90]!r}")
    s = s.replace(old, new)


def need(snippet):
    if snippet not in s:
        sys.exit(f"нет объявления, на которое опирается врезка: {snippet!r}")


RESULT_BRANCH = '} else if (ev.type === "result" && ev.result) {'
FATAL_ANCHOR = '          if (FATAL_RE.test(ev.result)) {\n'
RESULT_WRITE = '          if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "result", text: ev.result }) + "\\n\\n");\n'
OUTCOME_ANCHOR = '    // Ход закончился — смотрим, во что обошёлся его контекст, и решаем судьбу\n'

# 0. Переменные, которые врезка читает. Ошибку области видимости node --check
# не ловит, а handleEvent вызывается под try/catch, внешняя async-функция хода —
# под .catch: ReferenceError молча глотал бы каждое событие хода или done.
# Поэтому — проверка до записи.
for decl in ('const sessionId = ', 'const args = [', 'let streamedAny = ', 'let clientDisconnected = ',
             'const notice = ', 'const FATAL_RE = '):
    need(decl)
_branch = s.find(RESULT_BRANCH)
_is_err = s.find('const isErrorResult =')
_fatal = s.find(FATAL_ANCHOR)
_write = s.find(RESULT_WRITE)
if not (0 <= _branch < _is_err < _fatal < _write) or '} else if (' in s[_branch + 1:_write]:
    sys.exit("isErrorResult, проверка FATAL_RE и запись result — не в одной ветке result")
_r = s.find('let r = await runOnce(')
_outcome = s.find(OUTCOME_ANCHOR)
if not (0 <= _r < _outcome):
    sys.exit("let r = await runOnce( не стоит раньше учёта исхода хода")

# 1. Импорт модуля и окно предохранителя на весь процесс.
rep('import express from "express";\n',
    'import express from "express";\n'
    'import * as qwen from "./qwen-provider.mjs";\n')
rep('const sweepRuns = () => reap(finishedRun(liveRuns)).then(logReaped, () => {});\n',
    'const sweepRuns = () => reap(finishedRun(liveRuns)).then(logReaped, () => {});\n'
    '// Окно запасного Qwen и исходы аварийных ходов на нём — на весь процесс\n'
    '// (qwen-provider.mjs; spec spirits_back 2026-10-30-llm-provider-switch).\n'
    'const qwenBreaker = qwen.createQwenBreaker();\n')

# 2. Провайдер хода.
rep('  const reqModel = MODELS.includes(String(req.body.model || "")) ? String(req.body.model) : "default";\n',
    '  const reqModel = MODELS.includes(String(req.body.model || "")) ? String(req.body.model) : "default";\n'
    '  // Qwen: принудительный (provider=qwen — выбор пользователя в админке бэкенда)\n'
    '  // и запасной (сбой доступа к Claude). Ключ — файлом, читается на каждом ходе:\n'
    '  // нет файла — Qwen выключен. noFallback=1 — пробы мониторинга, только Claude.\n'
    '  const qwenCfg = qwen.readQwenConfig();\n'
    '  const qwenForced = String(req.body.provider || "") === "qwen";\n'
    '  const reqNoFallback = String(req.body.noFallback || "") === "1";\n'
    '  if (qwenForced && !qwenCfg) console.warn("[qwen] provider=qwen, но ключа нет — ход на Claude");\n'
    '  let provider = qwen.pickProvider({ forced: qwenForced, cfg: qwenCfg, breakerOpen: qwenBreaker.isOpen(), noFallback: reqNoFallback });\n'
    '  // Аварийный ход на Qwen: через открытое окно или после сбоя Claude в этом ходе.\n'
    '  let usedFallback = provider === "qwen" && !qwenForced;\n'
    '  // Инструмент с последствиями в этом ходе — после него на Qwen не переигрываем.\n'
    '  let riskyToolUsed = false;\n'
    '  // Ход прерван новым сообщением той же сессии (preempt ниже).\n'
    '  let preempted = false;\n')

# 3. runOnce: провайдер запуска — модель и окружение; сбой доступа к Claude в
# любом запуске хода — переигровка на Qwen.
rep('  function runOnce(useResume) {\n',
    '  // Окно запасного Qwen открывается при сбое доступа к Claude и тогда, когда\n'
    '  // сам ход на Qwen не переигрывается (инструмент с последствиями, уже ушёл\n'
    '  // текст, ход прерван): следующие ходы пойдут сразу на Qwen. Пробы\n'
    '  // (noFallback) окно не трогают.\n'
    '  const qwenWindowOnly = (why) => {\n'
    '    if (!qwenCfg || reqNoFallback) return;\n'
    '    qwenBreaker.open(qwenCfg.breakerMs);\n'
    '    console.warn("[qwen] " + sessionId + ": Claude недоступен (" + why + ") — ход не повторяется, окно запасного Qwen открыто");\n'
    '  };\n'
    '  // Ход на Qwen после сбоя доступа к Claude: окно открывается, тот же ход\n'
    '  // (тот же --resume — беседа продолжается между провайдерами) идёт на Qwen.\n'
    '  const fallbackToQwen = (useResume, why) => {\n'
    '    qwenBreaker.open(qwenCfg.breakerMs);\n'
    '    console.warn("[qwen] " + sessionId + ": Claude недоступен (" + why + ") → запасной Qwen " + qwen.qwenModelFor(reqModel, qwenCfg.models));\n'
    '    provider = "qwen";\n'
    '    usedFallback = true;\n'
    '    return runOnce(useResume, "qwen");\n'
    '  };\n'
    '  // Запуск хода. Без провайдера — текущий провайдер хода: после переключения\n'
    '  // на Qwen повтор, перезапуск и продолжение идут на Qwen. Сбой доступа к\n'
    '  // Claude (accessFailHit, разбор result ниже) в ЛЮБОМ запуске — первом, после\n'
    '  // протухшего resume, повторе после временной ошибки, продолжении после\n'
    '  // потолка шагов — переигрывается на Qwen здесь: пропущенный, он дал бы\n'
    '  // пустой ход без уведомления. Кроме хода, прерванного новым сообщением или\n'
    '  // брошенного бэкендом: запуск на Qwen убил бы уже новый ход этой сессии\n'
    '  // (pre-empt ниже) или отвечал бы в закрытый канал.\n'
    '  async function runOnce(useResume, runProvider = provider) {\n'
    '    const r = await runProcessOnce(useResume, runProvider);\n'
    '    if (!r.accessFailHit) return r;\n'
    '    if (preempted || clientDisconnected) {\n'
    '      qwenWindowOnly("отказ CLI");\n'
    '      return r;\n'
    '    }\n'
    '    return fallbackToQwen(useResume, "отказ CLI");\n'
    '  }\n'
    '\n'
    '  function runProcessOnce(useResume, runProvider) {\n')
rep('      const runArgs = resumeSid ? [...args, "--resume", resumeSid] : args;\n',
    '      const baseArgs = runProvider === "qwen" ? qwen.withModel(args, qwen.qwenModelFor(reqModel, qwenCfg.models)) : args;\n'
    '      const runArgs = resumeSid ? [...baseArgs, "--resume", resumeSid] : baseArgs;\n'
    '      const runStartedAt = Date.now();\n')
rep('...process.env, MCP_TIMEOUT: "120000"',
    '...(runProvider === "qwen" ? qwen.qwenSpawnEnv(process.env, qwenCfg) : process.env), MCP_TIMEOUT: "120000"')
rep('        preempt: () => notice(\n'
    '          "\\n\\n_(ответ прерван: вы отправили новое сообщение, и ассистент переключился на него. Токены за прерванный ход не списаны.)_",\n'
    '          "preempted",\n'
    '        ),\n',
    '        // preempted — сбой доступа в прерванном ходе на Qwen не переигрывается.\n'
    '        preempt: () => {\n'
    '          preempted = true;\n'
    '          notice(\n'
    '            "\\n\\n_(ответ прерван: вы отправили новое сообщение, и ассистент переключился на него. Токены за прерванный ход не списаны.)_",\n'
    '            "preempted",\n'
    '          );\n'
    '        },\n')
rep('      let imageLimitHit = false;\n',
    '      let imageLimitHit = false;\n'
    '      let accessFailHit = false;\n'
    '      let transientAccessLike = false;\n'
    '      let sawResult = false;\n')

# 4. Инструмент с последствиями.
rep('              if (TALERID_WRITE_RE.test(block.name || "")) taleridWriteUsed = true;\n',
    '              if (TALERID_WRITE_RE.test(block.name || "")) taleridWriteUsed = true;\n'
    '              if (!qwen.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n')

# 5. result: сбой доступа к Claude → Qwen (или только окно); ошибка доступа,
# которую штатно повторяют, — признак для решения после повтора.
rep(FATAL_ANCHOR,
    '          // Сбой доступа (qwen-provider.mjs): отказ CLI или ошибка, которую прежде\n'
    '          // закрывало уведомление cli_fatal (FATAL_RE: повтором не лечится, —\n'
    '          // например «API Error: 401 … OAuth token has expired»). У Claude до\n'
    '          // первого текста и без инструментов с последствиями ход переигрывается\n'
    '          // на Qwen, уведомление не шлём; иначе ход не повторяется, но окно\n'
    '          // открывается. Ошибка доступа, которую штатно повторяют (TRANSIENT_RE),\n'
    '          // — признак для решения после повтора (transientHit ниже).\n'
    '          const accessFailure = qwen.isAccessFailure(ev.result, { isError: isErrorResult, apiStatus: ev.api_error_status });\n'
    '          if (runProvider === "claude" && accessFailure && (qwen.looksLikeCliRefusal(ev.result) || FATAL_RE.test(ev.result))) {\n'
    '            if (qwen.mayFallback({ provider: runProvider, cfg: qwenCfg, noFallback: reqNoFallback, sentAnyText: streamedAny, riskyToolUsed })) {\n'
    '              accessFailHit = true;\n'
    '              return;\n'
    '            }\n'
    '            qwenWindowOnly("отказ CLI");\n'
    '          }\n'
    '          if (runProvider === "claude" && accessFailure && isErrorResult) transientAccessLike = true;\n'
    + FATAL_ANCHOR)
rep(RESULT_WRITE,
    '          // Успех запуска — для окна запасного Qwen: ни ошибки, ни сбоя доступа.\n'
    '          if (!isErrorResult && !accessFailure) sawResult = true;\n'
    + RESULT_WRITE)
rep('resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit });',
    'resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, accessFailHit, transientAccessLike, sawResult, startedAt: runStartedAt });')

# 6. Повтор после временной ошибки упал ошибкой доступа — на Qwen вместо
# уведомления «временный сбой» (если ход можно переиграть), иначе — окно.
rep('        notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
    '        if (provider === "claude" && r.transientAccessLike) {\n'
    '          if (!preempted && !clientDisconnected &&\n'
    '              qwen.mayFallback({ provider, cfg: qwenCfg, noFallback: reqNoFallback, sentAnyText: streamedAny, riskyToolUsed })) {\n'
    '            r = await fallbackToQwen(useResume, "ошибка доступа после повтора");\n'
    '          } else {\n'
    '            qwenWindowOnly("ошибка доступа после повтора");\n'
    '          }\n'
    '        }\n'
    '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n')

# 7. Исход хода — окно и статистика.
rep(OUTCOME_ANCHOR,
    '    // Окно запасного Qwen: успех Claude, начатый после открытия окна, его\n'
    '    // закрывает; исход аварийного хода на Qwen идёт в статистику (сбой —\n'
    '    // закрывает). Не считаются: принудительный Qwen (выбор пользователя) и ходы\n'
    '    // с неизвестным исходом — прерванный новым сообщением, брошенный бэкендом,\n'
    '    // упёршийся в потолок шагов.\n'
    '    if (!preempted && !clientDisconnected && failReason !== "max_turns") {\n'
    '      const runOk = !!r.sawResult && !r.accessFailHit && !r.transientHit;\n'
    '      if (provider === "qwen" && usedFallback) qwenBreaker.qwenFinished(runOk);\n'
    '      else if (provider === "claude" && runOk) qwenBreaker.claudeSucceeded(r.startedAt);\n'
    '    }\n'
    '\n'
    + OUTCOME_ANCHOR)

# 8. done и /health.
rep('        failReason,\n      }) + ',
    '        failReason,\n'
    '        provider,\n'
    '        fallback: usedFallback,\n'
    '      }) + ')
rep('res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime() });',
    'res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), qwen: { enabled: !!qwen.readQwenConfig(), ...qwenBreaker.stats() } });')

open(path, "w", encoding="utf-8").write(s)
print("ok:", path)
