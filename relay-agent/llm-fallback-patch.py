#!/usr/bin/env python3
"""Врезка цепочки запасных (Claude → Qwen → Kimi) и выбора Kimi в relay
server.mjs — поверх врезки Qwen (qwen-patch.py). Spec spirits_back
docs/superpowers/specs/2026-10-31-kimi-provider-design.md.
Одна и та же для копии relay-agent/ в main и живого релея: якоря — текст
врезки Qwen, одинаковый в обоих. Каждый якорь обязан встретиться ровно один
раз, иначе — выход без записи.
Запуск: python3 llm-fallback-patch.py <путь к server.mjs>"""
import re
import sys

path = sys.argv[1]
s = open(path, encoding="utf-8").read()
if "llm-fallback.mjs" in s:
    sys.exit("уже пропатчено")
if "qwen-provider.mjs" not in s:
    sys.exit("нет врезки Qwen — сначала qwen-patch.py")


def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {old[:90]!r}")
    s = s.replace(old, new)


def region(start, end, new):
    """Заменить кусок от начала start до конца end; оба — ровно по разу."""
    global s
    for a in (start, end):
        n = s.count(a)
        if n != 1:
            sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {a[:90]!r}")
    i = s.index(start)
    j = s.index(end)
    if j < i:
        sys.exit(f"конец раньше начала: {end[:90]!r}")
    s = s[:i] + new + s[j + len(end):]


def need(snippet):
    if snippet not in s:
        sys.exit(f"нет объявления, на которое опирается врезка: {snippet!r}")


# 0. Объявления, которые читает врезка. Ошибку области видимости node --check не
# ловит, а handleEvent и внешний ход глотают исключения — ReferenceError молча
# ломал бы каждый ход. Поэтому — проверка до записи.
for decl in ('const sessionId = ', 'const args = [', 'const reqModel = ', 'let streamedAny = ',
             'let clientDisconnected = ', 'const notice = ', 'const FATAL_RE = ', 'const fatalHint = ',
             'const TRANSIENT_RE = ', 'const IMG_LIMIT_RE = ', 'const NO_RESP_PLACEHOLDER = '):
    need(decl)

# 1. Модуль.
rep('import * as qwen from "./qwen-provider.mjs";\n',
    'import * as llm from "./llm-fallback.mjs";\n')

# 2. Окна на весь процесс.
region('// Окно запасного Qwen и исходы аварийных ходов на нём — на весь процесс\n',
       'const qwenBreaker = qwen.createQwenBreaker();\n',
       '// Окна запасного пути (окно Claude и «не отвечает» у каждого запасного) и\n'
       '// исходы аварийных ходов — на весь процесс (llm-fallback.mjs; spec\n'
       '// spirits_back 2026-10-31-kimi-provider-design).\n'
       'const fallbackState = llm.createFallbackState();\n')

# 3. План хода.
region('  // Qwen: принудительный (provider=qwen — выбор пользователя в админке бэкенда)\n',
       '  let riskyToolUsed = false;\n',
       '  // Провайдер хода (llm-fallback.mjs): выбор пользователя (provider=qwen|kimi —\n'
       '  // админка бэкенда) и аварийная цепочка Claude → Qwen → Kimi. Ключи — файлами,\n'
       '  // читаются на каждом ходе: нет файла — провайдер выключен. noFallback=1 —\n'
       '  // пробы мониторинга, только Claude.\n'
       '  const reqNoFallback = String(req.body.noFallback || "") === "1";\n'
       '  const llmCfgs = reqNoFallback ? llm.NO_CONFIGS : llm.readProviderConfigs();\n'
       '  const breakerMs = llm.readBreakerMs();\n'
       '  const reqProvider = llm.parseSelected(req.body.provider);\n'
       '  if (reqProvider && !llmCfgs[reqProvider] && !reqNoFallback) console.warn("[llm] provider=" + reqProvider + ", но ключа нет — обычный путь");\n'
       '  const selected = reqProvider && llmCfgs[reqProvider] ? reqProvider : "";\n'
       '  // План хода — кого пробовать по порядку; planStep — текущая попытка.\n'
       '  const plan = llm.planProviders({ selected, cfgs: llmCfgs, state: fallbackState, noFallback: reqNoFallback });\n'
       '  let planStep = 0;\n'
       '  let provider = plan[0];\n'
       '  // Ответ даёт аварийный путь: запасной не по выбору (окно Claude или сбой в этом ходе).\n'
       '  let usedFallback = llm.isEmergency(provider, selected);\n'
       '  // Ход дошёл до запасных аварийно — для окна Claude по итогам хода.\n'
       '  let reachedFallback = usedFallback;\n'
       '  // Инструмент с последствиями в этом ходе — после него у другого провайдера не переигрываем.\n'
       '  let riskyToolUsed = false;\n')

# 4. runOnce: переход к следующему в плане.
region('  // Окно запасного Qwen открывается при сбое доступа к Claude и тогда, когда\n',
       '    return fallbackToQwen(useResume, "отказ CLI");\n  }\n',
       '  // Сбой доступа у провайдера (llm-fallback.mjs): у Claude — окно Claude (если\n'
       '  // есть хоть один запасной — иначе переключаться не на кого), у запасного — его\n'
       '  // окно «не отвечает». Пробы (noFallback) окон не трогают.\n'
       '  const noteAccessFailure = (failed, why) => {\n'
       '    if (reqNoFallback) return;\n'
       '    if (failed === "claude") {\n'
       '      if (!llm.anyConfigured(llmCfgs)) return;\n'
       '      fallbackState.openClaudeWindow(breakerMs);\n'
       '      console.warn("[llm] " + sessionId + ": Claude недоступен (" + why + ") — окно Claude открыто");\n'
       '    } else {\n'
       '      fallbackState.markDown(failed, breakerMs);\n'
       '      console.warn("[llm] " + sessionId + ": " + llm.PROVIDER_LABELS[failed] + " не отвечает (" + why + ")");\n'
       '    }\n'
       '  };\n'
       '  // Переход к следующему в плане: тот же ход (тот же --resume — беседа\n'
       '  // продолжается между провайдерами) у следующего провайдера; null — некуда.\n'
       '  // Аварийный исход упавшего запасного — в статистику здесь, финальный — по\n'
       '  // итогам хода.\n'
       '  const switchProvider = (useResume, why) => {\n'
       '    const i = llm.nextStep(plan, planStep, fallbackState);\n'
       '    if (i < 0) return null;\n'
       '    const from = provider;\n'
       '    if (llm.isEmergency(from, selected)) fallbackState.recordOutcome(from, false);\n'
       '    planStep = i;\n'
       '    provider = plan[i];\n'
       '    usedFallback = llm.isEmergency(provider, selected);\n'
       '    if (usedFallback) reachedFallback = true;\n'
       '    const model = provider === "claude" ? reqModel : llm.modelFor(reqModel, llmCfgs[provider].models);\n'
       '    console.warn("[llm] " + sessionId + ": " + llm.PROVIDER_LABELS[from] + " (" + why + ") → " + llm.PROVIDER_LABELS[provider] + " " + model);\n'
       '    return runOnce(useResume, provider);\n'
       '  };\n'
       '  // Запуск хода. Без провайдера — текущий провайдер хода: после переключения\n'
       '  // повтор, перезапуск и продолжение идут у нового. Сбой, после которого ход\n'
       '  // переходит к следующему в плане (switchHit, разбор result ниже), в ЛЮБОМ\n'
       '  // запуске — первом, после протухшего resume, повторе после временной ошибки,\n'
       '  // продолжении после потолка шагов — переигрывается здесь. Кроме хода,\n'
       '  // прерванного новым сообщением или брошенного бэкендом: запуск у следующего\n'
       '  // убил бы уже новый ход этой сессии (pre-empt ниже) или отвечал бы в\n'
       '  // закрытый канал. План кончился за время хода — уведомление, которое разбор\n'
       '  // result придержал.\n'
       '  async function runOnce(useResume, runProvider = provider) {\n'
       '    const r = await runProcessOnce(useResume, runProvider);\n'
       '    if (!r.switchHit || preempted || clientDisconnected) return r;\n'
       '    const next = switchProvider(useResume, r.switchWhy);\n'
       '    if (next) return next;\n'
       '    const fatal = FATAL_RE.test(r.switchText);\n'
       '    notice(fatal ? fatalHint(r.switchText) : "_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", fatal ? "cli_fatal" : "transient");\n'
       '    return r;\n'
       '  }\n')

# 5. Модель и окружение запуска; комментарий у preempt.
rep('      const baseArgs = runProvider === "qwen" ? qwen.withModel(args, qwen.qwenModelFor(reqModel, qwenCfg.models)) : args;\n',
    '      const baseArgs = runProvider === "claude" ? args : llm.withModel(args, llm.modelFor(reqModel, llmCfgs[runProvider].models));\n')
rep('...(runProvider === "qwen" ? qwen.qwenSpawnEnv(process.env, qwenCfg) : process.env), MCP_TIMEOUT: "120000"',
    '...(runProvider === "claude" ? process.env : llm.providerSpawnEnv(process.env, llmCfgs[runProvider])), MCP_TIMEOUT: "120000"')
rep('        // preempted — сбой доступа в прерванном ходе на Qwen не переигрывается.\n',
    '        // preempted — прерванный ход у другого провайдера не переигрывается.\n')

# 6. Признаки запуска.
rep('      let accessFailHit = false;\n      let transientAccessLike = false;\n      let sawResult = false;\n',
    '      // Сбой, после которого ход переходит к следующему в плане (runOnce выше).\n'
    '      let switchHit = false;\n'
    '      let switchWhy = "";\n'
    '      let switchText = "";\n'
    '      let transientAccessLike = false;\n'
    '      let sawResult = false;\n')
rep('              if (!qwen.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n',
    '              if (!llm.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n')

# 7. Разбор result.
region('          // Сбой доступа (qwen-provider.mjs): отказ CLI или ошибка, которую прежде\n',
       '          if (runProvider === "claude" && accessFailure && isErrorResult) transientAccessLike = true;\n',
       '          // Сбой провайдера (llm-fallback.mjs). Отказ CLI или ошибка, которую\n'
       '          // прежде закрывало уведомление cli_fatal (FATAL_RE: повтором не лечится,\n'
       '          // — например «API Error: 401 … OAuth token has expired»), — у любого\n'
       '          // провайдера; у выбранного пользователем — и любая другая ошибка, кроме\n'
       '          // тех, что штатно повторяются (временная, перегруз картинками, пустой\n'
       '          // ответ-заглушка). До первого текста и без инструментов с последствиями\n'
       '          // ход переходит к следующему в плане, уведомление не шлём; иначе ход не\n'
       '          // повторяется, но сбой доступа открывает окно. Ошибка доступа, которую\n'
       '          // штатно повторяют (TRANSIENT_RE), — признак для решения после повтора\n'
       '          // (transientHit ниже).\n'
       '          const accessFailure = llm.isAccessFailure(ev.result, { isError: isErrorResult, apiStatus: ev.api_error_status });\n'
       '          // Сбой доступа, который штатно не повторяют (не TRANSIENT_RE: например\n'
       '          // 400 Arrearage), — тоже повод перейти сразу: иначе человеку ушёл бы сырой текст ошибки.\n'
       '          const fatalAccess = accessFailure && (llm.looksLikeCliRefusal(ev.result) || FATAL_RE.test(ev.result) ||\n'
       '            (isErrorResult && !TRANSIENT_RE.test(ev.result)));\n'
       '          const selectedFail = !!selected && runProvider === selected && isErrorResult &&\n'
       '            !TRANSIENT_RE.test(ev.result) && !(IMG_LIMIT_RE.test(ev.result) && useResume) &&\n'
       '            ev.result.trim() !== NO_RESP_PLACEHOLDER;\n'
       '          if (fatalAccess || selectedFail) {\n'
       '            if (fatalAccess) noteAccessFailure(runProvider, "отказ CLI");\n'
       '            if (llm.nextStep(plan, planStep, fallbackState) >= 0 &&\n'
       '                llm.mayAdvance({ failed: runProvider, selected, accessFailure: fatalAccess, sentAnyText: streamedAny, riskyToolUsed })) {\n'
       '              switchHit = true;\n'
       '              switchWhy = fatalAccess ? "отказ CLI" : "ошибка";\n'
       '              switchText = String(ev.result);\n'
       '              return;\n'
       '            }\n'
       '          }\n'
       '          if (accessFailure && isErrorResult) transientAccessLike = true;\n')
rep('resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, accessFailHit, transientAccessLike, sawResult, startedAt: runStartedAt });',
    'resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, switchHit, switchWhy, switchText, transientAccessLike, sawResult, startedAt: runStartedAt });')

# 8. Штатный повтор после временной ошибки тоже упал.
region('        if (provider === "claude" && r.transientAccessLike) {\n',
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
       '        // Повтор тоже упал. Сбой доступа открывает окно (у Claude) или «не\n'
       '        // отвечает» (у запасного); ход переходит к следующему в плане — при сбое\n'
       '        // доступа или если упал выбранный пользователем провайдер.\n'
       '        if (r.transientAccessLike) noteAccessFailure(provider, "ошибка доступа после повтора");\n'
       '        if (!preempted && !clientDisconnected &&\n'
       '            llm.mayAdvance({ failed: provider, selected, accessFailure: !!r.transientAccessLike, sentAnyText: streamedAny, riskyToolUsed })) {\n'
       '          const next = switchProvider(useResume, r.transientAccessLike ? "ошибка доступа после повтора" : "ошибка после повтора");\n'
       '          if (next) r = await next;\n'
       '        }\n'
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n')

# 9. Окна по итогам хода.
region('    // Окно запасного Qwen: успех Claude, начатый после открытия окна, его\n',
       '      else if (provider === "claude" && runOk) qwenBreaker.claudeSucceeded(r.startedAt);\n    }\n',
       '    // Окна по итогам хода: успех Claude, начатый после открытия окна, его\n'
       '    // закрывает; успех запасного снимает его «не отвечает»; исход аварийного\n'
       '    // хода — в статистику; ход, дошедший до запасных и закончившийся неудачей,\n'
       '    // закрывает окно Claude (Claude мог уже ожить). Не считаются ходы с\n'
       '    // неизвестным исходом — прерванный новым сообщением, брошенный бэкендом,\n'
       '    // упёршийся в потолок шагов.\n'
       '    if (!preempted && !clientDisconnected && failReason !== "max_turns") {\n'
       '      const runOk = !!r.sawResult && !r.switchHit && !r.transientHit;\n'
       '      if (provider === "claude") {\n'
       '        if (runOk) fallbackState.claudeSucceeded(r.startedAt);\n'
       '      } else {\n'
       '        if (runOk) fallbackState.markUp(provider);\n'
       '        if (usedFallback) fallbackState.recordOutcome(provider, runOk);\n'
       '      }\n'
       '      if (!runOk && reachedFallback) fallbackState.closeClaudeWindow();\n'
       '    }\n')

# 10. /health.
rep('  res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), qwen: { enabled: !!qwen.readQwenConfig(), ...qwenBreaker.stats() } });\n',
    '  // fallback — окна и исходы по всем запасным; qwen — прежнее поле для монитора\n'
    '  // бэкенда, пока не выкачен новый (llm-fallback.mjs, legacyQwenHealth).\n'
    '  const fb = fallbackState.stats(llm.readProviderConfigs());\n'
    '  res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime(), fallback: fb, qwen: llm.legacyQwenHealth(fb) });\n')

# 11. От врезки Qwen ничего не осталось.
for leftover in ("qwenBreaker", "qwenCfg", "qwenForced", "accessFailHit", "fallbackToQwen", "qwenWindowOnly"):
    if leftover in s:
        sys.exit(f"осталось {leftover!r} — врезка неполна, ничего не записано")
if re.search(r"\bqwen\.[A-Za-z]", s):
    sys.exit("остались вызовы qwen.* — врезка неполна, ничего не записано")

open(path, "w", encoding="utf-8").write(s)
print("ok:", path)
