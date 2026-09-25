// src/common/agent-guards.ts
//
// Стражи для Agent SDK `canUseTool`. Вынесены в отдельный модуль без зависимостей
// от Nest, чтобы их можно было покрыть юнит-тестами напрямую, без поднятия
// контекста и без сети.
//
// ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО (безопасность, 25.09.2026)
// ──────────────────────────────────────────────
// Вызовы Agent SDK на проде идут под тем же OS-пользователем, что владеет
// ~/spirits_back/.env (JWT_SECRET, доступы к БД). Дочерний claude наследует
// пользователя и cwd. Если модели дать файловый тул без ограничения каталога,
// содержимое, пришедшее от пользователя (загруженный файл, реплика), может
// заставить её прочитать .env, и результат уедет в ответ/профиль. Поэтому там,
// где по задаче нужен ТОЛЬКО разбор загруженного файла, мы:
//   1) даём один тул Read (`tools: ['Read']`), не bypass, а `permissionMode: 'default'`;
//   2) на каждый вызов Read проверяем путь этим стражем и разрешаем чтение
//      исключительно внутри временного каталога загрузки.
//
// ПОЧЕМУ realpath, А НЕ startsWith(resolve(...))
// ─────────────────────────────────────────────
// На macOS os.tmpdir() = /var/folders/... симлинчен, а /tmp → /private/tmp:
// модель передавала `/tmp/...`, тогда как cwd был `/private/tmp/...`, и наивное
// `path.resolve(cwd, file).startsWith(cwd)` пропускало бы разошедшиеся по алиасу
// пути ЛИБО ложно отбивало легитимные. Сравниваем канонические пути через
// fs.realpathSync — он разворачивает и `..`, и симлинки. Симлинк ВНУТРИ каталога,
// указывающий наружу, разворачивается в наружную цель и отклоняется. Несуществующий
// путь realpathSync бросает — трактуем как отказ (читать нечего, а промах наружу
// маскировать нельзя).

import * as fs from 'fs';
import * as path from 'path';

/** Отказ по умолчанию: короткое машинно-стабильное сообщение для модели. */
export const AGENT_GUARD_DENY_MESSAGE =
  'Разрешено читать только файл(ы) из рабочего каталога этого запроса.';

/**
 * Канонический путь `target`, если он лежит ВНУТРИ `rootDir` (или равен ему),
 * иначе null. Оба конца приводятся к realpath: символические ссылки и `..`
 * развёрнуты. Любая ошибка (несуществующий путь, недоступный каталог) → null:
 * страж обязан падать в отказ, а не пропускать сомнительное.
 *
 * Экспортируется отдельно, чтобы тестировать саму проверку каталога без обёртки
 * над протоколом разрешений SDK.
 */
export function resolveWithin(rootDir: string, target: string): string | null {
  if (!rootDir || !target || typeof target !== 'string') return null;
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    // Корень обязан существовать: если его нет — доверять нечему.
    return null;
  }
  // Относительный путь считаем от rootDir (модель нередко присылает голое имя
  // файла). Абсолютный остаётся как есть.
  const abs = path.isAbsolute(target) ? target : path.resolve(realRoot, target);
  let realTarget: string;
  try {
    realTarget = fs.realpathSync(abs);
  } catch {
    // Файла нет (или недоступен) → отказ. Несуществующий путь наружу — тоже отказ.
    return null;
  }
  if (realTarget === realRoot) return realTarget;
  // Граница именно по разделителю каталогов: без него `/a/bc` прошёл бы под
  // корень `/a/b`.
  if (realTarget.startsWith(realRoot + path.sep)) return realTarget;
  return null;
}

/**
 * `canUseTool`-страж для Agent SDK: пропускает ТОЛЬКО чтение (`Read`) файла,
 * канонический путь которого лежит внутри `rootDir`. Всё остальное — иной тул
 * или Read наружу/в никуда — отклоняется с сообщением.
 *
 * Сигнатура совместима с типом CanUseTool из '@anthropic-ai/claude-agent-sdk'
 * (toolName, input, options) => Promise<PermissionResult>. Тип не импортируем,
 * чтобы модуль оставался свободным от SDK и легко тестировался; форму ответа
 * ('allow'|'deny') SDK принимает структурно.
 */
export function makeReadWithinDirGuard(rootDir: string) {
  return async function canUseTool(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > {
    if (toolName !== 'Read') {
      return { behavior: 'deny', message: AGENT_GUARD_DENY_MESSAGE };
    }
    // У тула Read путь лежит в file_path. Иных форм у него нет; отсутствие поля —
    // отказ, а не «разрешить на всякий случай».
    const filePath = input?.file_path;
    if (typeof filePath !== 'string' || !filePath) {
      return { behavior: 'deny', message: AGENT_GUARD_DENY_MESSAGE };
    }
    const within = resolveWithin(rootDir, filePath);
    if (!within) {
      return { behavior: 'deny', message: AGENT_GUARD_DENY_MESSAGE };
    }
    // Возвращаем канонизированный путь: пусть тул читает ровно то, что мы
    // проверили, а не исходную строку с алиасом/симлинком.
    return { behavior: 'allow', updatedInput: { ...input, file_path: within } };
  };
}
