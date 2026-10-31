#!/usr/bin/env python3
"""Врезка цепочки запасных (Claude → Qwen → Kimi) и выбора Kimi в relay
server.mjs — поверх врезки Qwen (qwen-patch.py). Spec spirits_back
docs/superpowers/specs/2026-10-31-kimi-provider-design.md.
Одна и та же для копии relay-agent/ в main и живого релея: якоря — текст
врезки Qwen, одинаковый в обоих. Каждый якорь обязан встретиться ровно один
раз, иначе — выход без записи.
Запуск: python3 llm-fallback-patch.py <путь к server.mjs>"""
import hashlib
import os
import re
import sys

if len(sys.argv) != 2:
    sys.exit("usage: python3 llm-fallback-patch.py <путь к server.mjs>")
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


def region(start, end, new, sha):
    """Заменить кусок от начала start до конца end; оба — ровно по разу.
    sha — ожидаемый sha256 (hex) заменяемого куска s[i:j+len(end)] (utf-8):
    якоря могли совпасть, а текст МЕЖДУ ними на живом релее мог быть правлен
    руками (там git без remote — такую правку не увидит ни один diff).
    Несовпадение — выход без записи, скрипт не трогает файл."""
    global s
    for a in (start, end):
        n = s.count(a)
        if n != 1:
            sys.exit(f"якорь встречается {n} раз(а), ожидался 1: {a[:90]!r}")
    i = s.index(start)
    j = s.index(end)
    if j < i:
        sys.exit(f"конец раньше начала: {end[:90]!r}")
    chunk = s[i:j + len(end)]
    got = hashlib.sha256(chunk.encode("utf-8")).hexdigest()
    if got != sha:
        sys.exit(
            "кусок между якорями отличается от ожидаемого — ручная правка на "
            f"релее? сверь и обнови скрипт: start={start[:60]!r}, sha256={got}"
        )
    s = s[:i] + new + s[j + len(end):]


def need(snippet):
    if snippet not in s:
        sys.exit(f"нет объявления, на которое опирается врезка: {snippet!r}")


# 0. Объявления, которые читает врезка. Ошибку области видимости node --check не
# ловит, а handleEvent и внешний ход глотают исключения — ReferenceError молча
# ломал бы каждый ход. Поэтому — проверка до записи.
for decl in ('const sessionId = ', 'const args = [', 'const reqModel = ', 'let streamedAny = ',
             'let clientDisconnected = ', 'const notice = ', 'const FATAL_RE = ', 'const fatalHint = ',
             'const TRANSIENT_RE = ', 'const IMG_LIMIT_RE = ', 'const NO_RESP_PLACEHOLDER = ',
             'let taleridWriteUsed = '):
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
       'const fallbackState = llm.createFallbackState();\n',
       "a0518d363e9130dff104ea2cfaee3126554a0433c42ed50c5c52b069b75b46ae")

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
       '  let riskyToolUsed = false;\n',
       "5d611b4f2dfec1790462eccba349913a2d2e2ab28ef9e83d8d4bad22eb4d12e8")

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
       '  // итогам хода. detail — в журнал рядом с причиной; только безопасное\n'
       '  // (llm.safeErrorDetail: статус и строка диагностики CLI), не текст ошибки.\n'
       '  const switchProvider = (useResume, why, detail = "") => {\n'
       '    const i = llm.nextStep(plan, planStep, fallbackState);\n'
       '    if (i < 0) return null;\n'
       '    const from = provider;\n'
       '    if (llm.isEmergency(from, selected)) fallbackState.recordOutcome(from, false);\n'
       '    planStep = i;\n'
       '    provider = plan[i];\n'
       '    usedFallback = llm.isEmergency(provider, selected);\n'
       '    if (usedFallback) reachedFallback = true;\n'
       '    const model = provider === "claude" ? reqModel : llm.modelFor(reqModel, llmCfgs[provider].models);\n'
       '    console.warn("[llm] " + sessionId + ": " + llm.PROVIDER_LABELS[from] + " (" + why + (detail ? ": " + detail : "") + ") → " + llm.PROVIDER_LABELS[provider] + " " + model);\n'
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
       '    const next = switchProvider(useResume, r.switchWhy, r.switchDetail);\n'
       '    if (next) return next;\n'
       '    const fatal = FATAL_RE.test(r.switchText);\n'
       '    notice(fatal ? fatalHint(r.switchText) : "_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", fatal ? "cli_fatal" : "transient");\n'
       '    return r;\n'
       '  }\n',
       "08d1fdc148f1a81f363c2f41d65b104fbf48fb98256878bed4f0f1dd6f7865c0")

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
    '      // Текст сбоя — только для FATAL_RE/fatalHint в runOnce, в журнал не идёт.\n'
    '      let switchText = "";\n'
    '      // Для журнала перехода — только безопасное (llm.safeErrorDetail).\n'
    '      let switchDetail = "";\n'
    '      // Пришло хоть одно событие type:"result" от этого запуска (gotResult ниже,\n'
    '      // child.on("close", …)) — даже без текста: выбранный пользователем\n'
    '      // провайдер, вышедший без единого result (ненулевой код, кривой адрес),\n'
    '      // уступает обычному пути так же, как при любом другом его сбое.\n'
    '      let gotResult = false;\n'
    '      // Пришёл result с ошибкой, но без текста (error_during_execution: причина —\n'
    '      // в errors[], поля result нет; llm.isErrorWithoutText) — у выбранного тоже\n'
    '      // повод уступить ход (child.on("close", …)).\n'
    '      let errorNoText = false;\n'
    '      // Её причина (llm.errorsText: errors[] одной строкой) — в switchText: его\n'
    '      // читают только FATAL_RE и fatalHint в runOnce, человеку уходит готовый текст.\n'
    '      let errorNoTextWhy = "";\n'
    '      // А в журнал — только безопасное (llm.safeErrorDetail), в switchDetail.\n'
    '      let errorNoTextDetail = "";\n'
    '      let transientAccessLike = false;\n'
    '      let sawResult = false;\n')
rep('              if (!qwen.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n',
    '              if (!llm.SIDE_EFFECT_FREE_TOOLS.has(block.name || "")) riskyToolUsed = true;\n')
rep('        if (ev.type === "result") {\n          // Потолок шагов.',
    '        if (ev.type === "result") {\n'
    '          gotResult = true;\n'
    '          // Потолок шагов.')
# Проверка ошибки без текста — в конце того же блока, после учёта стоимости,
# потолка шагов и usage: окажутся на релее server.mjs и llm-fallback.mjs разных
# версий — TypeError (его молча глотает catch вокруг handleEvent) не сорвёт учёт.
rep('          usageTotals.webFetch += n(st.web_fetch_requests);\n        }\n',
    '          usageTotals.webFetch += n(st.web_fetch_requests);\n'
    '          // Ошибку без текста ветка `result && ev.result` ниже не видит — у\n'
    '          // выбранного это повод уступить ход в close. Последней в блоке: если\n'
    '          // llm-fallback.mjs окажется другой версии, TypeError (его глотает catch\n'
    '          // вокруг handleEvent) не сорвёт учёт стоимости, потолка шагов и usage.\n'
    '          if (llm.isErrorWithoutText(ev)) {\n'
    '            errorNoText = true;\n'
    '            errorNoTextWhy = llm.errorsText(ev);\n'
    '            errorNoTextDetail = llm.safeErrorDetail(ev);\n'
    '          }\n'
    '        }\n')

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
       '          // Сбой доступа, который штатно не повторяют (403/Forbidden/Access denied/\n'
       '          // Arrearage — llm.isNonRetryAccess), — тоже повод перейти сразу: иначе\n'
       '          // человеку ушёл бы сырой текст ошибки вместо вежливого уведомления.\n'
       '          const fatalAccess = accessFailure && (llm.looksLikeCliRefusal(ev.result) || FATAL_RE.test(ev.result) ||\n'
       '            llm.isNonRetryAccess(ev.result));\n'
       '          // max_turns — потолок шагов, а не сбой выбранного провайдера.\n'
       '          const selectedFail = !!selected && runProvider === selected && isErrorResult && !maxTurnsHit &&\n'
       '            !TRANSIENT_RE.test(ev.result) && !(IMG_LIMIT_RE.test(ev.result) && useResume) &&\n'
       '            ev.result.trim() !== NO_RESP_PLACEHOLDER;\n'
       '          if (fatalAccess || selectedFail) {\n'
       '            if (fatalAccess) noteAccessFailure(runProvider, "отказ CLI");\n'
       '            if (llm.nextStep(plan, planStep, fallbackState) >= 0 &&\n'
       '                llm.mayAdvance({ failed: runProvider, selected, accessFailure: fatalAccess, sentAnyText: streamedAny, riskyToolUsed })) {\n'
       '              switchHit = true;\n'
       '              switchWhy = fatalAccess ? "отказ CLI" : "ошибка";\n'
       '              switchText = String(ev.result);\n'
       '              switchDetail = llm.safeErrorDetail(ev);\n'
       '              return;\n'
       '            }\n'
       '            // Перейти некуда или переигровка запрещена (текст уже шёл, инструмент с\n'
       '            // последствиями) — fatalAccess всё равно нельзя отдавать сырым текстом\n'
       '            // (403/Arrearage и т.п. не обязаны совпасть с FATAL_RE или TRANSIENT_RE —\n'
       '            // без этого возврата ушли бы прямиком к записи result ниже).\n'
       '            if (fatalAccess) {\n'
       '              if (FATAL_RE.test(ev.result)) notice(fatalHint(ev.result), "cli_fatal");\n'
       '              else if (taleridWriteUsed) notice("_(связь с моделью прервалась после действия — проверьте результат, возможно всё прошло; при необходимости повторите)_", "transient_after_write");\n'
       '              else if (streamedAny) notice("\\n\\n_(связь с моделью прервалась, ответ оборван. Токены за этот ход не списаны — повторите вопрос.)_", "transient_after_partial");\n'
       '              else notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n'
       '              return;\n'
       '            }\n'
       '          }\n'
       '          if (accessFailure && isErrorResult) transientAccessLike = true;\n',
       "198af2cc3fa956b658e321da7f6d00e892076da4ed4cd2c1d8e1e7d71a354efa")
rep('resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, accessFailHit, transientAccessLike, sawResult, startedAt: runStartedAt });',
    '// Выбранный пользователем вышел без result (ненулевой код, кривой адрес) или\n'
    '        // с ошибкой без текста (error_during_execution) — уступает обычному пути, как\n'
    '        // и любой другой его сбой; staleResumeHit и прерванный/брошенный ход — свои\n'
    '        // ветки, здесь не дублируем.\n'
    '        if (runProvider === selected && selected && (!gotResult || errorNoText) && !staleResumeHit && !preempted && !clientDisconnected &&\n'
    '            llm.nextStep(plan, planStep, fallbackState) >= 0 &&\n'
    '            llm.mayAdvance({ failed: runProvider, selected, accessFailure: false, sentAnyText: streamedAny, riskyToolUsed })) {\n'
    '          switchHit = true;\n'
    '          switchWhy = gotResult ? "ошибка без текста" : "нет ответа";\n'
    '          switchText = gotResult ? errorNoTextWhy : "";\n'
    '          switchDetail = gotResult ? errorNoTextDetail : "";\n'
    '        }\n'
    '        resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit, switchHit, switchWhy, switchText, switchDetail, transientAccessLike, sawResult, startedAt: runStartedAt });')

# 7b. Комментарий sawResult остался про Qwen — запасных теперь два.
rep('          // Успех запуска — для окна запасного Qwen: ни ошибки, ни сбоя доступа.\n',
    '          // Успех запуска — для окон запасного пути: ни ошибки, ни сбоя доступа.\n')

# 8. Штатный повтор после временной ошибки тоже упал — цепочка идёт до конца
# плана, а не только на один шаг (529×2 у Claude → переход на Qwen → у Qwen
# кончилась квота — тоже transient — должен дойти до Kimi, а не замолчать на Qwen).
region('        if (provider === "claude" && r.transientAccessLike) {\n',
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
       '        // Повтор тоже упал. Сбой доступа открывает окно (у Claude) или «не отвечает»\n'
       '        // (у запасного); ход идёт к следующему в плане — при сбое доступа или если\n'
       '        // упал выбранный пользователем провайдер — пока план не кончится.\n'
       '        while (r.transientHit) {\n'
       '          if (r.transientAccessLike) noteAccessFailure(provider, "ошибка доступа после повтора");\n'
       '          if (preempted || clientDisconnected ||\n'
       '              !llm.mayAdvance({ failed: provider, selected, accessFailure: !!r.transientAccessLike, sentAnyText: streamedAny, riskyToolUsed })) break;\n'
       '          const next = switchProvider(useResume, r.transientAccessLike ? "ошибка доступа после повтора" : "ошибка после повтора");\n'
       '          if (!next) break;\n'
       '          r = await next;\n'
       '        }\n'
       '        if (r.transientHit) notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");\n',
       "d942a7bf211684be91933f35165a678ec06b198ecb3f8a2a07a15d394dfd6b96")

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
       '    }\n',
       "d0e56846f200ea038d79ff93fe2ed4551d6d6d308a4ee25bdc39c78890ca8e98")

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

# Запись атомарно: временный файл рядом + os.replace (на одном ФС — атомарная
# подмена, не оставит обрезанный server.mjs, если процесс прервут посередине).
tmp = path + ".tmp"
with open(tmp, "w", encoding="utf-8") as f:
    f.write(s)
os.replace(tmp, path)
print("ok:", path)
