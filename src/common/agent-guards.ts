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

// ─────────────────────────────────────────────────────────────────────────
// НЕЙТРАЛИЗАЦИЯ @-УПОМИНАНИЙ (безопасность, 25.09.2026)
// ─────────────────────────────────────────────────────────────────────────
// И CLI, и Agent SDK разворачивают `@<путь>` в тексте промпта НА ЭТАПЕ СБОРКИ:
// содержимое файла инлайнится в промпт ДО модели, минуя --tools/--allowedTools/cwd
// (проверено: с `--tools "" --allowedTools ""` и с `tools: []` файл @/abs/outside
// всё равно попадал в ответ при нуле tool-call). Значит любой недоверенный текст,
// где встречается `@/home/dvolkov/spirits_back/.env`, мог утечь через Машу/TG/
// поиск/поддержку — запирание тулов этого НЕ закрывает.
//
// Триггер разворота у CLI — `@`, стоящий в начале строки/текста или после
// пробела/CJK-пунктуации. Ломаем его, вставляя U+2060 WORD JOINER прямо перед
// таким `@`: разделителя между «границей» и `@` больше нет, упоминание не
// разворачивается, а сам текст читается человеком без видимых артефактов.
//
// Почему именно U+2060, а НЕ U+FEFF: в JS-регулярках `\s` включает U+FEFF, но НЕ
// включает U+2060. Если заменить на U+FEFF, любая проверка вида `(^|\s)@`
// снова начнёт срабатывать (перед `@` окажется «пробельный» символ) — защита
// молча испарится. Тест это фиксирует.
//
// Реальные email не трогаем: если перед `@` стоит символ локальной части адреса
// ([\p{L}\p{N}._%+-]), это `user@example.com`, а не путь — CLI такое и так не
// разворачивает, а нам важно не портить адреса в тексте.

/** U+2060 WORD JOINER: не-пробельный (в отличие от U+FEFF) нулевой ширины разделитель. */
export const WORD_JOINER = '⁠';

/** Символ локальной части email — перед таким `@` разворота у CLI нет, не трогаем. */
const EMAIL_LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;

/**
 * Обезвреживает @-упоминания в НЕДОВЕРЕННОМ тексте: перед каждым `@`, который
 * стоит в начале или после НЕ-email-символа, вставляет U+2060. Идемпотентна
 * (если перед `@` уже U+2060 — не дублирует). Email остаются байт-в-байт.
 */
export function neutralizeAtMentions(text: string): string {
  if (!text || text.indexOf('@') === -1) return text;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '@') {
      const prev = i > 0 ? text[i - 1] : '';
      // Уже обезврежено на прошлом проходе — не дублируем.
      if (prev === WORD_JOINER) { out += c; continue; }
      // Похоже на email (перед @ символ локальной части) — оставляем как есть.
      if (prev && EMAIL_LOCAL_CHAR.test(prev)) { out += c; continue; }
      out += WORD_JOINER + c;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Убирает U+2060 из текста. Нужен на ВЫХОДЕ модели: joiner никогда не должен
 * доехать до пользователя (например, @-хендлы Telegram в ответе не должны
 * рваться невидимым символом).
 */
export function stripWordJoiner(text: string): string {
  return typeof text === 'string' ? text.replace(/⁠/g, '') : text;
}

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
