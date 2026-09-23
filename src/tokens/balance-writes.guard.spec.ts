/**
 * Баланс меняется только через add_user_tokens / consume_user_tokens.
 *
 * Обе процедуры берут строку под FOR UPDATE и пишут строку в
 * token_transactions. Прямой UPDATE колонки не делает ни того, ни другого, и
 * каждый такой обход стоил нам по инциденту:
 *
 *   08.08.2026 — параллельные списания читали один и тот же достаточный
 *   баланс, пользователь ушёл в −7 363.
 *
 *   20.08.2026 — сверка показала: у 10 пользователей баланс расходится с
 *   реестром на 333 тыс. токенов. Деньги не потерялись, но «История
 *   пополнений» и прогноз расхода видели неполную картину: возврат из
 *   поддержки, видео, речь и SMM вели свои приватные реестры.
 *
 *   21.09.2026 — реферальная программа начислила 320 тыс. токенов 16 людям
 *   мимо реестра. Сторож на этот момент СУЩЕСТВОВАЛ УЖЕ ПОЛТОРА МЕСЯЦА и
 *   молчал: он искал `tokens = tokens ±`, а в реферальном коде стояло
 *   `tokens = COALESCE(tokens,0) + $1`. Вместе с ним выражение не видело ещё
 *   трёх обходов. Разбор и новый способ поиска — в balance-writes.guard.ts.
 *
 * Поэтому сторож на исходниках, а не на поведении: поведенческий тест ловит
 * только те места, которые кто-то вспомнил покрыть, а обход добавляют как раз
 * не вспомнив.
 *
 * ЭТОТ ФАЙЛ — ПОЛОВИНА ЗАЩИТЫ. Вторая половина спрашивает у базы, а не у
 * текста: referral/referral-accounting.integration.spec.ts вешает на
 * ai_profiles_consolidated триггер, ловит каждое изменение tokens независимо от
 * написания запроса и сверяет его с реестром. Держать нужно обе — текстовая
 * ловит обход, который никто не покрыл тестом; триггерная ловит обход, который
 * текстом не виден вовсе.
 *
 * Если прямой UPDATE действительно нужен, он обязан лежать в ALLOWED с
 * объяснением, почему процедура не подходит, и САМ писать строку в
 * token_transactions — это проверяется ниже, и проверяется по коду, а не по
 * упоминанию в комментарии.
 */
import * as fs from 'fs';
import * as path from 'path';
import { blankComments, findBalanceColumnWrites } from './balance-writes.guard';

/**
 * Осознанные исключения: файл → сколько прямых записей и почему. КАЖДАЯ обязана
 * сама писать строку в token_transactions — это проверяется ниже.
 *
 * Счётчик, а не просто имя файла: иначе одна разрешённая запись открывает файлу
 * право на вторую, неразрешённую, и та проезжает молча.
 */
const ALLOWED: Record<string, { writes: number; why: string }> = {
  'base/migrations/001_core_schema.sql': {
    writes: 2,
    why:
      'Снимок схемы прода. Внутри — тела самих add_user_tokens и ' +
      'consume_user_tokens: это и есть те два разрешённых писателя, ради которых ' +
      'существует сторож. Файл не место для правок — он катается один раз на ' +
      'пустой базе; новое определение процедуры кладётся в tokens/migrations.',
  },
  'tokens/migrations/001_add_user_tokens_lock.sql': {
    writes: 1,
    why:
      'Новое определение add_user_tokens (чтение баланса под FOR UPDATE). ' +
      'Разрешённый писатель по определению.',
  },
  'speech/speech.service.ts': {
    writes: 1,
    why:
      'Условное списание `WHERE tokens >= $1`: процедура при нехватке списывает ' +
      'остаток, а синтез речи должен получить отказ целиком. Строку в ' +
      'token_transactions пишет сам, в той же транзакции.',
  },
  'products/rent.service.ts': {
    writes: 1,
    why:
      'Списание аренды одним оператором: захват периода (paid_until), проверка ' +
      'достатка и списание обязаны быть неразделимы, иначе месяц оплачен дважды ' +
      'или списан без продления. Процедуру в data-modifying CTE не позовёшь. ' +
      'Строку в token_transactions пишет соседний CTE того же оператора.',
  },
  'misc/misc.service.ts': {
    writes: 1,
    why:
      'Запасной путь на случай недоступной consume_user_tokens. Работа уже ' +
      'выполнена и результат отдан, отказывать нечем. Списанное считается ' +
      'разницей «до/после» и уезжает в token_transactions тем же оператором; ' +
      'поведение проверено на живой базе — tokens/fallback-deducts.integration.',
  },
  'tg-bot/tg-billing.service.ts': {
    writes: 1,
    why:
      'Тот же запасной путь: ход боту уже отвечен, и не списать за него — ' +
      'молчаливая потеря выручки. Реестр пишется тем же оператором, проверено ' +
      'на живой базе.',
  },
  'scheduler/token-accounting.service.ts': {
    writes: 1,
    why:
      'Тот же запасной путь для отложенных списаний: задача помечается ' +
      'completed, и несписанное уже не вернётся. Реестр пишется тем же ' +
      'оператором, проверено на живой базе.',
  },
};

/**
 * ═══ ДОЛГ, НАЙДЕННЫЙ ПЕРЕПИСАННЫМ СТОРОЖЕМ ═══
 *
 * 21.09.2026 сторож перестал искать одно написание правой части и увидел
 * ДЕВЯТЬ прямых писателей вместо одного. Пять закрыты в тот же заход
 * (реферальные начисления и три запасных пути), эти четыре — нет: они не
 * запасные ветки, а основные пути биллинга в чужих модулях, и переводить их
 * вслепую, без тестов на их собственное поведение, опаснее, чем записать.
 *
 * Список ЗАМОРОЖЕН по числу записей в каждом файле. Новый обход не сможет
 * присоединиться к нему молча: любое расхождение — и в большую сторону, и в
 * меньшую — красит сторож. Уменьшилось (долг закрыли) — строку удалить.
 */
const KNOWN_DEBT: Record<string, { writes: number; what: string }> = {
  // Две строки отсюда закрыты 23.09.2026 сносом SMM: биллинг SMM-агента
  // (chat/claude-agent.service.ts) и списание за перегенерацию сценария
  // (smm/scenarios/scenarios.controller.ts). Долг закрыт не выплатой, а
  // удалением должника — оба пути больше не существуют. Список сокращён по
  // правилу из шапки: «уменьшилось — строку удалить».
  'profile/profile.service.ts': {
    writes: 1,
    what:
      'Удаление аккаунта обнуляет баланс (`tokens = 0`) вместе с остальными ' +
      'полями. Это не списание за услугу, но баланс исчезает, а реестр ' +
      'продолжает объяснять его как имеющийся. Отдельный вопрос — нужна ли ' +
      'строка в реестре у аккаунта, который стирают.',
  },
};

/** Откуда видно, что файл правда пишет в реестр: INSERT, а не упоминание. */
const WRITES_LEDGER = /INSERT\s+INTO\s+token_transactions\b/i;

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectSources(full, out);
      continue;
    }
    // Каталог migrations больше НЕ пропускается: процедура, меняющая баланс,
    // живёт именно там, и прошлая редакция сторожа его не видела вовсе.
    const isSource = entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts');
    if (isSource || entry.name.endsWith('.sql')) out.push(full);
  }
  return out;
}

const srcRoot = path.join(__dirname, '..');
const rel = (file: string) => path.relative(srcRoot, file).split(path.sep).join('/');

/** Сколько прямых записей в каждом файле репозитория — по факту. */
function writesByFile(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of collectSources(srcRoot)) {
    const n = findBalanceColumnWrites(fs.readFileSync(file, 'utf8')).length;
    if (n > 0) out[rel(file)] = n;
  }
  return out;
}

describe('Прямые изменения баланса', () => {
  it('нигде, кроме объявленных исключений и замороженного долга', () => {
    const declared = { ...ALLOWED, ...KNOWN_DEBT };
    const offenders: string[] = [];

    for (const file of collectSources(srcRoot)) {
      const name = rel(file);
      if (declared[name]) continue;
      for (const w of findBalanceColumnWrites(fs.readFileSync(file, 'utf8'))) {
        offenders.push(`${name}:${w.line} — ${w.snippet}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('ни одно объявление не разошлось с кодом — ни в большую сторону, ни в меньшую', () => {
    // Списки заморожены по числу записей. Без этого один разрешённый прямой
    // UPDATE открывает файлу право на второй, неразрешённый, а «долг закрыли,
    // строку забыли удалить» превращается в тихое разрешение навсегда.
    const declared: Record<string, number> = {};
    for (const [k, v] of Object.entries(ALLOWED)) declared[k] = v.writes;
    for (const [k, v] of Object.entries(KNOWN_DEBT)) declared[k] = v.writes;

    expect(writesByFile()).toEqual(declared);
  });

  it('каждое исключение из ALLOWED само пишет в реестр — проверено по коду, не по упоминанию', () => {
    for (const [name, { why }] of Object.entries(ALLOWED)) {
      const full = path.join(srcRoot, name);
      expect(fs.existsSync(full)).toBe(true);
      // Прежняя редакция искала подстроку `token_transactions`, и её
      // удовлетворял любой комментарий про реестр — в tg-billing.service.ts
      // ровно такой комментарий и лежал, пока само списание шло мимо.
      expect(blankComments(fs.readFileSync(full, 'utf8'))).toMatch(WRITES_LEDGER);
      expect(why.length).toBeGreaterThan(40);
    }
  });

  it('долг не переехал в исключения: файлы из KNOWN_DEBT в реестр не пишут', () => {
    // Если бы писали — им место в ALLOWED, а не в долге. Проверка ловит
    // ситуацию «починили, но оставили в списке долгов», из-за которой список
    // перестаёт быть правдой о репозитории.
    for (const [name, { what }] of Object.entries(KNOWN_DEBT)) {
      const full = path.join(srcRoot, name);
      expect(fs.existsSync(full)).toBe(true);
      expect(blankComments(fs.readFileSync(full, 'utf8'))).not.toMatch(WRITES_LEDGER);
      expect(what.length).toBeGreaterThan(40);
    }
  });
});

/**
 * ЛОВИТ ЛИ СТОРОЖ КЛАСС, А НЕ СЛУЧАЙ.
 *
 * Сам по себе зелёный сторож не доказывает ничего: выражение, не совпадающее
 * ни с чем, зелено всегда. Поэтому ниже ему предъявляются написания правой
 * части — те четыре, на которых он уже прокалывался, и ещё несколько рядом, —
 * и отдельно то, что он трогать НЕ должен. Без второй половины проверка
 * вырождается в «флагуем всё подряд».
 */
describe('Поиск обходов', () => {
  const caught = (sql: string) => findBalanceColumnWrites(sql).length;

  describe('ловит присваивание колонке при любой правой части', () => {
    const shapes: Array<[string, string]> = [
      ['голое приращение (единственное, что ловила прошлая редакция)',
       `UPDATE ai_profiles_consolidated SET tokens = tokens + $1 WHERE user_id = $2`],
      ['COALESCE — реферальная программа',
       `UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1 WHERE user_id = $2`],
      ['GREATEST — оба запасных пути списания',
       `UPDATE ai_profiles_consolidated SET tokens = GREATEST(0, tokens - $1) WHERE user_id = $2`],
      ['через алиас таблицы — аренда продуктов',
       `UPDATE ai_profiles_consolidated a SET tokens = a.tokens - $2 FROM claimed c WHERE a.user_id = c.user_id`],
      ['из переменной — так пишет сама процедура',
       `UPDATE ai_profiles_consolidated SET tokens = v_new_balance WHERE user_id = p_user_id;`],
      ['константой',
       `UPDATE ai_profiles_consolidated SET tokens = 0 WHERE user_id = $1`],
      ['не первым в SET-списке',
       `UPDATE ai_profiles_consolidated SET updated_at = now(), tokens = $1 WHERE user_id = $2`],
      ['через public. и ONLY',
       `UPDATE ONLY public.ai_profiles_consolidated SET tokens = $1 WHERE user_id = $2`],
      ['в нижнем регистре',
       `update ai_profiles_consolidated set tokens = tokens - 1 where user_id = $1`],
      ['SET на другой строке, чем UPDATE',
       `UPDATE ai_profiles_consolidated\n   SET tokens = $1,\n       updated_at = now()\n WHERE user_id = $2`],
      ['внутри data-modifying CTE',
       `WITH c AS (UPDATE ai_profiles_consolidated SET tokens = tokens - $1 WHERE user_id = $2 RETURNING tokens) SELECT * FROM c`],
      ['без WHERE вовсе — задело бы всю базу',
       `UPDATE ai_profiles_consolidated SET tokens = 1000000`],
    ];
    it.each(shapes)('%s', (_name, sql) => expect(caught(sql)).toBe(1));
  });

  describe('молчит там, где баланс не меняют', () => {
    const quiet: Array<[string, string]> = [
      ['другая колонка той же таблицы — signup_source',
       `UPDATE ai_profiles_consolidated SET signup_source = $2 WHERE user_id = $1`],
      ['другая колонка — profile_data (предупреждение о низком балансе)',
       `UPDATE ai_profiles_consolidated SET profile_data = jsonb_set(profile_data, '{low_balance_warned}', $2::jsonb, true) WHERE user_id = $1`],
      ['другая колонка — onboarded (миграция profile/001)',
       `UPDATE ai_profiles_consolidated p SET onboarded = true WHERE p.onboarded = false`],
      ['tokens только в условии, не в SET',
       `UPDATE ai_profiles_consolidated SET updated_at = now() WHERE user_id = $2 AND tokens >= $1`],
      ['СРАВНЕНИЕ tokens = в условии — не присваивание',
       // Этот случай отличается от предыдущего и проверяет ровно отсечку
       // SET-списка по WHERE: `tokens >= $1` не похож на присваивание и сам по
       // себе, а `tokens = 0` похож дословно. Без отсечки сторож краснеет на
       // безобидном запросе — и такую тревогу гасят, отключая сторож.
       `UPDATE ai_profiles_consolidated SET updated_at = now() WHERE user_id = $2 AND tokens = 0`],
      ['присваивание tokens в RETURNING-хвосте соседнего смысла',
       `UPDATE ai_profiles_consolidated SET updated_at = now() WHERE user_id = $1 RETURNING tokens = 0 AS empty`],
      ['второй оператор в той же строке трогает ЧУЖУЮ таблицу',
       `UPDATE ai_profiles_consolidated SET updated_at = now() WHERE user_id = $1; UPDATE other SET tokens = 1;`],
      ['чтение баланса',
       `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1 FOR UPDATE`],
      ['колонка tokens, но таблица другая',
       `UPDATE some_other_table SET tokens = tokens + $1 WHERE user_id = $2`],
      ['вызов процедуры — разрешённый путь',
       `SELECT add_user_tokens($1, $2, 'bonus'::transaction_type_enum, $3, $4::jsonb)`],
      ['запись в реестр',
       `INSERT INTO token_transactions (user_id, amount, balance_after) VALUES ($1, $2, $3)`],
    ];
    it.each(quiet)('%s', (_name, sql) => expect(caught(sql)).toBe(0));
  });

  it('считает каждое вхождение, а не «есть или нет»', () => {
    const two =
      `UPDATE ai_profiles_consolidated SET tokens = tokens + $1 WHERE user_id = $2;\n` +
      `UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) - $1 WHERE user_id = $2;`;
    expect(findBalanceColumnWrites(two).map((w) => w.line)).toEqual([1, 2]);
  });

  describe('комментарии не считаются, но и не съедают код', () => {
    it('разбор прошлого инцидента в JSDoc не тревога', () => {
      const src =
        `/**\n * Раньше стоял ПРЯМОЙ\n` +
        ` *   UPDATE ai_profiles_consolidated SET tokens = COALESCE(tokens,0) + $1\n */\n` +
        `const sql = 'SELECT add_user_tokens($1, $2)';`;
      expect(caught(src)).toBe(0);
    });

    it('тот же разбор в SQL-комментарии не тревога', () => {
      const src = `-- было: UPDATE ai_profiles_consolidated SET tokens = v_new_balance\nSELECT 1;`;
      expect(caught(src)).toBe(0);
    });

    it('`//` внутри http-адреса не съедает остаток строки', () => {
      const src = `const doc = 'https://x/y'; const sql = 'UPDATE ai_profiles_consolidated SET tokens = 1 WHERE user_id = $1';`;
      expect(caught(src)).toBe(1);
    });

    it('номер строки не съезжает после комментария', () => {
      const src = `// раз\n/* два\n   три */\nUPDATE ai_profiles_consolidated SET tokens = $1 WHERE user_id = $2`;
      expect(findBalanceColumnWrites(src)[0].line).toBe(4);
    });
  });

  it('видит написания, которых прошлая редакция не видела', () => {
    // Смысл проверки — цена ошибки. Прежнее выражение `tokens = tokens ±`
    // пропускало ВОСЕМЬ прямых писателей из девяти: единственным, кого оно
    // ловило, был speech.service. Здесь это зафиксировано на живых исходниках,
    // чтобы «сторож зелёный» нельзя было спутать с «обходов нет».
    const OLD = /tokens\s*=\s*tokens\s*[-+]/i;
    const missedByOld = Object.keys(writesByFile()).filter(
      (name) => !OLD.test(blankComments(fs.readFileSync(path.join(srcRoot, name), 'utf8'))),
    );

    expect(missedByOld.sort()).toEqual(
      [
        'base/migrations/001_core_schema.sql',
        'misc/misc.service.ts',
        'products/rent.service.ts',
        'profile/profile.service.ts',
        'scheduler/token-accounting.service.ts',
        'tg-bot/tg-billing.service.ts',
        'tokens/migrations/001_add_user_tokens_lock.sql',
      ].sort(),
    );
  });
});
