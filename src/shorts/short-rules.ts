import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortParagraph, ShortScript } from './shorts.types';

/**
 * Проверка сценария до отправки владельцу (спека, «Правила текста»).
 *
 * Стоп-слова — страховка от явного: главное держат промпт сценариста и
 * одобрение владельца. Ложное срабатывание дороже пропуска: переписок всего
 * две, и сценарий, который «нарушает» правило словом из жизни («налоговый
 * агент», «после смерти отца»), уходит в failed. Поэтому шаблоны ловят
 * только явное, а каждое сообщение называет правило, находку и место —
 * сценарист за один круг узнаёт всё, что исправить.
 */

/** Подписи от сценариста — до того, как код допишет ссылки. */
export interface WriterCaptions {
  telegram: string;
  vk: string;
  youtube: { title: string; description: string; tags: string[] };
}

export interface RulesInput {
  angle: ShortAngle;
  assistantName: string;
  script: ShortScript;
  captions: WriterCaptions;
  paragraphs: ShortParagraph[];
  answerText: string;
  /** Вопрос режиссёра: он стоит в кадре, его числа и слова — не выдумка сценариста. */
  sceneQuestion?: string;
  assistantsCount: number;
}

/**
 * Скорость речи при темпе 1.1, замер на ролике-образце: 619 знаков реплик
 * прозвучали за 42,5 с. Оценка нужна, чтобы сценарист поправил длину до
 * озвучки; окончательно длину проверяет таймлайн студии.
 */
export const CHARS_PER_SECOND = 14.5;
/** Коридор оценки уже, чем 30–60 с у студии: запас на погрешность оценки. */
export const MIN_ESTIMATED_SEC = 32;
export const MAX_ESTIMATED_SEC = 55;
export const MAX_HOOK_WORDS = 8;
export const MIN_ANSWER_LINES = 2;
export const MAX_ANSWER_LINES = 4;
/** Подарок новичку можно называть, хотя в ответе ассистента этого числа нет (правило 6). */
export const WELCOME_GIFT_TOKENS = 25000;
const GAP_SEC = 0.25;
const MIN_HOOK_SEC = 2;

const chars = (s: string): number => Array.from(String(s ?? '')).length;

export function estimateSpeechSec(script: ShortScript): number {
  return script.lines.reduce((sum, l) => {
    const sec = chars(l.text) / CHARS_PER_SECOND + GAP_SEC;
    return sum + (l.scene === 'hook' ? Math.max(MIN_HOOK_SEC, sec) : sec);
  }, 0);
}

// Число и, если есть, «тысяч» / «тыс.» / «млн» / «миллион» за ним.
const NUMBER = /(\d+(?:\s\d{3})*(?:[.,]\d+)?)(?:\s?(тысяч\p{L}*|тыс\.?|млн\.?|миллион\p{L}*)(?![\p{L}]))?/giu;

/** «1.5» × 1000 → «1500» — сдвигом запятой, без погрешности float. */
function scaleUp(n: string, zeros: number): string {
  if (!zeros) return n;
  const [int, frac = ''] = n.split('.');
  const digits = int + frac.padEnd(zeros, '0');
  const whole = digits.slice(0, int.length + zeros).replace(/^0+(?=\d)/, '');
  const rest = digits.slice(int.length + zeros);
  return rest ? `${whole}.${rest}` : whole;
}

/**
 * Числа текста одной записью: «25 000» → «25000», «1,5» → «1.5»,
 * «25 тысяч» и «25 тыс.» → «25000», «1,5 млн» → «1500000» — чтобы пересказ
 * «25 тысяч» при «25 000 ₽» в ответе не считался выдуманным числом.
 */
export function numbersIn(text: string): string[] {
  return Array.from(String(text ?? '').matchAll(NUMBER), (m) => {
    const n = m[1].replace(/\s/g, '').replace(',', '.');
    const zeros = !m[2] ? 0 : /^т/iu.test(m[2]) ? 3 : 6;
    return scaleUp(n, zeros);
  });
}

interface TextRule {
  /** Начало сообщения: «правило 6» или «правила 2 и 7». */
  rule: string;
  /** Суть: что не так и как исправить. */
  what: string;
  /** Шаблон с флагом g: проверка собирает все вхождения, а не первое. */
  pattern: RegExp;
  /**
   * Находка есть в ответе ассистента или в вопросе (без учёта регистра, ё = е) —
   * это пересказ, а не выдумка сценариста. Модели, конкуренты, Юля, политика,
   * бренды и брань не пропускаются никогда.
   */
  allowFromAnswer?: boolean;
  /** Только в провокационной подаче. */
  provocativeOnly?: boolean;
  /** Предложение с находкой, где есть и это, — не нарушение. */
  unlessSentence?: RegExp;
}

// Границы слова: (?<![\p{L}]) перед ним и (?![\p{L}]) после — иначе «сбер»
// ловил бы «сбережения», «трамп» — «трамплин», а «которые» — «некоторые».
// Шаблон может кончаться основой («бесплатн»): в сообщение уходит слово
// целиком, а с ответом сверяется основа — «бесплатно» в пересказе абзаца
// про «бесплатную помощь» нарушением не считается.

/** Деньги и закон в разговоре, а не инструкция: «законно», «вычет», «если владели больше пяти лет». */
const LAWFUL = /законн|легальн|вычет|льгот|освобожд|имеете\s+право|не\s+обязан|дважды|лишн|переплат|(?<![\p{L}])(?:если|когда|пока)(?![\p{L}])/iu;

/** Действия, к которым нельзя подталкивать (правило 15), — неопределённая форма. */
const UNLAWFUL_ACTS = [
  'не\\s+платить\\s+(?:налог|алимент|ндфл)',
  'уйти\\s+от\\s+(?:уплаты\\s+)?налог',
  'уклониться\\s+от\\s+(?:уплаты\\s+)?(?:налог|алимент)',
  'скрыть\\s+(?:доход|заработ|имуществ|зарплат)',
  'спрятать\\s+(?:доход|имуществ)',
  '(?:скрыть|спрятать)\\s+(?:деньги|сбережени|квартир|машин)\\p{L}*(?:\\s+\\p{L}+){0,2}?\\s+от\\s+(?:пристав|налогов|кредитор|банк|суд|взыскател|фнс|государств)',
  'обойти\\s+закон',
  'выселить(?:\\s+\\p{L}+){0,3}?\\s+без\\s+суда',
  'не\\s+(?:возвращать|отдавать)\\s+(?:долг|залог|кредит|займ)',
  'обмануть\\s+(?:банк|налогов|суд|пристав|страхов|фнс)',
  'получать\\s+(?:зарплат\\p{L}*\\s+)?в\\s+конверте',
].join('|');

/**
 * Те же действия повелительно: «не платите налог», «скройте доход». «Не платите»
 * — только когда за предметом конец фразы или «с аренды», «за квартиру»:
 * «не платите алименты наличными» — совет, как платить, а не призыв не платить.
 */
const UNLAWFUL_ORDERS = [
  'не\\s+платите\\s+(?:налог|алимент|ндфл)\\p{L}*(?=\\s*(?:$|[^\\p{L}\\p{N}\\s]|(?:с|со|за|на|вообще|совсем|никогда|государству)(?![\\p{L}])))',
  'уйдите\\s+от\\s+(?:уплаты\\s+)?налог',
  'скройте\\s+(?:доход|заработ|имуществ|зарплат)',
  'спрячьте\\s+(?:доход|имуществ)',
  '(?:скройте|спрячьте)\\s+(?:деньги|сбережени|квартир|машин)\\p{L}*(?:\\s+\\p{L}+){0,2}?\\s+от\\s+(?:пристав|налогов|кредитор|банк|суд|взыскател|фнс|государств)',
  'обойдите\\s+закон',
  '(?<!(?<![\\p{L}])не\\s+)(?:получайте|берите)\\s+(?:зарплат\\p{L}*\\s+)?в\\s+конверте',
].join('|');

const TEXT_RULES: TextRule[] = [
  {
    rule: 'правило 1',
    what: 'число пользователей и отзывы не называем',
    pattern: /(?<![\p{L}])(?:(?:тысяч|миллион|сотн|десятк)\p{L}*\s+(?:пользовател|клиент)\p{L}*\s+(?:уже|доверя|выбира|выбрал)|наш(?:и|их|им|ими)?\s+(?:пользовател|клиент)|отзыв\p{L}*\s+(?:наших|довольных)\s+(?:пользовател|клиент))/giu,
    allowFromAnswer: true,
  },
  {
    // Версия — часть названия: «GPT-4o», «Veo3», «Kling2.1»; «video» и «soraway» — нет.
    rule: 'правила 2 и 7',
    what: 'названы модель, провайдер или конкурент',
    pattern: /(?<![\p{L}\p{N}])(?:chat\s*gpt|yandex\s*gpt|gpt|openai|anthropic|claude|gemini|gigachat|deepseek|perplexity|copilot|midjourney|kling|veo|sora|llama|mistral|qwen|grok)(?:-?\d+(?:\.\d+)*[a-z]?)?(?![a-z])/giu,
  },
  {
    rule: 'правила 2 и 7',
    what: 'названы модель, провайдер или конкурент',
    pattern: /(?<![\p{L}])(?:чат[\s-]*гпт|гпт|гигачат\p{L}*|клод(?:а|у|ом|е)?|джемини|дипсик(?:а|у|ом|е)?|клинг(?:а|у|ом|е)?|алис(?:а|ы|е|у|ой|ою))(?![\p{L}])/giu,
  },
  {
    // «Залог никуда не уходит» — не про данные: без слова о данных не ловим.
    rule: 'правило 3',
    what: '«анонимно» и «данные никуда не уходят» не пишем',
    pattern: /(?<![\p{L}])(?:анонимн|(?:данн|информаци|переписк|сообщени|разговор|диалог)\p{L}*(?:\s+\p{L}+){0,3}?\s+никуда\s+не\s+(?:уход|переда|утека|попада)|никуда\s+не\s+(?:уход|переда|утека|попада)\p{L}*(?:\s+\p{L}+){0,2}?\s+(?:данн|информаци|переписк)|не\s+переда[её]м(?:\s+\p{L}+){0,2}?\s+(?:данн|информаци|переписк)|не\s+передаются\s+третьим)/giu,
    allowFromAnswer: true,
  },
  {
    // «Найти пару» — только когда за ней конец фразы или «для/на/по/в/среди…»:
    // перечнем исключений («пару минут, часов…») не закрыть «пару надёжных юристов».
    // «до свидания» — прощание, не свидание.
    rule: 'правило 4',
    what: 'поиск единомышленников не называем знакомствами и дейтингом',
    pattern: /(?<![\p{L}])(?:(?:сайт|приложени|сервис|платформ|площадк|чат|бот)\p{L}*\s+(?:для\s+)?знакомств|дейтинг|dating|(?:найти|найдите|найдёте|найдете|ищете|ищешь|ищет|ищут|ищу|искать|поиск)(?:\s+себе)?\s+пар[уы](?![\p{L}])(?=\s*$|\s*[^\p{L}\p{N}\s]|\s+(?:для|на|по|в|во|среди|мечты|жизни|себе)(?![\p{L}]))|втор(?:ая|ую|ой|ые|ых)\s+половинк|(?<!(?<![\p{L}])до\s+)свидани(?:е|я|й|и|ю|ем|ях)(?![\p{L}]))/giu,
    allowFromAnswer: true,
  },
  {
    // Только про продукт: «налоговый агент», «агент по недвижимости», «агентство» — не про нас.
    rule: 'правило 5',
    what: '«ассистент», а не «агент»',
    pattern: /(?<![\p{L}])(?:(?:ии|ai)[\s-]*агент(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![\p{L}])|(?:наш|умн|виртуальн|персональн)\p{L}*\s+агент(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![\p{L}])(?!\s+по(?![\p{L}]))|агент(?:а|у|ом|е|ы|ов|ам|ами|ах)?\s+(?:linkeon|линкеон))/giu,
    allowFromAnswer: true,
  },
  {
    rule: 'правило 6',
    what: 'не обещаем «бесплатно», подарок новичку называем «25 000 токенов»',
    pattern: /(?<![\p{L}])бесплатн/giu,
    allowFromAnswer: true,
  },
  {
    // Снятая ассистентка в базе — «Юлия»; «юла» и «июля» — не она.
    rule: 'правило 7',
    what: 'Юлю не упоминаем',
    pattern: /(?<![\p{L}])(?:юл[яиюе]|юлей|юли[яию]|юлией)(?![\p{L}])/giu,
  },
  {
    // «Санкции» — только политические: штрафные санкции по договору — не политика.
    // «Бог» не ловим: «не дай бог» и «слава богу» — не религия.
    // «Война за наследство», «война с соседями» — спор, а не политика.
    rule: 'правило 11',
    what: 'без политики и религии',
    pattern: /(?<![\p{L}])(?:(?:путин|зеленск|байден|госдум|депутат|мобилизац|митинг|оппозиц|религи|ислам|мусульм|христиан|православ|иуде|будди|антисанкц)\p{L}*|трамп(?:а|у|ом|е)?(?![\p{L}])|церк(?:овь|ви|вей|вям|вями|вях|овн\p{L}*)(?![\p{L}])|войн(?:а|е|у|ы|ой|ам|ами|ах)?(?![\p{L}])(?!\s+за(?![\p{L}]))(?!\s+со?\s+(?:сосед|бывш|т[её]щ|свекр|родствен|начальн|коллег|хозя|арендатор|жильц|налогов|банк|коллектор|застройщик|управляющ))|выбор(?:ы|ов|ах|ам)(?![\p{L}])|под\s+санкци\p{L}*|(?:западн|американск|европейск|международн|антироссийск)\p{L}*\s+санкци\p{L}*|санкци\p{L}*\s+(?:запад\p{L}*|ес|сша|евросоюз\p{L}*|европ\p{L}*)(?![\p{L}])|санкци\p{L}*\s+против\s+(?:росси|рф|стран|государств|нас|наш|запад|сша|китая|ирана|белорус)\p{L}*)/giu,
  },
  {
    // Запугивание, а не тема: «после смерти отца», «страх смерти» — можно; «вы не умрёте» — тоже.
    rule: 'правило 12',
    what: 'без запугивания здоровьем',
    pattern: /(?<![\p{L}])(?:(?<!(?<![\p{L}])не\s+)(?:умр[её]те|умр[её]шь|погибн[её]те|погибн[её]шь)(?![\p{L}])|(?:можете|можешь)\s+(?:умереть|погибнуть)(?![\p{L}])|смертельно\s+опасн|(?:убь[её]т|убьют)\s+(?:вас|тебя)(?![\p{L}])|(?:вас|тебя)\s+(?:убь[её]т|убьют)(?![\p{L}])|опасно\s+для\s+жизни)/giu,
    allowFromAnswer: true,
  },
  {
    rule: 'правило 12',
    what: 'инфаркт и инсульт упоминаем только в спокойной подаче',
    pattern: /(?<![\p{L}])(?:инфаркт|инсульт)/giu,
    allowFromAnswer: true,
    provocativeOnly: true,
  },
  {
    rule: 'правило 13',
    what: 'названа компания или бренд',
    pattern: /(?<![\p{L}])(?:сбер(?:банк\p{L}*|а|е|у|ом)?|тинькофф?\p{L}*|т-банк\p{L}*|втб|альфа-банк\p{L}*|газпром\p{L}*|авито|циан(?:а|е|у|ом)?|озон(?:а|е|у|ом)?|ozon|wildberries|вайлдберриз|яндекс\p{L}*|google|гугл\p{L}*|apple|samsung|макдоналдс|starbucks|старбакс)(?![\p{L}])/giu,
  },
  {
    // Корни мата — от начала слова или после приставки: «застрахуйте», «хлебать»,
    // «колебаться», «себя», «ребёнок», «употреблять», «бляшки», «скипидар» — не брань.
    rule: 'правило 14',
    what: 'без брани и оскорблений',
    pattern: /(?<![\p{L}])(?:(?:на|по|о|а|об|от|при|за|до|вы|рас|раз|с|у|пере|под|ни)?ху[йеёяию]|(?:за|на|у|вы|до|от|отъ|об|объ|при|про|по|пере|недо|разъ|подъ|изъ|съ|въ|долбо)?[её]б(?:[аулн]|ыв|ис|ош|ёт|ет|(?![\p{L}]))|(?:вы)?бля(?:ть|д\p{L}*)?(?![\p{L}])|сук[аи](?![\p{L}])|мудак|мудил|дебил|идиот|придур|тупиц|пид[оа]р|лох(?:и|ов|ам|а|у|ом)?(?![\p{L}]))|пизд/giu,
  },
  {
    // Насмешка — когда рядом сам сервис: «Те, кто не пользуется вычетом, теряют деньги» — не она.
    // «Сервис» — только «наш / этот / такой»: «не пользуются сервисами доставки» — не про нас.
    rule: 'правило 14',
    what: 'без насмешек над теми, кто не пользуется сервисом',
    pattern: /(?<![\p{L}])(?:кто|которые|которых|которым)(?:\s+(?:ещё|еще|до\s+сих\s+пор|вс[её]\s+ещ[её]|пока|никогда))*\s+не\s+(?:пользу|знает|знают|слышал)\p{L}*(?:\s+[\p{L}\p{N}-]+){0,5}?\s+(?:(?<=(?:наш|эт|так)\p{L}*\s+)сервис|ассистент|нейросет|чат-?бот|linkeon|линкеон|(?:ии|ai)(?![\p{L}]))/giu,
    allowFromAnswer: true,
  },
  {
    // Инструкция, а не разговор о риске: «что будет, если не платить налог» — можно.
    rule: 'правило 15',
    what: 'не подталкиваем к нарушению закона (можно «что будет, если…»)',
    pattern: new RegExp(`(?<![\\p{L}])(?:как|способ\\p{L}*|схем\\p{L}*|лайфхак\\p{L}*)(?:[\\s,:—–-]+[\\p{L}-]+)?[\\s,:—–-]+(?:${UNLAWFUL_ACTS})`, 'giu'),
    allowFromAnswer: true,
    unlessSentence: LAWFUL,
  },
  {
    // Вопрос «Не платите налог с аренды?» и «не платите налог дважды» — не подталкивание.
    rule: 'правило 15',
    what: 'не подталкиваем к нарушению закона (можно «что будет, если…»)',
    pattern: new RegExp(`(?<![\\p{L}])(?:${UNLAWFUL_ORDERS})`, 'giu'),
    allowFromAnswer: true,
    unlessSentence: new RegExp(`\\?|${LAWFUL.source}`, 'iu'),
  },
];

/** Утверждение о чувствах зрителя (правило 9). Вопросом — можно; «Соседи устали» — не про зрителя. */
const FEELING = /(?<![\p{L}])(?:боитесь|переживаете|злитесь|мечтаете|чувствуете|сомневаетесь|волнуетесь|стесняетесь|ненавидите|боишься|переживаешь|злишься|мечтаешь|чувствуешь|сомневаешься|волнуешься|стесняешься|ненавидишь|(?:вам|тебе)\s+(?:страшно|стыдно|тревожно|обидно|надоело|одиноко))(?![\p{L}])|(?:^[^\p{L}]*|(?<![\p{L}])вы\s+)устали(?![\p{L}])/iu;
const BRAND_SPOKEN = /linkeon|линкеон/iu;
const isQuestion = (s: string): boolean => /\?[!?]*["'»”)\s]*$/.test(s.trim());
const LETTER = /\p{L}/u;
const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Предложение, в котором стоит находка. */
function sentenceAt(text: string, from: number, to: number): string {
  let start = from;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  return text.slice(start, to) + /^[^.!?\n]*[.!?]*/.exec(text.slice(to))[0];
}

/** Все вхождения правила: core — что совпало (с ним сверяется ответ), finding — слова целиком. */
function hitsOf(r: TextRule, text: string): { core: string; finding: string }[] {
  const hits: { core: string; finding: string }[] = [];
  for (const m of text.matchAll(r.pattern)) {
    let from = m.index ?? 0;
    let to = from + m[0].length;
    if (r.unlessSentence && r.unlessSentence.test(sentenceAt(text, from, to))) continue;
    while (from > 0 && LETTER.test(text[from - 1])) from--;
    while (to < text.length && LETTER.test(text[to])) to++;
    hits.push({ core: m[0], finding: text.slice(from, to).replace(/\s+/g, ' ').trim() });
  }
  return hits;
}

export function checkScriptRules(i: RulesInput): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    if (!out.includes(m)) out.push(m);
  };
  const s = i.script;
  const known = new Set(i.paragraphs.map((p) => p.n));
  const scene = (name: string) => s.lines.filter((l) => l.scene === name);

  // Раскадровка: зацепка → вопрос → ответ → финал.
  const hook = String(s.hook ?? '').trim();
  // Тире и прочие знаки — не слова.
  const hookWords = hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  if (!hook) add('нет зацепки');
  else if (hookWords > MAX_HOOK_WORDS) add(`зацепка длиннее ${MAX_HOOK_WORDS} слов`);
  const ORDER = ['hook', 'question', 'answer', 'final'];
  let at = 0;
  for (const l of s.lines) {
    const k = ORDER.indexOf(l.scene);
    if (k < at) {
      add(`реплика ${l.id}: сцены идут не по порядку зацепка → вопрос → ответ → финал`);
      break;
    }
    at = k;
  }
  const hooks = scene('hook');
  if (hooks.length !== 1) add('зацепка — ровно одна реплика');
  else if (hooks[0].text.trim() !== hook) add('текст реплики зацепки должен совпадать с зацепкой');
  if (!scene('question').length) add('нет реплики вопроса');
  const answers = scene('answer');
  if (answers.length < MIN_ANSWER_LINES || answers.length > MAX_ANSWER_LINES) {
    add(`реплик ответа ${answers.length} — нужно ${MIN_ANSWER_LINES}–${MAX_ANSWER_LINES}`);
  }
  for (const l of answers) {
    if (l.box === undefined || l.box === null || !known.has(l.box)) {
      add(`правило 8: реплика ${l.id} не опирается на снятый абзац (box ${l.box ?? 'не указан'})`);
    }
  }
  for (const l of s.lines) {
    if (l.scene !== 'answer' && l.box !== undefined && l.box !== null) add(`реплика ${l.id} сцены ${l.scene} не должна ссылаться на абзац`);
  }
  if (scene('final').length !== 1) add('финал — ровно одна реплика');

  // Подача.
  const provocative = PROVOCATIVE_ANGLES.includes(i.angle);
  if (s.hookBox === undefined || s.hookBox === null) {
    if (provocative) add('правило 10: у провокационной зацепки нет опоры — укажи hookBox');
  } else if (!known.has(s.hookBox)) {
    add(`правило 10: hookBox ${s.hookBox} — такого абзаца в ответе нет`);
  }
  const hookPlace = hooks.length === 1 ? `реплика ${hooks[0].id}` : 'зацепка';
  for (const sentence of hook.split(/(?<=[.!?…])\s+/)) {
    const m = isQuestion(sentence) ? null : sentence.match(FEELING);
    if (m) {
      const finding = m[0].replace(/^[^\p{L}]+/u, '').trim();
      add(`правило 9: зацепка утверждает за зрителя, что он чувствует (спроси или скажи факт из ответа) — «${finding}» (${hookPlace})`);
    }
  }
  if (provocative && isHealthAssistant(i.assistantName)) add('правило 12: темы здоровья — только в спокойной подаче');

  // Длина по оценке.
  const est = estimateSpeechSec(s);
  if (est < MIN_ESTIMATED_SEC) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: добавь реплику или перескажи абзац подробнее`);
  }
  if (est > MAX_ESTIMATED_SEC) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${MIN_ESTIMATED_SEC}–${MAX_ESTIMATED_SEC} с: сократи реплики`);
  }

  // Тексты сценариста, у каждого — место. Финал пишет код, его здесь нет.
  const spoken = s.lines.filter((l) => l.scene !== 'final');
  if (spoken.some((l) => BRAND_SPOKEN.test(l.text))) add('название сервиса звучит только в финале — убери его из реплик');
  const c = i.captions;
  const texts = [
    ...spoken.map((l) => ({ place: `реплика ${l.id}`, text: l.text })),
    { place: 'подпись telegram', text: c.telegram },
    { place: 'подпись vk', text: c.vk },
    { place: 'youtube.title', text: c.youtube.title },
    { place: 'youtube.description', text: c.youtube.description },
    // Через запятую: соседние теги не складываются в одну фразу.
    { place: 'youtube.tags', text: (c.youtube.tags ?? []).join(', ') },
  ].map((t) => ({ place: t.place, text: String(t.text ?? '') }));
  const source = norm(`${i.answerText ?? ''}\n${i.sceneQuestion ?? ''}`);
  for (const r of TEXT_RULES) {
    if (r.provocativeOnly && !provocative) continue;
    for (const t of texts) {
      for (const hit of hitsOf(r, t.text)) {
        if (r.allowFromAnswer && source.includes(norm(hit.core))) continue;
        add(`${r.rule}: ${r.what} — «${hit.finding}» (${t.place})`);
      }
    }
  }
  const allowed = new Set([
    ...numbersIn(i.answerText),
    ...numbersIn(i.sceneQuestion ?? ''),
    String(i.assistantsCount),
    String(WELCOME_GIFT_TOKENS),
  ]);
  for (const t of texts) {
    for (const n of numbersIn(t.text)) {
      if (!allowed.has(n)) add(`правило 1: числа ${n} нет в ответе ассистента (${t.place})`);
    }
  }
  return out;
}
