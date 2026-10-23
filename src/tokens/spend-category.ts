/**
 * Категории расхода для сводки «Расход по месяцам».
 *
 * Категория определяется при ЧТЕНИИ журнала — по подписи и метаданным строки
 * (решение владельца 23.10.2026, спека
 * docs/superpowers/specs/2026-10-23-spending-summary-design.md). Код, который
 * списывает токены, не трогаем: таких мест восемь, и там же работают другие
 * сессии.
 *
 * Правила записаны ОДИН раз — в SPEND_RULES. Из них строятся и SQL-выражение
 * для группировки в базе (spendCategorySql), и функция для тестов
 * (classifySpend); spending.integration.spec.ts сверяет на живом Postgres, что
 * оба дают одно и то же.
 *
 * Переименуют подпись списания — такие строки уйдут в 'other', итоги при этом
 * верны, поедет только раскладка. Но НОВЫЙ путь списания, который пишет
 * строку без подписи (description = null), молча попадёт не в 'other', а в
 * 'replies' — так работает правило replies ниже, и образцы в
 * spend-category.samples.ts этого не ловят (там нет живого второго пути без
 * подписи, кроме уже известного tts).
 */
export type SpendCategory =
  | 'replies'
  | 'calls'
  | 'images'
  | 'video'
  | 'voice'
  | 'tg_bots'
  | 'products'
  | 'other';

export interface SpendRule {
  category: Exclude<SpendCategory, 'other'>;
  /** Ключ metadata; строка относится сюда, если значение не null. */
  metadataKey?: string;
  /** Строка без подписи тоже относится сюда. */
  nullDescription?: boolean;
  /** Подпись совпадает целиком. */
  equals?: string[];
  /** Подпись начинается с. */
  prefixes?: string[];
}

/** Порядок важен: выигрывает первое совпавшее правило. */
export const SPEND_RULES: readonly SpendRule[] = [
  // Звонок подписан «Ответ ассистента…», отличает его только callId — поэтому первым.
  { category: 'calls', metadataKey: 'callId' },
  // До вечера 10.08.2026 ответы писались без подписи; картинки, видео и TG тогда шли мимо журнала.
  //
  // POST /webhook/tts (src/voice/tts.controller.ts) по сей день списывает
  // через deductTokens без description — такая строка попадёт сюда же, в
  // replies, а не в voice. На 23.10.2026 живых строк от этого пути нет
  // (проверено по пользователям после 11.08.2026) и известных вызывающих
  // тоже нет. Однострочный фикс — передать description: 'Синтез речи' в
  // deductTokens там же — оставлен на решение владельца: это чужой код
  // списания, трогать который этой задачей не просили.
  { category: 'replies', prefixes: ['Ответ ассистента'], nullDescription: true },
  { category: 'images', equals: ['image'] },
  { category: 'video', equals: ['Генерация видео'] },
  { category: 'voice', equals: ['Озвучка ответа', 'Синтез речи'] },
  { category: 'tg_bots', equals: ['tg-bot'] },
  { category: 'products', prefixes: ['product turn ', 'Аренда продукта'] },
];

export function classifySpend(
  description: string | null | undefined,
  metadata?: Record<string, unknown> | null,
): SpendCategory {
  for (const rule of SPEND_RULES) {
    if (rule.metadataKey && metadata && metadata[rule.metadataKey] != null) return rule.category;
    if (rule.nullDescription && description == null) return rule.category;
    if (description != null) {
      if (rule.equals?.includes(description)) return rule.category;
      if (rule.prefixes?.some((p) => description.startsWith(p))) return rule.category;
    }
  }
  return 'other';
}

/** Строковый литерал SQL. Правила — константы кода, но кавычку всё равно экранируем. */
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * CASE-выражение категории по переданным правилам. Колонки передаются, чтобы
 * выражение работало и с алиасом таблицы.
 *
 * Правило без единого условия (пустой SpendRule — опечатка, забытый
 * metadataKey/equals/prefixes) даёт `WHEN THEN …` — синтаксическую ошибку в
 * SQL, но валидный JS-код, который в classifySpend просто никогда не
 * сработает. Бросаем здесь, а не только в classifySpend, чтобы сломанное
 * правило ловилось юнит-тестом, а не падением прод-запроса.
 */
export function buildCategorySql(rules: readonly SpendRule[], descriptionCol: string, metadataCol: string): string {
  const branches = rules.map((rule) => {
    const conds: string[] = [];
    if (rule.metadataKey) conds.push(`(${metadataCol} ->> ${lit(rule.metadataKey)}) IS NOT NULL`);
    if (rule.nullDescription) conds.push(`${descriptionCol} IS NULL`);
    for (const e of rule.equals ?? []) conds.push(`${descriptionCol} = ${lit(e)}`);
    for (const p of rule.prefixes ?? []) conds.push(`starts_with(${descriptionCol}, ${lit(p)})`);
    if (conds.length === 0) {
      throw new Error(`spend-category: правило '${rule.category}' не задаёт ни одного условия`);
    }
    return `WHEN ${conds.join(' OR ')} THEN ${lit(rule.category)}`;
  });
  return `CASE ${branches.join(' ')} ELSE 'other' END`;
}

/** Обёртка над buildCategorySql для правил прода — SPEND_RULES. */
export function spendCategorySql(descriptionCol = 'description', metadataCol = 'metadata'): string {
  return buildCategorySql(SPEND_RULES, descriptionCol, metadataCol);
}
