import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortParagraph, ShortScript } from './shorts.types';

/**
 * Проверка сценария до отправки владельцу (спека, «Правила текста»).
 *
 * Стоп-слова — страховка от явного: главное держат промпт сценариста и
 * одобрение владельца. Каждое правило — отдельная строка с номером, чтобы
 * сценарист при переписке знал, что именно исправлять.
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

/** Числа текста одной записью: «25 000» → «25000», «1,5» → «1.5». */
export function numbersIn(text: string): string[] {
  return (String(text ?? '').match(/\d+(?:\s\d{3})*(?:[.,]\d+)?/g) ?? []).map((n) => n.replace(/\s/g, '').replace(',', '.'));
}

interface TextRule {
  pattern: RegExp;
  message: (hit: string) => string;
}

// Где нужно, слово ограничено: (^|[^\p{L}]) перед ним и (?![\p{L}]) после —
// иначе «сбер» ловил бы «сбережения», а «трамп» — «трамплин».
const TEXT_RULES: TextRule[] = [
  {
    pattern: /\b(chat\s*gpt|gpt-?\d+|openai|anthropic|claude|gemini|gigachat|yandex\s*gpt|deepseek|perplexity|copilot|midjourney|kling|veo|sora|llama|mistral|qwen|grok)\b/i,
    message: (hit) => `правила 2 и 7: названы модель, провайдер или конкурент («${hit}»)`,
  },
  {
    pattern: /(^|[^\p{L}])(гигачат\S*|чат\s*гпт|алис[аеуы])(?![\p{L}])/iu,
    message: (hit) => `правила 2 и 7: названы модель, провайдер или конкурент («${hit}»)`,
  },
  {
    pattern: /(анонимн|никуда не (уход|переда)|не переда[её]м|не передаются третьим)/iu,
    message: () => 'правило 3: «анонимно» и «данные никуда не уходят» не пишем',
  },
  {
    pattern: /(знакомств|дейтинг|(^|[^\p{L}])свидани(е|ю|ем|ях)(?![\p{L}])|втор(ая|ую|ой) половинк|найти пару)/iu,
    message: () => 'правило 4: поиск единомышленников — не знакомства и не дейтинг',
  },
  {
    pattern: /(^|[^\p{L}])агент(а|у|ом|е|ы|ов|ам|ами|ах)?(?![\p{L}])/iu,
    message: () => 'правило 5: «ассистент», а не «агент»',
  },
  {
    pattern: /бесплатн/iu,
    message: () => 'правило 6: стартовый подарок — «25 000 токенов», а не «бесплатно»',
  },
  {
    pattern: /(^|[^\p{L}])(юл[яиюе]|юлей)(?![\p{L}])/iu,
    message: () => 'правило 7: Юлю не упоминаем',
  },
  {
    pattern: /((тысяч|миллион|сотн)\S*\s+(пользовател|клиент|людей уже|человек уже)|наш\S* пользовател|отзыв\S*\s+(наших\s+|довольных\s+)?(пользовател|клиент))/iu,
    message: () => 'правило 1: число пользователей и отзывы не называем',
  },
  {
    pattern: /(^|[^\p{L}])(путин\S*|зеленск\S*|байден\S*|трамп(а|у|ом|е)?|госдум\S*|депутат\S*|санкци\S*|мобилизац\S*|митинг\S*|оппозиц\S*|религи\S*|церк(овь|ви|овн\S*)|ислам\S*|мусульм\S*|христиан\S*|православ\S*|иуде\S*|будди\S*|бог(а|у|ом|е)?|войн(а|е|у|ы|ой|ам|ами|ах)?|выбор(ы|ов|ах|ам))(?![\p{L}])/iu,
    message: (hit) => `правило 11: без политики и религии («${hit}»)`,
  },
  {
    pattern: /(умр[её]те|умр[её]шь|смерт|погибн|инфаркт|инсульт|опасно для жизни)/iu,
    message: () => 'правило 12: без запугивания здоровьем',
  },
  {
    pattern: /(^|[^\p{L}])(сбер(банк\S*|а|е|у|ом)?|тинькофф?\S*|т-банк\S*|втб|альфа-банк\S*|газпром\S*|авито|циан(а|е|у|ом)?|озон(а|е|у|ом)?|ozon|wildberries|вайлдберриз|яндекс\S*|google|гугл\S*|apple|samsung|макдоналдс|starbucks|старбакс)(?![\p{L}])/iu,
    message: (hit) => `правило 13: названа компания или бренд («${hit}»)`,
  },
  {
    pattern: /(^|[^\p{L}])(бля|хуй|хуё|хуе|пизд|ебан|ёбан|ебат|сук[аи](?![\p{L}])|мудак|дебил|идиот|придур|лох(и|ов|ам)?(?![\p{L}])|тупиц)/iu,
    message: () => 'правило 14: без брани и оскорблений',
  },
  {
    pattern: /(кто|которые)\s+(ещё\s+|еще\s+|до сих пор\s+)?не\s+(пользу|знает о|слышал)/iu,
    message: () => 'правило 14: без насмешек над теми, кто не пользуется сервисом',
  },
  {
    pattern: /(не платить налог|уйти от налог|уклон\S* от (уплаты\s+)?налог|обойти закон|скрыть доход|зарплат\S* в конверте|сер(ую|ая) зарплат|выселить[^.!?]{0,30}без суда|обмануть (налогов|банк|суд|пристав))/iu,
    message: () => 'правило 15: не подталкиваем к нарушению закона',
  },
];

/** Утверждение о чувствах зрителя (правило 9). Вопросом — можно. */
const FEELING = /(^|[^\p{L}])(боитесь|устали|переживаете|злитесь|мечтаете|чувствуете|сомневаетесь|волнуетесь|стесняетесь|ненавидите|вам\s+(страшно|стыдно|тревожно|обидно|надоело|одиноко))(?![\p{L}])/iu;
const BRAND_SPOKEN = /linkeon|линкеон/iu;
const isQuestion = (s: string): boolean => /\?["'»”)\s]*$/.test(s.trim());

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
  if (!hook) add('нет зацепки');
  else if (hook.split(/\s+/).length > MAX_HOOK_WORDS) add(`зацепка длиннее ${MAX_HOOK_WORDS} слов`);
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
  if (hook && !isQuestion(hook) && FEELING.test(hook)) {
    add('правило 9: зацепка утверждает за зрителя, что он чувствует, — спроси или скажи факт из ответа');
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

  // Тексты сценариста. Финал пишет код, его здесь нет.
  const spoken = s.lines.filter((l) => l.scene !== 'final').map((l) => l.text);
  if (spoken.some((t) => BRAND_SPOKEN.test(t))) add('название сервиса звучит только в финале — убери его из реплик');
  const c = i.captions;
  const texts = [...spoken, c.telegram, c.vk, c.youtube.title, c.youtube.description, (c.youtube.tags ?? []).join(' ')];
  for (const t of texts) {
    for (const r of TEXT_RULES) {
      const m = String(t ?? '').match(r.pattern);
      if (m) add(r.message(m[0].replace(/^[^\p{L}\p{N}]+/u, '').trim()));
    }
  }
  const allowed = new Set([...numbersIn(i.answerText), String(i.assistantsCount), String(WELCOME_GIFT_TOKENS)]);
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      if (!allowed.has(n)) add(`правило 1: числа ${n} нет в ответе ассистента`);
    }
  }
  return out;
}
