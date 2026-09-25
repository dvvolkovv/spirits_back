import { promises as dnsp } from 'dns';

/** Имя TXT-записи подтверждения: `_linkeon.<домен>`. */
export const TXT_LABEL = '_linkeon';

export interface DnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export interface RecordCheck {
  type: 'TXT' | 'A' | 'AAAA';
  name: string;
  ok: boolean;
  /**
   * Код сбоя резолвера (ETIMEOUT, ESERVFAIL, …) или null, если резолвер не
   * падал — в том числе когда записи попросту нет (см. NO_RECORD).
   */
  error: string | null;
  /**
   * Что сейчас в DNS. Пусто при сбое резолвера — код сбоя смотри в `error`,
   * а не здесь: раньше сюда подмешивался русский текст «ошибка DNS: …», а
   * это же значение уходит в базу и в промпт ассистента на 7 локалях
   * кабинета — текст внутри данных недопустим. У TXT значения дополнительно
   * урезаны (см. sanitizeTxtCurrent): их пишет владелец ЧУЖОГО домена.
   */
  current: string[];
  /** Что должно быть. У AAAA — пусто: записей быть не должно. */
  want: string;
}

export interface DnsCheckResult {
  ok: boolean;
  records: RecordCheck[];
}

export interface DnsCheckInput {
  domain: string;
  names: string[];
  token: string;
  hostIp: string;
}

/**
 * Публичные резолверы, а не системный кеш прод-сервера: пользователь поправит
 * запись, а системный резолвер ещё час отдавал бы старую.
 *
 * Свежий канал (`fresh()`) на КАЖДЫЙ запрос, а не один Resolver полем
 * сервиса: у долгоживущего канала c-ares ≥1.32 (адаптивный таймаут появился
 * именно в 1.32; Node 22.22 и 20.20 — обе на c-ares 1.34.6) урезает таймаут
 * ПОПЫТКИ по истории ответов (5× среднее время ответа, не меньше 250 мс; Node
 * пересчитывает раз в секунду) — на прогретом канале заданные здесь 3000 мс
 * держатся только до третьего ответа, дальше ответ за 1–2.5 с уже даёт
 * ETIMEOUT, хотя сервер жив и просто не мгновенный.
 * Канал стоит ~0.2 мс, утечки нет (замер: 30 тыс. каналов подряд, RSS на
 * плато).
 *
 * SERVFAIL с первого сервера НЕ уходит ко второму — Node ставит
 * ARES_FLAG_NOCHECKRESP, второй сервер спасает только от таймаута и от
 * отказа соединения. Отказ закрытый: следующий оборот проверки повторит.
 */
export function publicResolver(): DnsResolver {
  const fresh = () => {
    const r = new dnsp.Resolver({ timeout: 3000, tries: 1 });
    r.setServers(['1.1.1.1', '8.8.8.8']);
    return r;
  };
  return {
    resolve4: (n) => fresh().resolve4(n),
    resolve6: (n) => fresh().resolve6(n),
    resolveTxt: (n) => fresh().resolveTxt(n),
  };
}

/**
 * «Записи нет» — не ошибка, а ответ. NXDOMAIN программно у Node не
 * встречается: он приходит как ENOTFOUND. Всё остальное — сбой, и он
 * называется (см. RecordCheck.error).
 */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

async function lookup<T>(fn: () => Promise<T[]>): Promise<{ values: T[]; error: string | null }> {
  try {
    return { values: await fn(), error: null };
  } catch (e: any) {
    if (NO_RECORD.has(e?.code)) return { values: [], error: null };
    return { values: [], error: String(e?.code ?? e?.message ?? e) };
  }
}

/**
 * Контрольный запрос: отвечает ли резолвер вообще — A-запрос к заведомо
 * живому имени. null — ответ пришёл (запись или «записи нет»: резолвер
 * жив), иначе — код сбоя. Сбой проверки заявки сам по себе про резолвер
 * ничего не говорит: SERVFAIL значит, что резолвер как раз ответил, а битая
 * — зона пользователя, и ETIMEOUT бывает от мёртвого сервера его зоны.
 */
export async function probeResolver(resolver: DnsResolver, name: string): Promise<string | null> {
  return (await lookup(() => resolver.resolve4(name))).error;
}

/**
 * Часть панелей регистраторов хранит TXT буквально с кавычками (`"lk-abc"`
 * вместо `lk-abc`), возможны пробелы по краям и другой регистр. Код — только
 * строчные hex, поэтому lowercase безопасен и не создаёт ложных совпадений.
 */
function normalizeTxt(v: string): string {
  return v.trim().replace(/^"(.*)"$/, '$1').trim().toLowerCase();
}

/** Потолок числа TXT-значений и длины ОДНОГО значения, попадающих в current. */
const TXT_CURRENT_MAX_VALUES = 5;
const TXT_CURRENT_MAX_LENGTH = 100;

/**
 * TXT-содержимое пишет владелец ЧУЖОГО домена, не наш пользователь, а
 * current уходит в базу и в контекст ассистента — канал prompt-injection. У
 * крупных доменов бывают десятки TXT-записей произвольной длины и
 * содержимого. Печатный ASCII (остальное выкидываем, не заменяем плейсхолдером),
 * потолок длины и потолок количества — оборона данных на входе, а не
 * косметика форматирования.
 */
function sanitizeTxtCurrent(values: string[]): string[] {
  return values
    .slice(0, TXT_CURRENT_MAX_VALUES)
    .map((v) => v.replace(/[^\x20-\x7E]/g, '').slice(0, TXT_CURRENT_MAX_LENGTH));
}

/**
 * Готов ли домен к выпуску сертификата: все три условия сразу.
 *
 * 1. TXT `_linkeon.<домен>` содержит разовый код — домен принадлежит заявителю.
 *    Без этого на общем IP любой пользователь мог бы занять домен, уже
 *    направленный на машину другим. Сравнение — по нормализованной форме
 *    (без кавычек/пробелов по краям, без учёта регистра): часть панелей
 *    регистраторов хранит TXT в кавычках буквально.
 * 2. У КАЖДОГО имени ВСЕ A-записи — IP машины продукта. CNAME резолвер
 *    разворачивает сам и отдаёт итоговый A.
 * 3. AAAA нет ни у одного имени: у машин продуктов нет IPv6, а Let's Encrypt
 *    предпочитает IPv6 — одна оставшаяся AAAA роняет выпуск.
 *
 * Запросы идут ПАРАЛЛЕЛЬНО. Последовательно, при недоступных серверах и
 * publicResolver (tries:1, два сервера по 3000 мс), 5 запросов дают ~30 с —
 * по потолку тайм-аута на каждый запрос по очереди; параллельно то же самое
 * укладывается в ~6–7 с (по потолку одного запроса, а не суммы). Порядок
 * записей в результате — TXT, затем по каждому имени из `names` подряд A и
 * AAAA — задаётся порядком push ниже, а не порядком завершения запросов.
 *
 * Сбой резолвера отличён от отсутствия записи полем `error` (код или null);
 * `current` при сбое — пустой массив, без текста внутри данных.
 */
export async function checkDns(input: DnsCheckInput, resolver: DnsResolver): Promise<DnsCheckResult> {
  if (input.names.length === 0) {
    throw new Error('checkDns: names пуст — ошибка вызывающего, таблица доменов такого не допускает');
  }

  const records: RecordCheck[] = [];
  const txtName = `${TXT_LABEL}.${input.domain}`;

  // Оба промиса стартуют своими запросами синхронно, до первого await —
  // резолвер под каждый вызов свежий (см. publicResolver), общего состояния
  // между ними нет, конкурентность полная.
  const txtPromise = lookup(() => resolver.resolveTxt(txtName));
  const perNamePromise = Promise.all(
    input.names.map((name) => Promise.all([lookup(() => resolver.resolve4(name)), lookup(() => resolver.resolve6(name))])),
  );
  const [txt, perName] = await Promise.all([txtPromise, perNamePromise]);

  const txtValues = txt.values.map((chunks) => chunks.join(''));
  records.push({
    type: 'TXT',
    name: txtName,
    ok: !txt.error && txtValues.some((v) => normalizeTxt(v) === input.token),
    error: txt.error,
    current: txt.error ? [] : sanitizeTxtCurrent(txtValues),
    want: input.token,
  });

  input.names.forEach((name, i) => {
    const [a, aaaa] = perName[i];
    records.push({
      type: 'A',
      name,
      ok: !a.error && a.values.length > 0 && a.values.every((ip) => ip === input.hostIp),
      error: a.error,
      current: a.error ? [] : a.values,
      want: input.hostIp,
    });
    records.push({
      type: 'AAAA',
      name,
      ok: !aaaa.error && aaaa.values.length === 0,
      error: aaaa.error,
      current: aaaa.error ? [] : aaaa.values,
      want: '',
    });
  });

  return { ok: records.every((r) => r.ok), records };
}
