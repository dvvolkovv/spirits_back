/**
 * Ключи в свободном тексте правки продукта — распознать и скрыть ДО записи и
 * до модели правок.
 *
 * Зачем (задача бэклога 642c5198, спека 2026-10-27-product-prompt-secrets):
 * владелец вставил ключи стороннего API прямо в текст правки. Ассистент правок
 * верно не стал вписывать их в код, но сам текст лёг открытым в
 * `product_turns.prompt` (история правок показывает его как есть) и ушёл
 * модели на машине продукта. Правильный путь для ключа — защищённая карточка;
 * эта функция — страховка на случай, когда человек о ней не знает.
 *
 * ЗАМЕНЯЕТСЯ ТОЛЬКО ЗНАЧЕНИЕ. `OPENAI_API_KEY=sk-…` становится
 * `OPENAI_API_KEY=[ключ скрыт]`: модель правок по-прежнему знает, какую
 * переменную окружения читать, а владелец — какой ключ ввести в карточку.
 *
 * ЦЕНА ОШИБОК НЕСИММЕТРИЧНА, и правила подобраны под это. Лишняя маска стоит
 * переформулировки: правка всё равно ставится, человек видит предупреждение.
 * Пропуск стоит ключа в открытом виде в базе и у модели. Поэтому правил много,
 * но каждое ограничено так, чтобы не трогать то, что в правках встречается
 * постоянно: числа (chat_id владельца передают правкой — он не секрет),
 * шестнадцатеричные sha (откат пишет `Откат к <sha>`), UUID, обычные слова,
 * идентификаторы кода, адреса без пароля и пути.
 *
 * Идемпотентна: маска сама ни под одно правило не подходит, поэтому второй
 * проход по уже скрытому тексту ничего не находит. На этом держится двойное
 * применение (первая правка скрывается при заведении и ещё раз в enqueue).
 */

export const SECRET_MASK = '[ключ скрыт]';

export interface MaskedSecrets {
  /** Текст, в котором значения ключей заменены на SECRET_MASK. */
  text: string;
  /** Сколько значений скрыто. 0 — текст не изменился. */
  count: number;
  /**
   * Имена, стоявшие перед скрытыми значениями («OPENAI_API_KEY=…»), без
   * повторов и в порядке появления — их называют человеку, чтобы он ввёл в
   * карточку ключ с тем же именем. Пусто, если count = 0: имена у уже
   * скрытых в прошлый раз значений второй раз не сообщаются.
   */
  names: string[];
}

/** Сколько имён отдаётся наружу: в плашку и ответ ассистенту, не в лог. */
const NAMES_MAX = 10;

// ── Проверки значения ─────────────────────────────────────────────────────

/** Доля знаков, стоящих в «словах»: строчные от 4 подряд или Слово с заглавной. */
function wordShare(s: string): number {
  const words = s.match(/[a-z]{4,}|[A-Z][a-z]{3,}/g);
  return words ? words.join('').length / s.length : 0;
}

/** Энтропия Шеннона на знак — отсекает строки вида «AAAA…1a». */
function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Похоже ли на случайный хвост ключа, а не на текст.
 *
 * Порог «доля слов < 0.5» подобран замером (27.10.2026): у случайной строки
 * из 32 букв и цифр он превышается в ~1.7% случаев, у CamelCase-идентификаторов
 * вроде `ProductLifecycleServiceV2Test3Helper` доля 0.7–0.9. Энтропия одна их
 * не разводит: у идентификатора 4.1–4.3 бита на знак, у случайной строки 4.0–4.6.
 */
function looksRandom(s: string, needMixedCase: boolean): boolean {
  if ((s.match(/\d/g) ?? []).length < 2) return false;
  if (needMixedCase && !(/[a-z]/.test(s) && /[A-Z]/.test(s))) return false;
  if (wordShare(s) >= 0.5) return false;
  return entropy(s) >= 3.5;
}

/** Ссылки на переменные и заглушки из документации — не значения. */
const PLACEHOLDER_RE =
  /^(?:\$\{?[A-Za-z_]|process\.env\.|import\.meta\.env\.|os\.environ|getenv|env\(|your[_-]|my[_-]|\.{3}|…|x{4,}$|\*{3,}$|changeme$|placeholder$|example$|none$|null$|undefined$|true$|false$)/i;

/** Адрес без пароля и путь к файлу — не секрет (пароль в адресе ловит своё правило). */
const URL_OR_PATH_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|\/|\.\.?\/|~\/)/i;

/** Слово, а не ключ: одним регистром или ПростымиСловами. */
function isWordish(v: string): boolean {
  return /^[a-z._-]+$/.test(v) || /^[A-Z._-]+$/.test(v) || /^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(v);
}

/** Значение при имени ключа: и для `NAME=…`, и для русского «пароль: …». */
function valueLooksSecret(v: string): boolean {
  if (v.length < 8) return false;
  if (PLACEHOLDER_RE.test(v) || URL_OR_PATH_RE.test(v)) return false;
  // Кириллица — это фраза («ключ: красивыйДизайн»), а не ключ сервиса.
  if (/[Ѐ-ӿ]/.test(v)) return false;
  if (/^\d+$/.test(v)) return false;
  return !isWordish(v);
}

// ── Правила ───────────────────────────────────────────────────────────────

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `export NAME="value"`.
 *
 * Слово-признак стоит ВНУТРИ шаблона имени, а не проверяется после: иначе
 * `Note: API_KEY=…` целиком съедалось бы как пара «Note» → «API_KEY=…»,
 * отбрасывалось, и движок продолжал бы ПОСЛЕ неё — настоящий ключ остался бы
 * открытым. Квантификаторы имени ограничены: без потолка строка из одних
 * «keykeykey…» стоила бы квадратичного перебора на каждом ходе.
 */
const ASSIGNMENT_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.\-/:@])(["'` + '`' + String.raw`]?)` +
    String.raw`((?=[A-Za-z])[A-Za-z0-9_.-]{0,40}?(?:key|token|secret|passw(?:or)?d|pass|pwd|auth|credential|private|dsn|bearer)[A-Za-z0-9_.-]{0,40})` +
    String.raw`\1([ \t]*(?::=|=>|=|:)[ \t]*)(["'` + '`' + String.raw`]?)([^\s"'` + '`' + String.raw`,;&<>()\[\]{}]{8,})`,
  'gi',
);

/** Имена, в которых слово-признак есть, а секрета нет: публичные ключи сборки, «ключевые слова». */
const NOT_SECRET_NAME_RE = /public|publishable|keyword/i;

/**
 * «пароль: …», «токен = …», «ключ — …». Только с разделителем: без него
 * «ключ из переменной X» и «ключевые слова» были бы ложными срабатываниями.
 * Граница слова — через \p{L}: \b в JS кириллицу не видит.
 */
const RU_ASSIGNMENT_RE =
  /(?<![\p{L}\p{N}_])((?:пароль|пароля|токен|токена|ключ|ключа|секрет|секретный ключ|api[- ]?ключ)[ \t]*(?::|=|—|–|-)[ \t]*)(["'«]?)([^\s"'»,;<>()\[\]{}]{8,})/giu;

/** Закрытый ключ PEM целиком; обрезанный (без END) — до конца текста. */
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

/** Пароль в адресе: `схема://user:пароль@хост` — скрывается только пароль. */
const URL_CREDENTIALS_RE = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:@/?#]+:)([^\s@/?#]+)@/gi;

/** `Bearer <токен>` без имени перед ним (заголовок, вставленный целиком). */
const BEARER_RE = /(\bBearer[ \t]+)([A-Za-z0-9._~+/-]{16,}=*)/g;

interface KnownFormat {
  re: RegExp;
  /** Доп. проверка совпадения — у форматов, чей префикс встречается и в тексте. */
  check?: (match: string) => boolean;
}

/**
 * Форматы ключей, узнаваемые по префиксу. Границы — lookbehind/lookahead, а не
 * \b: у половины префиксов есть `_` и `-`, а \b их считает частью слова.
 */
const KNOWN_FORMATS: KnownFormat[] = [
  // OpenAI (sk-…, sk-proj-…), Anthropic (sk-ant-…), OpenRouter (sk-or-…),
  // DeepSeek. «sk-» бывает и в тексте («sk-learn-…») — нужен случайный хвост.
  { re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,}/g, check: (m) => looksRandom(m.slice(3), false) },
  { re: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g }, // Stripe
  { re: /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9]{16,}/g }, // Stripe, подпись вебхука
  { re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,}/g }, // GitHub
  { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{30,}/g },
  { re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,}/g }, // GitLab
  { re: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,}/g }, // Slack
  { re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g }, // AWS
  { re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g }, // Google API, Gemini
  { re: /(?<![A-Za-z0-9_.-])ya29\.[0-9A-Za-z_-]{20,}/g }, // Google OAuth
  { re: /(?<![A-Za-z0-9_])y0_[A-Za-z0-9_-]{20,}/g }, // Яндекс OAuth
  { re: /(?<![A-Za-z0-9_-])AQVN[A-Za-z0-9_-]{30,}/g }, // Yandex Cloud API key
  { re: /(?<![A-Za-z0-9_.-])t1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g }, // Yandex Cloud IAM
  // Токен Telegram-бота — та же форма, что в bot-token-check.ts, без якорей.
  { re: /(?<![A-Za-z0-9_:-])\d{5,15}:[A-Za-z0-9_-]{30,}(?![A-Za-z0-9_-])/g },
  { re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g }, // JWT
  { re: /(?<![A-Za-z0-9_])(?:hf|r8|gsk)_[A-Za-z0-9]{30,}/g }, // Hugging Face, Replicate, Groq
  { re: /(?<![A-Za-z0-9_-])(?:xai|pplx)-[A-Za-z0-9]{30,}/g }, // xAI, Perplexity
  { re: /(?<![A-Za-z0-9_.-])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g }, // SendGrid
  { re: /(?<![A-Za-z0-9_-])key-[0-9a-f]{32}(?![0-9a-f])/g }, // Mailgun
  // ЮKassa (live_…/test_…). «test_» — ещё и начало имён тестов в snake_case,
  // поэтому хвост обязан выглядеть случайным.
  { re: /(?<![A-Za-z0-9_])(?:live|test)_[A-Za-z0-9_-]{30,}/g, check: (m) => looksRandom(m.slice(5), false) },
];

/**
 * Длинная случайная строка без имени и без известного префикса: ключи
 * провайдеров, которых нет в списке выше. `/` и `.` в класс не входят — иначе
 * правило съедало бы пути адресов.
 */
const RANDOM_RE = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+=-]{32,}(?![A-Za-z0-9_+=-])/g;

/** Имя перед маской — для names. `/` и `:` перед именем — это адрес, а не имя. */
const NAME_BEFORE_MASK_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_.\-/:@])(["'` + '`' + String.raw`]?)([A-Za-z][A-Za-z0-9_.-]{0,63})\1[ \t]*(?::=|=>|=|:)[ \t]*["'` + '`' + String.raw`]?` +
    SECRET_MASK.replace(/[[\]]/g, '\\$&'),
  'g',
);

/**
 * Что сказать ассистенту, когда в тексте для продукта (правка или описание при
 * заведении) что-то скрыто. Одна фраза на `edit` и `create`: разъехавшись, они
 * обещали бы человеку разное про один и тот же ключ.
 *
 * «Уже прозвучало в переписке» — правда именно для этого пути: текст для
 * продукта ассистент собрал из разговора, значит, значение видела и модель
 * чата. Кабинет говорит иначе (ProductChat.tsx): там ключ не ушёл никуда,
 * кроме нашего сервера.
 */
export function maskedSecretsSay(m: { count: number; names: string[] }): string {
  const names = m.names.length ? ` (${m.names.join(', ')})` : '';
  return (
    `В тексте для продукта были значения, похожие на ключи${names}: платформа заменила их на «${SECRET_MASK}», ` +
    'в продукт и модели правок они не попали. Скажи об этом пользователю. Значение уже прозвучало в переписке — ' +
    'посоветуй выпустить новый ключ и ввести его в защищённую карточку (действие keys; новому боту — в карточке создания). ' +
    'Ключи в prompt не вписывай.'
  );
}

export function maskSecrets(input: string): MaskedSecrets {
  let text = typeof input === 'string' ? input : '';
  let count = 0;
  const hide = () => {
    count++;
    return SECRET_MASK;
  };

  // Порядок важен. PEM — первым: в строках base64 бывают «=» и куски,
  // похожие на имена. Пароль в адресе — до присваиваний: «postgres://u:p@h»
  // иначе разбирался бы как пара «postgres» → «//u:p@h».
  text = text.replace(PEM_RE, hide);
  text = text.replace(URL_CREDENTIALS_RE, (_m, head: string) => `${head}${hide()}@`);

  text = text.replace(ASSIGNMENT_RE, (m, q1: string, name: string, sep: string, q2: string, value: string) => {
    if (NOT_SECRET_NAME_RE.test(name) || !valueLooksSecret(value)) return m;
    return `${q1}${name}${q1}${sep}${q2}${hide()}`;
  });
  text = text.replace(RU_ASSIGNMENT_RE, (m, head: string, q: string, value: string) =>
    valueLooksSecret(value) ? `${head}${q}${hide()}` : m,
  );

  text = text.replace(BEARER_RE, (m, head: string, value: string) =>
    looksRandom(value, false) ? `${head}${hide()}` : m,
  );
  for (const f of KNOWN_FORMATS) {
    text = text.replace(f.re, (m) => (!f.check || f.check(m) ? hide() : m));
  }
  text = text.replace(RANDOM_RE, (m) => (looksRandom(m, true) ? hide() : m));

  const names: string[] = [];
  if (count > 0) {
    for (const m of text.matchAll(NAME_BEFORE_MASK_RE)) {
      const name = m[2];
      if (!names.includes(name) && names.length < NAMES_MAX) names.push(name);
    }
  }
  return { text, count, names };
}
