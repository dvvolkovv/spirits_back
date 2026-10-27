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
 * ЛИШНЯЯ МАСКА НЕ БЕСПЛАТНА. Скрытая ссылка на таблицу или ID кошелька ломает
 * правку молча: продукт не узнает, с чем работать, а пересказать ссылку
 * человек не сможет. Поэтому правила держатся узко, а то, что в правках
 * встречается постоянно, нарочно не трогается: адреса (в них — только пароль,
 * параметры с точным именем ключа и известные форматы), data:-адреса, числа
 * (chat_id владельца передают правкой — он не секрет), шестнадцатеричные sha
 * (откат пишет `Откат к <sha>`), UUID без имени, ссылки на значения в коде
 * (`this.config.apiKey`, `os.Getenv(…)`), почта, заглушки, публичные форматы
 * (кошельки, ключи reCAPTCHA, хеши SRI, `pk_live_…`). Проверено на всех
 * правках прода 27.10.2026: ловится ровно настоящий случай, ложных нет.
 *
 * ВРЕМЯ — ЛИНЕЙНОЕ. Текст приходит от клиента, а API живёт одним процессом:
 * регулярка с квадратичным перебором на 160 КБ злого ввода держала его 12 с
 * (ревью 27.10). Поэтому у каждого квантификатора есть потолок, у каждого
 * начала совпадения — граница слева, а длину текста правки до маски
 * ограничивает вызывающий (PRODUCT_PROMPT_MAX_CHARS в turns.service.ts).
 * Сторож — тест на 200 КБ злого ввода в prompt-secrets.spec.ts.
 *
 * Идемпотентна: проходы повторяются до неподвижной точки (не больше
 * PASSES_MAX), поэтому повторный вызов на результате ничего не находит. На
 * этом держится двойное применение: первая правка скрывается при заведении и
 * ещё раз в enqueue.
 */

export const SECRET_MASK = '[ключ скрыт]';

/** Итог маски для тех, кто о ней сообщает: кабинету (notice) и ассистенту (say). */
export interface SecretsMasked {
  /** Сколько значений скрыто. */
  count: number;
  /**
   * Имена, стоявшие перед скрытыми значениями («OPENAI_API_KEY=…»), без
   * повторов и в порядке появления — их называют человеку, чтобы он ввёл в
   * карточку ключ с тем же именем. Собираются в момент замены: маска, уже
   * бывшая во вводе (текст скопирован из истории), второй раз не докладывается.
   */
  names: string[];
}

export interface MaskedSecrets extends SecretsMasked {
  /** Текст, в котором значения ключей заменены на SECRET_MASK. */
  text: string;
}

/** Сколько имён отдаётся наружу: в плашку и ответ ассистенту, не в лог. */
const NAMES_MAX = 10;
/** Проходов до неподвижной точки: маска даёт новую границу слова, и изредка второй проход находит ещё одно значение. */
const PASSES_MAX = 4;
/**
 * Разделитель временных заглушек: адреса и публичные значения на время
 * прохода вынимаются из текста, чтобы их не задели правила для свободного
 * текста. NUL — потому что в тексте его быть не может: Postgres не хранит его
 * в text, и вход заменяет его на U+FFFD до первого прохода.
 */
const HOLD = '\u0000';
const HOLD_RE = /\u0000(\d+)\u0000/g;

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
 * Порог «доля слов < 0.5» подобран замером (27.10.2026): у CamelCase-
 * идентификаторов вроде `ProductLifecycleServiceV2Test3Helper` доля 0.7–0.9,
 * у случайной строки из 32 букв и цифр он превышается в ~1.7% случаев.
 * Энтропия одна их не разводит (у идентификатора 4.1–4.3 бита на знак, у
 * случайной строки 4.0–4.6) и спрашивается только там, где алфавит широкий:
 * у шестнадцатеричного ключа она не выше 4, и порог 3.5 пропускал бы каждый
 * пятый `sk-` + 32 hex (ревью, I5).
 */
function looksRandom(s: string, o: { mixedCase?: boolean; entropy?: boolean } = {}): boolean {
  if ((s.match(/\d/g) ?? []).length < 2) return false;
  if (o.mixedCase && !(/[a-z]/.test(s) && /[A-Z]/.test(s))) return false;
  // У шестнадцатеричной строки «слова» — это просто подряд идущие a–f
  // («ecccccccc»), и доля слов о ней ничего не говорит: решают цифры.
  if (/^[0-9a-f]+$/i.test(s)) return new Set(s).size >= 4;
  if (wordShare(s) >= 0.5) return false;
  return !o.entropy || entropy(s) >= 3.5;
}

const notWordy = (s: string) => wordShare(s) < 0.5;

/** Ссылки на переменные и заглушки из документации — не значения. */
const PLACEHOLDER_RE =
  /^(?:\$\{?[A-Za-z_]|%[A-Za-z_]+%$|process\.env\.|import\.meta\.env\.|os\.environ|getenv|env\(|your[_-]|my[_-]|<|\.{3}|…|x{4,}$|\*{3,}$|•{3,}$|change[_-]?me$|placeholder$|example$|none$|null$|undefined$|true$|false$|password$|secret$|token$)/i;

/** Адрес без пароля и путь к файлу — не секрет (пароль в адресе ловит своё правило). */
const URL_OR_PATH_RE = /^(?:[a-z][a-z0-9+.-]{0,31}:\/\/|\/|\.\.?\/|~\/)/i;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[A-Za-z]{2,24}$/;

/** `this.config.apiKey`, `env.BOT_TOKEN`, `settings.WEATHER_API_KEY` — ссылка на значение, не значение. */
const CODE_REF_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/;
/** `os.getenv("DB_PASSWORD")`, `getpass()` — вызов целиком. «Pa(ss)w0rd!» сюда не подходит: после скобки — продолжение. */
const CODE_CALL_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\([^()]*\)[;,]?$/;
/** Значение, которое само начинается с «ИМЯ=» — это следующее присваивание, а не значение. */
const ENV_ASSIGNMENT_RE = /^[A-Z][A-Z0-9_]{2,}[=:]/;

/** Слово, а не ключ: одним регистром или ПростымиСловами. */
function isWordish(v: string): boolean {
  return /^[a-z._-]+$/.test(v) || /^[A-Z._-]+$/.test(v) || /^[A-Z]?[a-z]+(?:[A-Z][a-z]+)*$/.test(v);
}

type ValueKind = 'password' | 'key';

/**
 * Значение при имени ключа (`NAME=…`, «пароль: …»).
 *
 * strict — имя в форме переменной окружения или разделитель «=»: так пишут
 * .env и код, и там значение почти наверняка настоящее. Без этого «Password:
 * Enter your password» скрывало бы слово «Enter».
 */
function valueLooksSecret(v: string, kind: ValueKind, strict: boolean, lastOnLine: boolean): boolean {
  if (!v || v.includes(HOLD)) return false;
  if (/[=:]$/.test(v) || ENV_ASSIGNMENT_RE.test(v)) return false;
  if (PLACEHOLDER_RE.test(v) || URL_OR_PATH_RE.test(v) || EMAIL_RE.test(v) || CODE_CALL_RE.test(v)) return false;
  if (CODE_REF_RE.test(v) && !looksRandom(v.replace(/\./g, ''))) return false;
  // Кириллица — это фраза («ключ: красивыйДизайн»), а не ключ сервиса.
  if (/[Ѐ-ӿ]/.test(v)) return false;
  if (kind === 'password') {
    if (v.length < 4) return false;
    // Пароль из одних букв — обычное дело (пароли приложений Яндекса и
    // Gmail — 16 строчных), но в прозе это скорее слово. В .env верим; в
    // подписи «пароль: …» — только если значение последнее в строке.
    if (/^[A-Za-z]+$/.test(v)) return strict || lastOnLine;
    return true;
  }
  if (v.length < 8 || /^\d+$/.test(v)) return false;
  return !isWordish(v);
}

// ── Имена ─────────────────────────────────────────────────────────────────

/**
 * Признаки — ЦЕЛЫЕ части имени, а не подстрока: `author`, `passenger_name`,
 * `secretary_email`, `hotkey`, `tokenizer`, `Passport` — не ключи (ревью, I3).
 * Части режутся по `_ . -` и CamelCase (`OpenAIKey` → open, ai, key).
 * Хвостовые признаки (key, token, auth, pass) считаются только последней
 * частью: `TOKEN_TYPE`, `AUTH_MODE`, `API_KEY_ID` — описания, а не ключи.
 */
const PASSWORD_ANY = new Set(['password', 'passwd', 'passphrase', 'pwd']);
const PASSWORD_TAIL = new Set(['pass']);
const SECRET_ANY = new Set([
  'secret', 'secrets', 'credential', 'credentials', 'authorization', 'apikey', 'apitoken', 'authtoken',
  'accesstoken', 'refreshtoken', 'secretkey', 'privatekey', 'clientsecret', 'appid', 'dsn',
]);
const SECRET_TAIL = new Set(['key', 'token', 'auth', 'oauth', 'bearer']);

function nameKind(name: string): ValueKind | null {
  const parts = name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const last = parts[parts.length - 1];
  if (parts.some((p) => PASSWORD_ANY.has(p)) || PASSWORD_TAIL.has(last)) return 'password';
  if (parts.some((p) => SECRET_ANY.has(p)) || SECRET_TAIL.has(last)) return 'key';
  return null;
}

/** Публичные по замыслу: ключи сборки фронта, publishable-ключи платёжек. Значение защищается от прочих правил. */
const PUBLIC_NAME_RE = /public|publishable/i;

/** Имя прямо перед местом в тексте: `NAME=`, `"name": "`, `**NAME**: `. */
const NAME_TAIL_RE = /(?:^|[^A-Za-z0-9_.-])(?:\*\*)?["'`]?([A-Za-z][A-Za-z0-9_.-]{0,63})["'`]?[ \t]*(?:\*\*)?[ \t]*(?::=|=>|=|:)[ \t]*(?:\*\*)?[ \t]*["'`]?$/;

function nameBefore(text: string, at: number): string | undefined {
  return NAME_TAIL_RE.exec(text.slice(Math.max(0, at - 96), at))?.[1];
}

// ── Правила ───────────────────────────────────────────────────────────────

/**
 * `NAME=value`, `NAME: value`, `"name": "value"`, `export NAME="value"`,
 * `--password=…`, `**NAME**: …`, `NAME — …`, `| NAME | … |`.
 *
 * Разбирается циклом exec, а не replace: отвергнутое совпадение не должно
 * съедать хвост. `Note: API_KEY=…` иначе читалось бы как пара «Note» →
 * «API_KEY=…», отбрасывалось, и движок продолжал бы ПОСЛЕ неё — настоящий
 * ключ остался бы открытым. После отказа поиск идёт со следующего знака.
 *
 * Группы: 1 — дефисы, 2 — кавычка имени, 3 — имя, 4 — разделитель,
 * 5 — кавычка значения, 6 — значение в кавычках, 7 — значение без кавычек.
 */
const ASSIGNMENT_RE =
  /(?<![A-Za-z0-9_.\-\/:@*])(--?)?(?:\*\*)?(["'`])?([A-Za-z][A-Za-z0-9_.-]{0,63})\2([ \t]*(?:\*\*)?[ \t]*(?::=|=>|=|:|\||[—–](?=[ \t]))[ \t]*(?:\*\*)?[ \t]*)(?:(["'`])([^"'`\n]{1,256})|(\S{1,256}))/g;

/**
 * «пароль: …», «токен бота = …», «Ключ API — …», «**Пароль:** …». Только с
 * разделителем: без него «ключ из переменной X» и «ключевые слова» были бы
 * ложными срабатываниями. Между признаком и разделителем — до трёх слов
 * («пароль от админки:»), каждое — с буквы: иначе в «токен бота 7234567890:AA…»
 * цифры бота читались бы словом подписи, и токен скрылся бы наполовину.
 * Граница слова — через \p{L}: \b в JS кириллицу не видит.
 *
 * Группы: 1 — подпись, 2 — разделитель, 3 — кавычка, 4 — в кавычках, 5 — без кавычек.
 */
const RU_LABEL_RE =
  /(?<![\p{L}\p{N}_])(?:\*\*)?((?:пароль|пароля|токен|токена|ключ|ключа|секрет|секретный ключ|api[- ]?ключ|апи[- ]?ключ)(?:[ \t]+\p{L}[\p{L}\p{N}_.-]{0,23}){0,3})([ \t]*(?:\*\*)?[ \t]*(?::|=|[—–-](?=[ \t]))[ \t]*(?:\*\*)?[ \t]*)(?:(["'«])([^"'»\n]{1,256})|(\S{1,256}))/giu;

/** Пароль приложения «xxxx xxxx xxxx xxxx» — с пробелами, но целиком. */
const APP_PASSWORD_RE = /^[a-z]{4}(?: [a-z]{4}){3}(?![A-Za-z0-9])/;

/** Значение из совпадения: до какого знака оно на самом деле тянется. */
function effectiveValue(text: string, start: number, quoted: string | undefined, bare: string | undefined, kind: ValueKind): string {
  if (quoted !== undefined) {
    if (kind === 'password') return quoted;
    const cut = quoted.search(/[\s,;&<>()[\]{}|]/);
    return cut === -1 ? quoted : quoted.slice(0, cut);
  }
  const raw = bare ?? '';
  if (kind === 'password') {
    const app = APP_PASSWORD_RE.exec(text.slice(start, start + 24));
    if (app) return app[0];
    // Пароль тянется до пробела: «Xy7&kLm9#pQ2» и «Pa(ss)w0rd!2026» целиком.
    // Хвостовые точка и запятая — скорее конец фразы. Скобку не трогаем:
    // `os.getenv("DB_PASSWORD")` без неё перестал бы узнаваться как вызов.
    return raw.replace(/[.,;]+$/, '');
  }
  const cut = raw.search(/[,;&<>()[\]{}|"'`]/);
  return (cut === -1 ? raw : raw.slice(0, cut)).replace(/[.,]+$/, '');
}

/** Значение — последнее в своей строке (дальше только пробелы и знак препинания). Окно ограничено: вызов — на каждом кандидате. */
function lastOnLine(text: string, end: number): boolean {
  const tail = text.slice(end, end + 200);
  const nl = tail.indexOf('\n');
  if (nl === -1 && end + 200 < text.length) return false;
  return /^[ \t]*[.,;!]?[ \t]*$/.test(nl === -1 ? tail : tail.slice(0, nl));
}

/** Закрытый ключ PEM целиком; обрезанный (без END) — до конца текста. */
const PEM_RE = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g;

/** data:-адрес — данные (картинка, файл), а не ключ: не трогается вовсе. */
const DATA_URI_RE = /data:[a-z]{1,20}\/[a-z0-9.+-]{1,64}(?:;[a-z0-9=.-]{1,64}){0,4};base64,[A-Za-z0-9+\/=]{1,1000000}/gi;

/**
 * Адрес: со схемой или «домен/путь» без неё. Внутри адреса работают только
 * свои правила (maskInsideUrl): ID документов, файлов и видео в ссылках
 * выглядят ровно как ключи, а ссылку человек не перескажет.
 */
const URL_SPAN_RE =
  /(?<![A-Za-z0-9+.-])[a-z][a-z0-9+.-]{0,31}:\/\/[^\s<>"'`)\]]{1,4096}|(?<![\w.@\/-])(?:[a-z0-9-]{1,63}\.){1,10}[a-z]{2,24}\/[^\s<>"'`)\]]{0,4096}/gi;

/**
 * Пароль в адресе: `схема://user:пароль@хост` — скрывается только пароль.
 * Схема — от начала адреса и с потолком: без них `\b` перед каждой буквой
 * строки «a.a.a.…» давал квадратичный перебор (ревью, C1).
 */
const URL_CREDENTIALS_RE = /^([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:@\/?#]{1,256}:)([^\s@\/?#]{1,256})@/i;

/** Параметры адреса с ТОЧНЫМ именем ключа: `?appid=…`, `&api_key=…`. `rlkey`, `list`, `id` — не они. */
const URL_PARAM_RE =
  /([?&;](key|api[_-]?key|apikey|token|access[_-]?token|auth[_-]?token|secret|client[_-]?secret|password|passwd|pwd|appid)=)([^&#\s]{1,512})/gi;

/** `Bearer …`, `Basic …`, `Token …` без имени перед ними (заголовок, вставленный целиком). */
const AUTH_HEADER_RE = /(\b(?:Bearer|Basic|Token|Bot|OAuth|Api-Key)[ \t]+)([A-Za-z0-9._~+\/-]{16,4096}=*)/g;

/** `curl -u admin:пароль` — скрывается пароль. */
const CURL_USER_RE = /((?:^|\s)(?:-u|--user)[ \t]+[^\s:]{1,64}:)(\S{1,256})/g;

interface KnownFormat {
  re: RegExp;
  /** Доп. проверка совпадения — у форматов, чей префикс встречается и в тексте. */
  check?: (match: string) => boolean;
}

/**
 * Форматы ключей, узнаваемые по префиксу. Границы — lookbehind/lookahead, а не
 * \b: у половины префиксов есть `_` и `-`, а \b их считает частью слова.
 * Захватывающих групп нет: обработчик замены читает позицию совпадения.
 */
const KNOWN_FORMATS: KnownFormat[] = [
  // OpenAI (sk-…, sk-proj-…), Anthropic (sk-ant-…), OpenRouter (sk-or-…),
  // DeepSeek (sk- + 32 hex). «sk-» бывает и в тексте («sk-learn-…»).
  { re: /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{20,256}/g, check: (m) => looksRandom(m.slice(3)) },
  { re: /(?<![A-Za-z0-9_])sk_[0-9a-f]{40,128}(?![0-9a-z])/g }, // ElevenLabs
  { re: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,256}/g }, // Stripe
  { re: /(?<![A-Za-z0-9_])whsec_[A-Za-z0-9]{16,256}/g }, // Stripe, подпись вебхука
  { re: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{30,256}/g }, // GitHub
  { re: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{30,256}/g },
  { re: /(?<![A-Za-z0-9_-])glpat-[A-Za-z0-9_-]{20,256}/g }, // GitLab
  { re: /(?<![A-Za-z0-9_-])xox[abposr]-[A-Za-z0-9-]{10,256}/g }, // Slack
  { re: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![A-Za-z0-9])/g }, // AWS
  { re: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}(?![A-Za-z0-9_-])/g }, // Google API, Gemini
  { re: /(?<![A-Za-z0-9_.-])ya29\.[0-9A-Za-z_-]{20,2048}/g }, // Google OAuth
  { re: /(?<![A-Za-z0-9_])y0_[A-Za-z0-9_-]{20,512}/g }, // Яндекс OAuth
  { re: /(?<![A-Za-z0-9_-])AQVN[A-Za-z0-9_-]{30,256}/g }, // Yandex Cloud API key
  { re: /(?<![A-Za-z0-9_.-])t1\.[A-Za-z0-9_-]{20,1024}\.[A-Za-z0-9_-]{20,1024}/g }, // Yandex Cloud IAM
  // Токен Telegram-бота — та же форма, что в bot-token-check.ts, без якорей.
  // Хвост не словесный: «Ошибка 50001:connection_reset_by_peer…» — не токен.
  { re: /(?<![A-Za-z0-9_:-])\d{5,15}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g, check: (m) => notWordy(m.slice(m.indexOf(':') + 1)) },
  // Он же внутри адреса Bot API (`…/bot<токен>/sendMessage`): там перед
  // цифрами стоит «bot», и граница правила выше его не пускает.
  { re: /(?<=\/bot)\d{5,15}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g },
  // Вебхуки, у которых секрет — часть пути: скрывается последний сегмент.
  { re: /(?<=discord(?:app)?\.com\/api\/webhooks\/\d{5,25}\/)[A-Za-z0-9_-]{40,128}/g },
  { re: /(?<=hooks\.slack\.com\/services\/[A-Za-z0-9]{6,32}\/[A-Za-z0-9]{6,32}\/)[A-Za-z0-9]{16,64}/g },
  { re: /(?<=\/rest\/\d{1,10}\/)[a-z0-9]{12,64}(?=\/)/g }, // Битрикс24, входящий вебхук
  // JWT. `pk.eyJ…` — публичный токен Mapbox (секретный у него — `sk.eyJ…`).
  { re: /(?<![A-Za-z0-9_-]|pk\.)eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g },
  { re: /(?<![A-Za-z0-9_])(?:hf|r8|gsk)_[A-Za-z0-9]{30,256}/g }, // Hugging Face, Replicate, Groq
  { re: /(?<![A-Za-z0-9_-])(?:xai|pplx)-[A-Za-z0-9]{30,256}/g }, // xAI, Perplexity
  { re: /(?<![A-Za-z0-9_.-])SG\.[A-Za-z0-9_-]{16,128}\.[A-Za-z0-9_-]{16,128}/g }, // SendGrid
  { re: /(?<![A-Za-z0-9_-])key-[0-9a-f]{32}(?![0-9a-f])/g }, // Mailgun
  // ЮKassa (live_…/test_…). «test_» — ещё и начало имён тестов в snake_case:
  // хвост смешанного регистра и почти без подчёркиваний.
  {
    re: /(?<![A-Za-z0-9_])(?:live|test)_[A-Za-z0-9_-]{30,256}/g,
    check: (m) => looksRandom(m.slice(5), { mixedCase: true }) && (m.match(/_/g)?.length ?? 0) <= 4,
  },
];

/**
 * Длинная случайная строка без имени и без известного префикса: ключи
 * провайдеров, которых нет в списке выше. САМОЕ ОПАСНОЕ ПРАВИЛО: на правках
 * прода 27.10.2026 оно ни разу не попало в ключ, зато скрыло ID Google-таблиц
 * в ссылках и нарезало на 180 масок вставленную base64-картинку. Поэтому:
 *  - только в свободном тексте — адреса и data:-адреса к нему не попадают;
 *  - не внутри длинного base64 (BLOB_MIN_CHARS);
 *  - не публичные форматы (PUBLIC_FORMAT_RE);
 *  - только если перед строкой сказано, что это ключ (secretWordBefore):
 *    голый ID таблицы в тексте — частое и законное содержимое правки, голый
 *    безымянный ключ — редкость.
 * `=` — только хвостом: иначе правило съедало бы пары `имя=значение` целиком.
 */
const RANDOM_RE = /(?<![A-Za-z0-9_+=-])[A-Za-z0-9_+-]{32,160}={0,2}(?![A-Za-z0-9_+=-])/g;

/** Публичные по замыслу: кошельки TON, TRON, Ethereum, Bitcoin; ключ сайта reCAPTCHA; хеш SRI. */
const PUBLIC_FORMAT_RE =
  /^(?:[EU]Q[A-Za-z0-9_-]{46}$|T[1-9A-HJ-NP-Za-km-z]{33}$|0x[0-9a-fA-F]{40}$|[13][1-9A-HJ-NP-Za-km-z]{25,34}$|6L[A-Za-z0-9_-]{38}$|sha(?:256|384|512)-)/;

/** Слова, после которых длинная случайная строка — ключ, а не идентификатор. Целые слова: «ключевые» — не «ключ». */
const SECRET_WORDS = new Set([
  'key', 'keys', 'token', 'tokens', 'secret', 'secrets', 'password', 'passwords', 'passwd', 'pass', 'pwd',
  'credential', 'credentials', 'bearer', 'apikey', 'appid',
  'ключ', 'ключа', 'ключи', 'ключом', 'ключей', 'токен', 'токена', 'токены', 'токеном',
  'секрет', 'секрета', 'секретный', 'пароль', 'пароля', 'паролем',
]);
/** Сколько слов перед строкой смотреть в поисках такого слова. */
const SECRET_CONTEXT_WORDS = 4;
const MASK_ATOM = '\u0001';

/**
 * Сказано ли перед местом, что дальше ключ: среди последних
 * SECRET_CONTEXT_WORDS слов той же строки есть слово-признак.
 *
 * Считается в СЛОВАХ, а не в знаках, и маска — одно слово и никогда не
 * признак. Иначе решение менялось бы от прохода к проходу: маска короче
 * значения и подтягивала бы дальнее слово в окно, а слово «ключ» внутри самой
 * маски делало бы её заразной — ID таблицы строкой ниже ключа скрывался бы
 * следом (ревью, Minor 1; найдено проверкой идемпотентности на случайных смесях).
 */
function secretWordBefore(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf('\n', at - 1) + 1;
  const words = text
    .slice(Math.max(lineStart, at - 1000), at)
    .split(SECRET_MASK)
    .join(MASK_ATOM)
    .split(/[ \t]+/)
    .filter(Boolean)
    .slice(-SECRET_CONTEXT_WORDS);
  return words.some((w) =>
    w
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z\u0400-\u04FF]+/)
      .some((part) => SECRET_WORDS.has(part.toLowerCase())),
  );
}
/** С какой длины подряд идущий base64 (с `/` и `+`) — данные, а не ключ. */
const BLOB_MIN_CHARS = 160;

const BASE64_CHAR_RE = /[A-Za-z0-9+\/=_-]/;

function insideBlob(text: string, at: number, length: number): boolean {
  let start = at;
  let end = at + length;
  // Сканирование ограничено порогом: дальше BLOB_MIN_CHARS ответ уже известен.
  while (start > 0 && end - start < BLOB_MIN_CHARS && BASE64_CHAR_RE.test(text[start - 1])) start--;
  while (end < text.length && end - start < BLOB_MIN_CHARS && BASE64_CHAR_RE.test(text[end])) end++;
  return end - start >= BLOB_MIN_CHARS;
}

// ── Проход ────────────────────────────────────────────────────────────────

interface Pass {
  hide: (name?: string) => string;
  keep: (s: string) => string;
}

function maskInsideUrl(url: string, p: Pass): string {
  let u = url.replace(URL_CREDENTIALS_RE, (_m, head: string) => `${head}${p.hide()}@`);
  u = u.replace(URL_PARAM_RE, (m, head: string, name: string, v: string) => {
    const kind: ValueKind = /pass|pwd/i.test(name) ? 'password' : 'key';
    return valueLooksSecret(v, kind, true, true) ? head + p.hide(name.toLowerCase()) : m;
  });
  for (const f of KNOWN_FORMATS) u = u.replace(f.re, (m: string) => (!f.check || f.check(m) ? p.hide() : m));
  return u;
}

function maskLabelled(text: string, re: RegExp, p: Pass, read: (m: RegExpExecArray) => {
  name?: string;
  kind: ValueKind | null;
  strict: boolean;
  isPublic: boolean;
  head: string;
  quote?: string;
  quoted?: string;
  bare?: string;
}): string {
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const r = read(m);
    const start = m.index + r.head.length + (r.quote ? r.quote.length : 0);
    const v = r.kind ? effectiveValue(text, start, r.quoted, r.bare, r.kind) : '';
    if (!r.kind || !v || (!r.isPublic && !valueLooksSecret(v, r.kind, r.strict, lastOnLine(text, start + v.length)))) {
      re.lastIndex = m.index + 1;
      continue;
    }
    out += text.slice(last, start) + (r.isPublic ? p.keep(v) : p.hide(r.name));
    last = start + v.length;
    re.lastIndex = last;
  }
  return out + text.slice(last);
}

function maskPass(input: string): MaskedSecrets {
  const kept: string[] = [];
  const names: string[] = [];
  let count = 0;
  const p: Pass = {
    hide: (name?: string) => {
      count++;
      if (name && !names.includes(name) && names.length < NAMES_MAX) names.push(name);
      return SECRET_MASK;
    },
    keep: (s: string) => `${HOLD}${kept.push(s) - 1}${HOLD}`,
  };

  // Порядок важен. data:-адреса и адреса — первыми: дальше правила для
  // свободного текста их не видят. PEM — до них не доходит (в нём нет «://»),
  // но ставится первым из скрывающих: в строках base64 бывают «=».
  let t = input.replace(DATA_URI_RE, (m: string) => p.keep(m));
  t = t.replace(PEM_RE, (_m: string, at: number, whole: string) => p.hide(nameBefore(whole, at)));
  t = t.replace(URL_SPAN_RE, (url: string) => p.keep(maskInsideUrl(url, p)));

  t = maskLabelled(t, ASSIGNMENT_RE, p, (m) => {
    const kind = nameKind(m[3]);
    return {
      name: m[3],
      kind,
      strict: /^[A-Z][A-Z0-9_]*$/.test(m[3]) || m[4].includes('='),
      isPublic: kind !== null && PUBLIC_NAME_RE.test(m[3]),
      head: m[0].slice(0, m[0].length - (m[5] !== undefined ? m[5].length + m[6].length : m[7].length)),
      quote: m[5],
      quoted: m[6],
      bare: m[7],
    };
  });
  t = maskLabelled(t, RU_LABEL_RE, p, (m) => ({
    kind: /^\**парол/i.test(m[0]) ? 'password' : 'key',
    strict: false,
    isPublic: false,
    head: m[0].slice(0, m[0].length - (m[3] !== undefined ? m[3].length + m[4].length : m[5].length)),
    quote: m[3],
    quoted: m[4],
    bare: m[5],
  }));

  t = t.replace(AUTH_HEADER_RE, (m: string, head: string, v: string) => (looksRandom(v.replace(/=+$/, '')) ? head + p.hide() : m));
  // Уже скрытое не скрывается второй раз: иначе каждый проход дописывал бы «скрыт]».
  t = t.replace(CURL_USER_RE, (m: string, head: string, v: string) => (v.startsWith(SECRET_MASK.slice(0, 5)) ? m : head + p.hide()));
  for (const f of KNOWN_FORMATS) {
    t = t.replace(f.re, (m: string, at: number, whole: string) => (!f.check || f.check(m) ? p.hide(nameBefore(whole, at)) : m));
  }
  t = t.replace(RANDOM_RE, (m: string, at: number, whole: string) => {
    if (!looksRandom(m.replace(/=+$/, ''), { mixedCase: true, entropy: true })) return m;
    if (PUBLIC_FORMAT_RE.test(m) || insideBlob(whole, at, m.length)) return m;
    return secretWordBefore(whole, at) ? p.hide(nameBefore(whole, at)) : m;
  });

  const restore = (s: string): string => s.replace(HOLD_RE, (_m, i: string) => restore(kept[Number(i)]));
  return { text: restore(t), count, names };
}

/**
 * Что сказать ассистенту, когда в тексте для продукта (правка или описание при
 * заведении) нашлось похожее на ключ. Одна фраза на `edit` и `create`:
 * разъехавшись, они обещали бы человеку разное про один и тот же ключ.
 *
 * Условная («если это ключ…»): распознавание — догадка, и на ложном
 * срабатывании ассистент не должен велеть отозвать ключ, которого не было.
 * stored=false — правка не поставлена (отказ): заменять было нечего, но
 * значение уже прозвучало в переписке, и сказать об этом всё равно нужно.
 */
export function maskedSecretsSay(m: SecretsMasked, o: { stored?: boolean } = {}): string {
  const names = m.names.length ? ` (${m.names.join(', ')})` : '';
  const head = o.stored === false
    ? `В тексте для продукта были значения, похожие на ключи${names}; правка не поставлена, но значение уже было в переписке. `
    : `В тексте для продукта были значения, похожие на ключи${names}: платформа заменила их на «${SECRET_MASK}» — ` +
      'в продукт и модели правок они не попали. Скажи об этом пользователю. ';
  return (
    head +
    'Если это ключ — посоветуй выпустить новый и ввести его в защищённую карточку (действие keys; новому боту — ' +
    'карточка создания); в prompt ключи не вписывай. Если скрыто не ключ (ссылка, номер, идентификатор) — предложи ' +
    'ввести его в карточку keys под понятным именем: продукт прочитает его как переменную.'
  );
}

export function maskSecrets(input: string): MaskedSecrets {
  let text = typeof input === 'string' ? input.replace(/\u0000/g, '�') : '';
  let count = 0;
  const names: string[] = [];
  for (let i = 0; i < PASSES_MAX; i++) {
    const r = maskPass(text);
    if (r.count === 0) break;
    count += r.count;
    text = r.text;
    for (const n of r.names) if (!names.includes(n) && names.length < NAMES_MAX) names.push(n);
  }
  return { text, count, names };
}
