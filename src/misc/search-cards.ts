import { LanguageService } from '../common/services/language.service';

/**
 * Выдача поиска единомышленников: кого показать, карточки и проза к ним.
 *
 * Почему карточки собирает бэк, а прозу пишет отдельный вызов (12.10.2026).
 * Раньше одна модель за один вызов писала и прозу, и JSON-список. Найденные
 * профили ей подавались как #1…#10, людей в прозе она звала по этим номерам
 * («четвёртый», «восьмой»), а в список клала только подходящих — двух-трёх.
 * Пользователь видел три карточки и текст про «восьмой профиль». На проде по
 * запросу «коуч» так вышло в трёх прогонах из пяти.
 *
 * Теперь модель сначала только выбирает, кого показать (`ref` — номер из её
 * списка). Карточки бэк собирает сам: userId и процент совпадения берёт из
 * поиска, а не со слов модели. Прозу пишет второй вызов, и ему подаются ровно
 * показанные карточки в показанном порядке — номерам в прозе не с чем
 * расходиться.
 */

export interface FoundProfile {
  userId: number | null;
  name: string;
  totalScore: number;
  matches: Array<{ category: string; name: string; gloss: string; score: number }>;
}

export interface SearchCard {
  userId: number | null;
  name: string;
  values: string[];
  intents: string[];
  interests: string[];
  skills: string[];
  /** Ключ с опечаткой: именно его читают веб и мобилка. */
  corellation: number;
  matchReason: string;
}

export interface SelectedProfile {
  card: SearchCard;
  found: FoundProfile;
}

/**
 * Совпавшие узлы профиля для промпта: топ-5 с персональным gloss. Оценки
 * совпадения — только для выбора: в прозе модель пересказывала их
 * пользователю («cos=0.62»).
 */
function topHits(p: FoundProfile, indent: string, withScore: boolean): string {
  return p.matches.slice(0, 5)
    .map((h) => `${indent}• [${h.category}] "${h.name}"${withScore ? ` (cos=${h.score.toFixed(2)})` : ''}: ${h.gloss}`)
    .join('\n');
}

/** Промпт выбора: все найденные под номерами #1…#N, ответ — только JSON. */
export function buildSelectionPrompt(found: FoundProfile[], language: string): string {
  const block = found.map((p, i) => {
    const nameLabel = p.name ? ` (${p.name})` : '';
    return `#${i + 1}${nameLabel}, totalScore=${p.totalScore.toFixed(2)}\n${topHits(p, '    ', true)}`;
  }).join('\n\n');

  return `Ты — помощник по поиску единомышленников на платформе my.linkeon.io.

Пользователь задал запрос, и по семантическому (embedding-based) поиску найдены профили — для каждого показаны конкретные узлы профиля, которые совпали, с их персональным gloss-описанием (что ИМЕННО этот человек понимает под данной ценностью/интересом).

Найденные профили:
${block}

Твоя задача — выбрать, кого показать пользователю. Семантический поиск грубый: часть профилей попала сюда по случайным совпадениям слов — таких не показывай. Оставь тех, кто отвечает на запрос, судя по matched gloss, а не по общим словам. Если прямых совпадений нет — оставь близких по смыслу и в matchReason честно скажи, чем именно близок. Порядок — от самого подходящего.

Ответь ТОЛЬКО JSON-массивом, без пояснений и без markdown:
[{"ref":<номер профиля из списка выше>,"name":"<имя или короткое описание роли>","values":["val1"],"intents":[],"interests":[],"skills":[],"matchReason":"<1 предложение: почему подошёл, по matched gloss>"}]

Поля values/interests/intents/skills заполни ТЕМИ canonical-именами узлов, которые совпали. Пустой массив [] — только если с запросом не связан никто, даже косвенно.
В name и matchReason КАТЕГОРИЧЕСКИ НЕЛЬЗЯ упоминать телефонные номера, phone, userId, цифровые идентификаторы.
name и matchReason пиши на языке пользователя (см. ниже). Имена полей JSON — служебные, их НЕ переводи.
${LanguageService.buildDirective(language)}`;
}

/** Выбор модели — JSON-массив, возможно в markdown-ограде. null — не разобрать. */
export function parseSearchSelection(answer: string): unknown[] | null {
  const cleaned = answer.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const trimmed = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Карточки в порядке выбора модели. Номер, которого нет в списке, и повторный
 * номер отбрасываются; userId и процент берутся из поиска.
 */
export function selectSearchProfiles(found: FoundProfile[], selection: unknown[]): SelectedProfile[] {
  const maxScore = Math.max(...found.map((p) => p.totalScore));
  const taken = new Set<number>();
  const selected: SelectedProfile[] = [];
  for (const item of selection) {
    if (!item || typeof item !== 'object') continue;
    const pick = item as Record<string, unknown>;
    const ref = Number(String(pick.ref ?? '').replace(/^#/, ''));
    if (!Number.isInteger(ref) || ref < 1 || ref > found.length || taken.has(ref)) continue;
    taken.add(ref);
    const p = found[ref - 1];
    selected.push({
      found: p,
      card: {
        userId: p.userId,
        name: trimmed(pick.name) || p.name,
        values: strings(pick.values),
        intents: strings(pick.intents),
        interests: strings(pick.interests),
        skills: strings(pick.skills),
        corellation: maxScore > 0 ? Math.round((p.totalScore / maxScore) * 100) / 100 : 0,
        matchReason: trimmed(pick.matchReason),
      },
    });
  }
  return selected;
}

/** Промпт прозы: только показанные карточки, пронумерованные как на экране. */
export function buildProsePrompt(selected: SelectedProfile[], language: string): string {
  const block = selected.map(({ card, found }, i) => {
    const reason = card.matchReason ? ` — ${card.matchReason}` : '';
    return `${i + 1}. «${card.name}»${reason}\n${topHits(found, '   ', false)}`;
  }).join('\n\n');

  return `Ты — помощник по поиску единомышленников на платформе my.linkeon.io.

По запросу пользователя подобраны люди. Пользователь видит их карточками — ровно этих, в этом порядке (всего ${selected.length}):

${block}

Напиши 2-3 предложения — краткий и конкретный комментарий, ПОЧЕМУ эти люди подошли. Ссылайся на matched gloss, а не на общие слова.
Называй людей так, как они подписаны на карточках, или по месту в этом списке («первый», «второй»). Других людей и других номеров нет: пользователь видит только эти карточки.
О самом пользователе ты знаешь только его запрос — не приписывай ему ценностей и интересов.
КАТЕГОРИЧЕСКИ НЕЛЬЗЯ упоминать телефонные номера, phone, userId, цифровые идентификаторы — ни в скобках, ни в кавычках, ни в виде списка. Никогда.
Пиши только комментарий: без JSON и без перечня карточек — их пользователь уже видит.
${LanguageService.buildDirective(language)}`;
}
