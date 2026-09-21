/**
 * Кто пишет в колонку баланса — поиск по ЦЕЛИ, а не по форме арифметики.
 *
 * ═══ ПОЧЕМУ ПРЕЖНЕЕ ВЫРАЖЕНИЕ НЕ РАБОТАЛО ═══
 *
 * Сторож искал `/tokens\s*=\s*tokens\s*[-+]/` — то есть ровно одно написание
 * правой части. Правых частей бесконечно много, и на 21.09.2026 в репозитории
 * лежало ПЯТЬ обходов, которых это выражение не видело:
 *
 *   referral.service.ts   ×2   tokens = COALESCE(tokens,0) + $1
 *   tg-billing.service.ts       tokens = GREATEST(0, tokens - $1)
 *   token-accounting.service.ts tokens = GREATEST(0, tokens - $1)
 *   rent.service.ts             tokens = a.tokens - $2      (через алиас)
 *
 * Достаточно обернуть приращение в любую функцию, подставить алиас таблицы или
 * посчитать значение в переменной (`SET tokens = v_new_balance` — так делает
 * сама add_user_tokens), и выражение молчит. Оно ловило одну запись, а не
 * класс, и защита существовала на бумаге: четыре из пяти обходов написаны
 * ПОСЛЕ того, как сторож появился.
 *
 * ═══ ЧТО ИЩЕТСЯ ВМЕСТО ЭТОГО ═══
 *
 * Не «как считают», а «куда кладут»: присваивание колонке `tokens` в SET-списке
 * UPDATE по таблице `ai_profiles_consolidated`. Правая часть не разбирается
 * вовсе — именно в ней живёт бесконечная вариативность. Левая часть конечна:
 * таблица одна, колонка одна, и обойти её, продолжая менять баланс, нельзя.
 *
 * Разбор идёт по тексту, а не построчно: `UPDATE` и `SET` регулярно стоят на
 * разных строках (rent.service, миграции). Окно от `UPDATE <таблица>` до
 * первого `WHERE`/`RETURNING`/`;` — это и есть SET-список; `tokens` в условии
 * (`WHERE tokens >= $1`) под него не попадает и ложной тревоги не даёт.
 *
 * ═══ ЧТО ЭТИМ ВСЁ ЕЩЁ НЕ ЛОВИТСЯ ═══
 *
 * Текстовый поиск не видит SQL, собранный из кусков или пришедший строкой
 * извне, вызов из psql руками, триггер соседней таблицы. Честный предел: это
 * сторож ИСХОДНИКОВ, он отвечает на вопрос «кто в этом репозитории написал
 * такой оператор», а не «кто на самом деле изменил баланс».
 *
 * На второй вопрос текстом ответить нельзя в принципе — его задают БАЗЕ.
 * Сделано в referral/referral-accounting.integration.spec.ts: на
 * ai_profiles_consolidated вешается триггер, который записывает КАЖДОЕ
 * изменение tokens, кем бы оно ни было сделано, и сверяется с token_transactions.
 * Триггер не читает текст запроса и написанием его не обмануть.
 *
 * Окончательный ответ — забрать у приложения право писать в колонку
 * (`REVOKE UPDATE (tokens) ON ai_profiles_consolidated`, процедуры
 * SECURITY DEFINER под владельцем). Тогда «кто пишет» решает Postgres, а не
 * сторож. Цена на сегодня — четыре живых прямых писателя в ALLOWED ниже:
 * выкатить REVOKE, не переведя их, значит уронить списание речи, аренду
 * продуктов и оба запасных пути. Поэтому здесь записано, чего это стоит, а не
 * сделано наспех.
 */

/** Таблица, в которой лежит баланс. */
const BALANCE_TABLE = 'ai_profiles_consolidated';

/** `UPDATE [ONLY] [public.]ai_profiles_consolidated [алиас]` */
const UPDATE_BALANCE_TABLE = new RegExp(
  String.raw`\bUPDATE\s+(?:ONLY\s+)?(?:public\.)?` + BALANCE_TABLE + String.raw`\b`,
  'gi',
);

/** Конец SET-списка: дальше начинается условие или следующий оператор. */
const END_OF_SET_LIST = /\bWHERE\b|\bRETURNING\b|;|`/i;

/** Присваивание колонке tokens. `==`/`>=` исключены — это сравнения. */
const ASSIGNS_TOKENS = /(?:^|[\s,(])tokens\s*=(?!=)/i;

/** Сколько текста после UPDATE считать потенциальным SET-списком. */
const WINDOW = 600;

export interface BalanceWrite {
  /** Номер строки, на которой стоит сам UPDATE (1-based). */
  line: number;
  /** Найденный SET-список — чтобы в отчёте было видно, за что поймали. */
  snippet: string;
}

/**
 * Убрать комментарии, СОХРАНИВ длину текста, — номера строк после этого всё
 * ещё верны. Без этого сторож ловит сам разбор прошлых инцидентов: в
 * rent.service.ts и в шапке tokens/migrations/001 прямые UPDATE выписаны
 * дословно, в комментарии, как пример того, чего делать нельзя.
 */
export function blankComments(source: string): string {
  const out = source.split('');
  let i = 0;
  const blankTo = (end: number) => {
    for (let k = i; k < end; k++) if (out[k] !== '\n') out[k] = ' ';
    i = end;
  };
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      blankTo(end === -1 ? source.length : end + 2);
      continue;
    }
    // `//` — но не в `https://`. `--` — только SQL-комментарий, то есть с
    // пробелом или концом строки следом (иначе это декремент в TS).
    const isSlash = two === '//' && source[i - 1] !== ':';
    const isDash = two === '--' && /[\s\r\n]|$/.test(source[i + 2] ?? '\n');
    if (isSlash || isDash) {
      const nl = source.indexOf('\n', i);
      blankTo(nl === -1 ? source.length : nl);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Все места в тексте, где UPDATE по таблице баланса присваивает колонку tokens.
 * Принимает и TypeScript, и SQL: разбирается оператор, а не язык вокруг него.
 */
export function findBalanceColumnWrites(source: string): BalanceWrite[] {
  const code = blankComments(source);
  const found: BalanceWrite[] = [];

  UPDATE_BALANCE_TABLE.lastIndex = 0;
  for (let m = UPDATE_BALANCE_TABLE.exec(code); m; m = UPDATE_BALANCE_TABLE.exec(code)) {
    const window = code.slice(m.index, m.index + WINDOW);
    const end = window.search(END_OF_SET_LIST);
    const setList = end === -1 ? window : window.slice(0, end);

    // Без SET это не присваивание (например, `UPDATE` внутри строки-описания).
    if (!/\bSET\b/i.test(setList)) continue;
    const afterSet = setList.slice(setList.search(/\bSET\b/i));
    if (!ASSIGNS_TOKENS.test(afterSet)) continue;

    found.push({
      line: code.slice(0, m.index).split('\n').length,
      snippet: setList.replace(/\s+/g, ' ').trim().slice(0, 120),
    });
  }
  return found;
}
