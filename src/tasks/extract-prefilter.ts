// Локальный фильтр: отсеивает бытовые/короткие обороты до LLM-вызова
// в extractFromTurn. Цель — срезать ~70% оборотов (привет/спасибо/ок),
// для которых LLM всё равно вернёт {"decision":"none"}, без лишнего токена.

// `\b` не работает с кириллицей в JS (word boundary только для \w = ASCII),
// поэтому используем простой substring match. Слова curated — false-positive
// риск низкий, и допустимо: prefilter лишь срезает дешёвые точно-skip case'ы,
// в спорных случаях пускаем дальше в LLM.
const PROJECT_KEYWORDS = /(задач|план|сделат|запуст|настро|помоги|нужно|надо|кампани|пост|ролик|видео|реклам|подгот|клиент|проект|дедлайн|deadline|сроки|встреч|созвон|отчёт|отчет|отправ|написат|обсуди|договор|оплат|подпис|релиз|запуск|запушу|запушить)/i;
const PLEASANTRY = /^\s*(привет|здравств|спасибо|спасиб|пожалуйста|ок|окей|ага|да|нет|good|hi|hello|thanks|спс|ясно|понятно|круто|супер|👍|❤️)[!.\s]*$/i;
const SHORT_THRESHOLD = 25;

export function shouldSkipTaskExtraction(message: string): boolean {
  const trimmed = (message || '').trim();
  if (!trimmed) return true;
  if (PLEASANTRY.test(trimmed)) return true;
  if (trimmed.length < SHORT_THRESHOLD && !PROJECT_KEYWORDS.test(trimmed)) return true;
  return false;
}
