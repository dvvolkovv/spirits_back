import { isHealthAssistant } from './short-assistants';
import { MAX_SKIT_LINE_WORDS, MAX_SKIT_WORDS, SKIT_KINDS, Skit, SkitKind, wordCount } from './short-skit-prompts';
import { TROUPE, heroById } from './short-troupe';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortFormat, ShortParagraph, ShortScript } from './shorts.types';

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
  /** Формат ролика; без него — chat, как в плане 2. */
  format?: ShortFormat;
  /** Сценки ролика формата skit — поля от режиссёра и сценариста, до сборки промптов. */
  skits?: Partial<Record<SkitKind, Skit>>;
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

/**
 * Зацепка ролика со сценками — немая надпись поверх конфликта: её читают за 3 с,
 * поэтому она короче, чем у озвученной зацепки (спека сценок, «Что уточнил образец»).
 */
export const MAX_SKIT_HOOK_WORDS = 6;
/** Пересказ ответа голосом ассистента в ролике со сценками — 1–2 реплики (спека сценок, «Кто пишет сценки»). */
export const MIN_SKIT_ANSWER_LINES = 1;
export const MAX_SKIT_ANSWER_LINES = 2;
/**
 * Коридор оценки озвучки ролика со сценками: с двумя клипами по 8 с ролик
 * должен уложиться в 25–45 с у студии; запас — на погрешность оценки.
 */
export const MIN_SKIT_ESTIMATED_SEC = 11;
export const MAX_SKIT_ESTIMATED_SEC = 26;
/** Как сценка называется в нарушениях и подписях владельцу — так же её зовёт студия. */
export const SKIT_LABELS: Record<SkitKind, string> = { conflict: 'сценка 1 (конфликт)', punchline: 'сценка 2 (развязка)' };

const normRole = (s: unknown): string => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Роль из списка героя — или она же с уточнением целыми словами: «хозяйка квартиры на Тверской», но не «соседка» у «сосед». */
const roleFits = (role: unknown, roles: string[]): boolean => {
  const r = normRole(role);
  return roles.map(normRole).some((x) => r === x || r.startsWith(`${x} `));
};

/** Ремарки — скобки, звёздочки, подчёркивания: Omni прочтёт их вслух. Движения — в action. */
const STAGE_DIRECTION = /[()[\]*_]/;
const CYRILLIC = /[а-яё]/i;

/**
 * Правила 16–18 и форма сценки — до промптов и до денег (спека сценок,
 * «Правила»). Режиссёр проверяет сценку 1 (абзацев ответа у него ещё нет —
 * paragraphs = null), сценарист — обе. Каждое сообщение называет сценку.
 */
export function checkSkitRules(skit: unknown, kind: SkitKind, paragraphs: ShortParagraph[] | null): string[] {
  const at = SKIT_LABELS[kind];
  const out: string[] = [];
  const add = (m: string) => {
    const t = `${at}: ${m}`;
    if (!out.includes(t)) out.push(t);
  };
  if (!skit || typeof skit !== 'object') return [`${at}: сценки нет`];
  const s = skit as Partial<Skit>;
  // Место, первый кадр и действие идут прямо в промпты генераторов: русский текст
  // и текст в кавычках генератор картинок рисует надписью.
  for (const f of ['setting', 'opening', 'action'] as const) {
    const v: unknown = s[f];
    if (typeof v !== 'string' || !v.trim()) add(`нет поля ${f}`);
    else if (/[а-яё«»"“”„]/i.test(v)) add(`поле ${f} — по-английски и без кавычек: оно идёт прямо в промпт генератора`);
  }
  // Правило 16: только герои труппы, разные, у каждого роль из его списка.
  const cast = Array.isArray(s.cast) ? s.cast : [];
  if (cast.length < 2 || cast.length > 3) add(`в составе ${cast.length} героев — нужно 2–3`);
  const inCast = new Set<string>();
  for (const c of cast) {
    const hero = heroById(String(c?.hero ?? ''));
    if (!hero) {
      add(`правило 16: героя «${c?.hero}» нет в труппе — есть ${TROUPE.map((h) => h.id).join(', ')}`);
      continue;
    }
    if (inCast.has(hero.id)) add(`правило 16: ${hero.name} в составе дважды`);
    inCast.add(hero.id);
    if (!roleFits(c?.role, hero.roles)) {
      add(`правило 16: роль «${String(c?.role ?? '').trim()}» не из ролей героя ${hero.name} (${hero.roles.join(', ')})`);
    }
  }
  if (cast.length && !inCast.has('kesha')) add('правило 16: Капибара Кеша (kesha) играет в каждой сценке — добавь его в состав');
  // Правило 17: 1–3 реплики, каждая до 12 слов, вместе до 25.
  const lines = Array.isArray(s.lines) ? s.lines : [];
  if (lines.length < 1 || lines.length > 3) add(`правило 17: реплик ${lines.length} — нужно 1–3`);
  let total = 0;
  lines.forEach((l, i) => {
    const text = typeof l?.text === 'string' ? l.text.trim() : '';
    if (!text) {
      add(`реплика ${i + 1} пустая`);
      return;
    }
    if (!inCast.has(String(l?.hero))) add(`реплика ${i + 1}: говорит «${l?.hero}», а его нет в составе`);
    if (STAGE_DIRECTION.test(text)) add(`реплика ${i + 1}: только слова, которые звучат — ремарки в скобках и звёздочках Omni прочтёт вслух, движения пиши в action`);
    if (!CYRILLIC.test(text)) add(`реплика ${i + 1} — по-русски: герои говорят по-русски`);
    const n = wordCount(text);
    total += n;
    if (n > MAX_SKIT_LINE_WORDS) add(`правило 17: реплика ${i + 1} — ${n} слов, больше ${MAX_SKIT_LINE_WORDS}`);
  });
  if (total > MAX_SKIT_WORDS) add(`правило 17: в репликах ${total} слов, больше ${MAX_SKIT_WORDS}`);
  // Правило 18: советов по существу герои не дают; утверждение по существу —
  // только в развязке и со ссылкой на абзац настоящего ответа.
  const boxed = lines.filter((l) => l?.box !== undefined && l?.box !== null);
  if (kind === 'conflict') {
    if (boxed.length) add('правило 18: в конфликте герои не дают советов по существу — у реплик сценки 1 не бывает box');
  } else {
    if (!boxed.length) add('правило 18: утверждение по существу в развязке ссылается на абзац ответа — укажи box у этой реплики');
    if (paragraphs) {
      const known = new Set(paragraphs.map((p) => p.n));
      for (const l of boxed) if (!known.has(Number(l.box))) add(`правило 18: box ${l.box} — такого абзаца в ответе нет`);
    }
  }
  return out;
}

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

/** Числа текста: value — одной записью для сравнения, raw — как написано (для сообщения). */
function numberHits(text: string): { value: string; raw: string }[] {
  return Array.from(String(text ?? '').matchAll(NUMBER), (m) => {
    const n = m[1].replace(/\s/g, '').replace(',', '.');
    const zeros = !m[2] ? 0 : /^т/iu.test(m[2]) ? 3 : 6;
    return { value: scaleUp(n, zeros), raw: m[0].replace(/\s+/g, ' ') };
  });
}

/**
 * Числа текста одной записью: «25 000» → «25000», «1,5» → «1.5»,
 * «25 тысяч» и «25 тыс.» → «25000», «1,5 млн» → «1500000» — чтобы пересказ
 * «25 тысяч» при «25 000 ₽» в ответе не считался выдуманным числом.
 */
export function numbersIn(text: string): string[] {
  return numberHits(text).map((h) => h.value);
}

/** Где стоит находка: предложение целиком и его хвост после находки. */
interface HitContext {
  sentence: string;
  after: string;
}

interface TextRule {
  /** Начало сообщения: «правило 6» или «правила 2 и 7». */
  rule: string;
  /** Суть: что не так и как исправить. */
  what: string;
  /** Шаблон с флагом g: проверка собирает все вхождения, а не первое. */
  pattern: RegExp;
  /**
   * Пересказ, а не выдумка сценариста: то же правило срабатывает в ответе
   * ассистента или в вопросе на ту же основу (без учёта регистра, ё = е).
   * Срабатывает — значит, прошло и границы слова, и «не» перед ним, и unless:
   * «небесплатная» в ответе не открывает «бесплатно» у сценариста. Модели,
   * конкуренты, Юля, политика, бренды и брань не пропускаются никогда.
   */
  allowFromAnswer?: boolean;
  /** Только в провокационной подаче. */
  provocativeOnly?: boolean;
  /** Находка в таком окружении — не нарушение. */
  unless?: (at: HitContext) => boolean;
}

/** Шаблон из частей: каждая — отдельный литерал (их синтаксис проверяет tsc), вместе — «или». */
function anyOf(...parts: RegExp[]): RegExp {
  return new RegExp(parts.map((p) => `(?:${p.source})`).join('|'), 'giu');
}

// Границы слова: (?<![\p{L}]) перед ним и (?![\p{L}]) после — иначе «сбер»
// ловил бы «сбережения», «трамп» — «трамплин», а «которые» — «некоторые».
// Шаблон может кончаться основой («бесплатн»): в сообщение уходит слово
// целиком, а с ответом сверяется основа — «бесплатно» в пересказе абзаца
// про «бесплатную помощь» нарушением не считается.

/** Деньги и закон в разговоре, а не инструкция: «законно», «вычет», «льгота», «дважды». */
const LAWFUL_WORDS = /законн|легальн|вычет|льгот|освобожд|имеете\s+право|не\s+обязан|дважды|лишн|переплат/iu;
/** То же плюс условие: «не платите налог, если владели квартирой больше пяти лет». */
const LAWFUL = new RegExp(`${LAWFUL_WORDS.source}|(?<![\\p{L}])(?:если|когда|пока)(?![\\p{L}])`, 'iu');
/** Хвост до «?» без тире и запятой: «Не платите налог с аренды?» — вопрос, «Не платите налоги — кто проверит?» — нет. */
const QUESTION_TAIL = /^(?:(?!\s-\s)[^,—–.!?\n])*\?/u;

/**
 * Действия правила 15, у которых есть законное условное прочтение: «не платить
 * налог, если владели квартирой больше пяти лет», «не возвращать залог, если
 * жилец испортил мебель». Для них «если / когда / пока» снимает находку.
 */
const EXEMPT_ACTS = [
  /не\s+платить\s+(?:налог|алимент|ндфл)/u,
  /не\s+(?:возвращать|отдавать)\s+(?:долг|залог|кредит|займ)/u,
];
/** Действия без законного прочтения: условие («Как скрыть доход, если сдаёте посуточно») их не снимает. */
const UNLAWFUL_ACTS = [
  /уйти\s+от\s+(?:уплаты\s+)?налог/u,
  /уклониться\s+от\s+(?:уплаты\s+)?(?:налог|алимент)/u,
  /скрыть\s+(?:доход|заработ|имуществ|зарплат)/u,
  /спрятать\s+(?:доход|имуществ)/u,
  /(?:скрыть|спрятать)\s+(?:деньги|сбережени|квартир|машин)\p{L}*(?:\s+\p{L}+){0,2}?\s+от\s+(?:пристав|налогов|кредитор|банк|суд|взыскател|фнс|государств)/u,
  /обойти\s+закон/u,
  /выселить(?:\s+\p{L}+){0,3}?\s+без\s+суда/u,
  /обмануть\s+(?:банк|налогов|суд|пристав|страхов|фнс)/u,
  /получать\s+(?:зарплат\p{L}*\s+)?в\s+конверте/u,
];
/**
 * «Как / способ / схема / лайфхак», до трёх слов и действие: «Как сдавать
 * квартиру и не платить налог». Промежуток рвут «может / можно», «если / когда /
 * пока / что / ли» и «попытку» — там рассказ, а не совет: «Узнайте, как хозяин
 * может выселить вас без суда», «Как налоговая узнает, если скрыть доход»,
 * «Как наказывают за попытку скрыть доход». Слова промежутка — только буквы,
 * разделители — только знаки: иначе «как» и строка дефисов проверялись бы минуты.
 */
const HOW = /(?<![\p{L}])(?:как|способ\p{L}*|схем\p{L}*|лайфхак\p{L}*)(?:[\s,:—–-]+(?!(?:может|могут|можно|мог|могла|могли|если|когда|пока|что|ли|попытк\p{L}*)(?![\p{L}]))\p{L}+){0,3}?[\s,:—–-]+/u;
const howTo = (acts: RegExp[]) => new RegExp(`${HOW.source}(?:${acts.map((a) => a.source).join('|')})`, 'giu');

/**
 * Те же действия повелительно. «Не платите» — только когда за предметом конец
 * фразы, «с аренды», «за квартиру», «и…», «бывшему»: «не платите алименты
 * наличными» — совет, как платить, а не призыв не платить.
 */
const EXEMPT_ORDERS = [
  /не\s+платите\s+(?:налог|алимент|ндфл)\p{L}*(?=\s*(?:$|[^\p{L}\p{N}\s]|(?:с|со|за|на|и|вообще|совсем|никогда|государству|бывш\p{L}*)(?![\p{L}])))/u,
];
const UNLAWFUL_ORDERS = [
  /уйдите\s+от\s+(?:уплаты\s+)?налог/u,
  /скройте\s+(?:доход|заработ|имуществ|зарплат)/u,
  /спрячьте\s+(?:доход|имуществ)/u,
  /(?:скройте|спрячьте)\s+(?:деньги|сбережени|квартир|машин)\p{L}*(?:\s+\p{L}+){0,2}?\s+от\s+(?:пристав|налогов|кредитор|банк|суд|взыскател|фнс|государств)/u,
  /обойдите\s+закон/u,
  /(?<!(?<![\p{L}])не\s+)(?:получайте|берите|платите|выдавайте)\s+(?:\p{L}+\s+)?(?:зарплат\p{L}*\s+)?в\s+конверте/u,
];
const ordered = (acts: RegExp[]) => new RegExp(`(?<![\\p{L}])(?:${acts.map((a) => a.source).join('|')})`, 'giu');

const TEXT_RULES: TextRule[] = [
  {
    // Про собственных пользователей сервиса: «отзывы клиентов» на сайте кофейни — не про нас,
    // «тысячи людей уже потеряли залог» — тоже.
    rule: 'правило 1',
    what: 'число пользователей и отзывы не называем',
    pattern: anyOf(
      /(?<![\p{L}])(?:тысяч|миллион|сотн|десятк)\p{L}*\s+(?:пользовател|клиент)\p{L}*\s+(?:уже|доверя|выбира|выбрал)/u,
      /(?<![\p{L}])(?:тысяч|миллион|сотн|десятк)\p{L}*\s+(?:людей|человек)\s+(?:уже\s+)?(?:пользу|доверя|выбира|выбрал)/u,
      /(?<![\p{L}])на[мс]\s+(?:доверя|выбира|выбрал|пользу)\p{L}*\s+(?:уже\s+)?(?:тысяч|миллион|сотн|десятк|более|больше|свыше)/u,
      /(?<![\p{L}])наш(?:и|их|им|ими)?\s+(?:пользовател|клиент)/u,
      /(?<![\p{L}])отзыв\p{L}*\s+(?:наших|довольных)\s+(?:пользовател|клиент)/u,
      /(?<![\p{L}])отзыв\p{L}*(?:\s+\p{L}+){0,3}?\s+говорят\s+сами\s+за\s+себя/u,
    ),
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
    pattern: anyOf(
      /(?<![\p{L}])аноним(?:ен|н)/u,
      /(?<![\p{L}])(?:данн|информаци|переписк|сообщени|разговор|диалог)\p{L}*(?:\s+\p{L}+){0,3}?\s+никуда\s+не\s+(?:уход|переда|утека|попада)/u,
      /(?<![\p{L}])никуда\s+не\s+(?:уход|переда|утека|попада)\p{L}*(?:\s+\p{L}+){0,2}?\s+(?:данн|информаци|переписк)/u,
      /(?<![\p{L}])не\s+переда[её]м(?:\s+\p{L}+){0,2}?\s+(?:данн|информаци|переписк)/u,
      /(?<![\p{L}])не\s+передаются\s+третьим/u,
    ),
    allowFromAnswer: true,
  },
  {
    rule: 'правило 4',
    what: 'поиск единомышленников не называем знакомствами и дейтингом',
    pattern: anyOf(
      /(?<![\p{L}])(?:сайт|приложени|сервис|платформ|площадк|чат|бот)\p{L}*\s+(?:для\s+)?знакомств/u,
      // «Знакомства по ценностям» — про поиск единомышленников; «знакомство с договором»,
      // «деловые знакомства», «Познакомлю с юристом» — нет.
      /(?<![\p{L}])знакомств\p{L}*\s+(?:по\s+(?:ценност|интерес|совместимост)|с\s+(?:единомышленник|новыми\s+людьми|людьми|интересными\s+людьми))/u,
      /(?<![\p{L}])познаком\p{L}*\s+с\s+(?:единомышленник|новыми\s+людьми|людьми|интересными\s+людьми)/u,
      /(?<![\p{L}])(?:дейтинг|dating)/u,
      // «Найти пару» — только когда за ней конец фразы или «для / на / по / в / среди…»:
      // перечнем исключений («пару минут, часов…») не закрыть «пару надёжных юристов».
      /(?<![\p{L}])(?:найти|найдите|найдёте|найдете|ищете|ищешь|ищет|ищут|ищу|искать|поиск)(?:\s+себе)?\s+пар[уы](?![\p{L}])(?=\s*$|\s*[^\p{L}\p{N}\s]|\s+(?:для|на|по|в|во|среди|мечты|жизни|себе)(?![\p{L}]))/u,
      /(?<![\p{L}])втор(?:ая|ую|ой|ые|ых)\s+половинк/u,
      // «до свидания» — прощание, не свидание.
      /(?<![\p{L}])(?<!(?<![\p{L}])до\s+)свидани(?:е|я|й|и|ю|ем|ях)(?![\p{L}])/u,
    ),
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
    pattern: anyOf(
      /(?<![\p{L}])(?<!(?<![\p{L}])не\s+)(?:умр[её]те|умр[её]шь|погибн[её]те|погибн[её]шь)(?![\p{L}])/u,
      /(?<![\p{L}])(?<!(?<![\p{L}])не\s+)(?:можете|можешь|можно|может|могут|рискуете|рискуешь)\s+(?:умереть|погибнуть)(?![\p{L}])/u,
      /(?<![\p{L}])(?<!(?<![\p{L}])не\s+)(?:может|могут)\s+(?:вас|тебя)\s+убить(?![\p{L}])/u,
      /(?<![\p{L}])смертельно\s+опасн/u,
      /(?<![\p{L}])(?:убь[её]т|убьют)\s+(?:вас|тебя)(?![\p{L}])/u,
      /(?<![\p{L}])(?:вас|тебя)\s+(?:убь[её]т|убьют)(?![\p{L}])/u,
      /(?<![\p{L}])опасно\s+для\s+жизни/u,
    ),
    allowFromAnswer: true,
  },
  {
    // Пересказом не открывается: сценарист всегда может не называть слово (спека — «только в спокойной подаче»).
    rule: 'правило 12',
    what: 'инфаркт и инсульт упоминаем только в спокойной подаче',
    pattern: /(?<![\p{L}])(?:инфаркт|инсульт)/giu,
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
    // «кретинизм» (диагноз), «уродливый фасад», «урожай» — тоже.
    rule: 'правило 14',
    what: 'без брани и оскорблений',
    pattern: anyOf(
      /(?<![\p{L}])(?:на|по|о|а|об|от|при|за|до|вы|рас|раз|с|у|пере|под|ни)?ху[йеёяию]/u,
      /(?<![\p{L}])(?:за|на|у|вы|до|от|отъ|об|объ|при|про|по|пере|недо|разъ|подъ|изъ|съ|въ|долбо)?[её]б(?:[аулн]|ыв|ис|ош|ёт|ет|(?![\p{L}]))/u,
      /пизд/u,
      /(?<![\p{L}])(?:вы)?бля(?:ть|д\p{L}*)?(?![\p{L}])/u,
      /(?<![\p{L}])сук[аи](?![\p{L}])/u,
      /(?<![\p{L}])(?:мудак|мудил|дебил|идиот|придур|тупиц|пид[оа]р|дурак|говн|дерьм)/u,
      /(?<![\p{L}])кретин(?:а|у|ом|е|ы|ов|ам|ами|ах|ка|ки)?(?![\p{L}])/u,
      /(?<![\p{L}])урод(?:а|у|ом|е|ы|ов|ам|ами|ах|ина|ец|цы)?(?![\p{L}])/u,
      /(?<![\p{L}])лох(?:и|ов|ам|а|у|ом)?(?![\p{L}])/u,
    ),
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
    pattern: howTo(EXEMPT_ACTS),
    allowFromAnswer: true,
    unless: (at) => LAWFUL.test(at.sentence),
  },
  {
    rule: 'правило 15',
    what: 'не подталкиваем к нарушению закона (можно «что будет, если…»)',
    pattern: howTo(UNLAWFUL_ACTS),
    allowFromAnswer: true,
    unless: (at) => LAWFUL_WORDS.test(at.sentence),
  },
  {
    // «Не платите налог с аренды?» и «не платите налог дважды» — не подталкивание.
    rule: 'правило 15',
    what: 'не подталкиваем к нарушению закона (можно «что будет, если…»)',
    pattern: ordered(EXEMPT_ORDERS),
    allowFromAnswer: true,
    unless: (at) => LAWFUL.test(at.sentence) || QUESTION_TAIL.test(at.after),
  },
  {
    // «Скройте доход — кто узнает?» — риторический вопрос, а не вопрос зрителю.
    rule: 'правило 15',
    what: 'не подталкиваем к нарушению закона (можно «что будет, если…»)',
    pattern: ordered(UNLAWFUL_ORDERS),
    allowFromAnswer: true,
    unless: (at) => LAWFUL_WORDS.test(at.sentence),
  },
];

/** Утверждение о чувствах зрителя (правило 9). Вопросом — можно; «Соседи устали» — не про зрителя. */
const FEELING = /(?<![\p{L}])(?:боитесь|переживаете|злитесь|мечтаете|чувствуете|сомневаетесь|волнуетесь|стесняетесь|ненавидите|боишься|переживаешь|злишься|мечтаешь|чувствуешь|сомневаешься|волнуешься|стесняешься|ненавидишь|(?:вам|тебе)\s+(?:страшно|стыдно|тревожно|обидно|надоело|одиноко))(?![\p{L}])|(?:^[^\p{L}]*|(?<![\p{L}])вы\s+)устали(?![\p{L}])/iu;
const BRAND_SPOKEN = /linkeon|линкеон/iu;
const isQuestion = (s: string): boolean => /\?[!?]*["'»”)\s]*$/.test(s.trim());
const LETTER = /\p{L}/u;
const norm = (s: string): string => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');

/** Предложение, в котором стоит находка, и его хвост после неё. */
function contextAt(text: string, from: number, to: number): HitContext {
  let start = from;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  const after = /^[^.!?\n]*[.!?]*/.exec(text.slice(to))[0];
  return { sentence: text.slice(start, to) + after, after };
}

/** Все вхождения правила: core — что совпало (по нему сверяется пересказ), finding — слова целиком. */
function hitsOf(r: TextRule, text: string): { core: string; finding: string }[] {
  const hits: { core: string; finding: string }[] = [];
  for (const m of text.matchAll(r.pattern)) {
    let from = m.index ?? 0;
    let to = from + m[0].length;
    if (r.unless && r.unless(contextAt(text, from, to))) continue;
    while (from > 0 && LETTER.test(text[from - 1])) from--;
    while (to < text.length && LETTER.test(text[to])) to++;
    hits.push({ core: m[0], finding: text.slice(from, to).replace(/\s+/g, ' ').trim() });
  }
  return hits;
}

interface PlacedText {
  place: string;
  text: string;
}

/** Откуда текст ролика может брать слова и числа: правило 1 и пересказ (allowFromAnswer). */
interface TextSource {
  angle: ShortAngle;
  answerText: string;
  sceneQuestion: string;
  assistantsCount: number;
}

/** Реплики сценки с местом — как их называют нарушения и подписи владельцу. */
function skitTexts(kind: SkitKind, skit: Skit | null | undefined): PlacedText[] {
  return (Array.isArray(skit?.lines) ? skit.lines : []).map((l, n) => ({
    place: `${SKIT_LABELS[kind]}, реплика ${n + 1}`,
    text: String(l?.text ?? ''),
  }));
}

/**
 * Правила текста 1–15, которые проверяются по словам, у каждой находки — место.
 * `spoken` — то, что звучит или стоит в кадре: в нём не бывает и названия
 * сервиса (его говорит только финал); `captions` — подписи площадок.
 */
function textViolations(spoken: PlacedText[], captions: PlacedText[], src: TextSource): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    if (!out.includes(m)) out.push(m);
  };
  for (const t of spoken) if (BRAND_SPOKEN.test(t.text)) add(`название сервиса — только в финале: убери его (${t.place})`);
  const texts = [...spoken, ...captions].map((t) => ({ place: t.place, text: String(t.text ?? '') }));
  const provocative = PROVOCATIVE_ANGLES.includes(src.angle);
  const sourceText = `${src.answerText ?? ''}\n${src.sceneQuestion ?? ''}`;
  for (const r of TEXT_RULES) {
    if (r.provocativeOnly && !provocative) continue;
    // Пересказ — основы, на которые то же правило срабатывает в ответе или вопросе.
    const retold = r.allowFromAnswer ? new Set(hitsOf(r, sourceText).map((h) => norm(h.core))) : null;
    for (const t of texts) {
      for (const hit of hitsOf(r, t.text)) {
        if (retold?.has(norm(hit.core))) continue;
        add(`${r.rule}: ${r.what} — «${hit.finding}» (${t.place})`);
      }
    }
  }
  const allowed = new Set([
    ...numbersIn(src.answerText ?? ''),
    ...numbersIn(src.sceneQuestion ?? ''),
    String(src.assistantsCount),
    String(WELCOME_GIFT_TOKENS),
  ]);
  for (const t of texts) {
    for (const n of numberHits(t.text)) {
      if (!allowed.has(n.value)) add(`правило 1: числа «${n.raw}» нет в ответе ассистента (${t.place})`);
    }
  }
  return out;
}

/**
 * Правила текста у сценки 1 — у режиссёра, до записи сцены: ответа ещё нет,
 * числа берутся только из вопроса. Сценарист конфликт без замечаний не трогает,
 * и нарушение, пропущенное здесь, ролик уже не исправил бы.
 */
export function checkSkitTextRules(skit: Skit | null, kind: SkitKind, src: Omit<TextSource, 'answerText'> & { answerText?: string }): string[] {
  return textViolations(skitTexts(kind, skit), [], { ...src, answerText: src.answerText ?? '' });
}

export function checkScriptRules(i: RulesInput): string[] {
  const out: string[] = [];
  const add = (m: string) => {
    if (!out.includes(m)) out.push(m);
  };
  const s = i.script;
  const known = new Set(i.paragraphs.map((p) => p.n));
  const scene = (name: string) => s.lines.filter((l) => l.scene === name);
  // Ролик со сценками: зацепка — немая надпись поверх конфликта, ответ пересказывают 1–2 реплики.
  const skitFormat = i.format === 'skit';

  // Раскадровка: зацепка → вопрос → ответ → финал (у сценок зацепка не звучит).
  const hook = String(s.hook ?? '').trim();
  // Тире и прочие знаки — не слова.
  const hookWords = hook.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  const maxHookWords = skitFormat ? MAX_SKIT_HOOK_WORDS : MAX_HOOK_WORDS;
  if (!hook) add('нет зацепки');
  else if (hookWords > maxHookWords) add(`зацепка длиннее ${maxHookWords} слов`);
  const ORDER = skitFormat ? ['question', 'answer', 'final'] : ['hook', 'question', 'answer', 'final'];
  let at = 0;
  for (const l of s.lines) {
    const k = ORDER.indexOf(l.scene);
    if (k < at) {
      add(`реплика ${l.id}: сцены идут не по порядку ${skitFormat ? 'вопрос → ответ → финал' : 'зацепка → вопрос → ответ → финал'}`);
      break;
    }
    at = k;
  }
  const hooks = scene('hook');
  if (skitFormat) {
    if (hooks.length) add('у ролика со сценками зацепка — надпись поверх сценки: реплики hook быть не должно');
  } else if (hooks.length !== 1) add('зацепка — ровно одна реплика');
  else if (hooks[0].text.trim() !== hook) add('текст реплики зацепки должен совпадать с зацепкой');
  if (!scene('question').length) add('нет реплики вопроса');
  const answers = scene('answer');
  const [minAnswers, maxAnswers] = skitFormat ? [MIN_SKIT_ANSWER_LINES, MAX_SKIT_ANSWER_LINES] : [MIN_ANSWER_LINES, MAX_ANSWER_LINES];
  if (answers.length < minAnswers || answers.length > maxAnswers) {
    add(`реплик ответа ${answers.length} — нужно ${minAnswers}–${maxAnswers}`);
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
  if (skitFormat) {
    for (const kind of SKIT_KINDS) for (const m of checkSkitRules(i.skits?.[kind], kind, i.paragraphs)) add(m);
  }

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

  // Длина по оценке. У сценок озвучка — только голос ассистента и финал: клипы идут своим звуком.
  const est = estimateSpeechSec(s);
  const [minSec, maxSec] = skitFormat ? [MIN_SKIT_ESTIMATED_SEC, MAX_SKIT_ESTIMATED_SEC] : [MIN_ESTIMATED_SEC, MAX_ESTIMATED_SEC];
  if (est < minSec) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${minSec}–${maxSec} с: добавь реплику или перескажи абзац подробнее`);
  }
  if (est > maxSec) {
    add(`сценарий звучит примерно ${Math.round(est)} с, нужно ${minSec}–${maxSec} с: сократи реплики`);
  }

  // Тексты сценариста, у каждого — место. Финал пишет код, его здесь нет. Реплики
  // сценок и немая зацепка сценок — тоже тексты ролика: зацепка стоит в кадре.
  const spoken: PlacedText[] = [
    ...(skitFormat ? [{ place: 'зацепка', text: hook }] : []),
    ...s.lines.filter((l) => l.scene !== 'final').map((l) => ({ place: `реплика ${l.id}`, text: l.text })),
    ...(skitFormat ? SKIT_KINDS.flatMap((kind) => skitTexts(kind, i.skits?.[kind])) : []),
  ];
  const c = i.captions;
  const captions: PlacedText[] = [
    { place: 'подпись telegram', text: c.telegram },
    { place: 'подпись vk', text: c.vk },
    { place: 'youtube.title', text: c.youtube.title },
    { place: 'youtube.description', text: c.youtube.description },
    // Через запятую: соседние теги не складываются в одну фразу.
    { place: 'youtube.tags', text: (c.youtube.tags ?? []).join(', ') },
  ];
  const src = { angle: i.angle, answerText: i.answerText ?? '', sceneQuestion: i.sceneQuestion ?? '', assistantsCount: i.assistantsCount };
  for (const m of textViolations(spoken, captions, src)) add(m);
  return out;
}
