import { isHealthAssistant } from './short-assistants';
import { PROVOCATIVE_ANGLES, ShortAngle, ShortRubric, ShortSource } from './shorts.types';

/**
 * Подача следующего ролика по ритму недели: в любых трёх подряд — один calm и
 * две провокационные, разные. recent — подачи последних запущенных роликов,
 * от свежего к старому.
 */
export function nextAngle(recent: ShortAngle[]): ShortAngle {
  if (recent.length >= 2 && !recent.slice(0, 2).includes('calm')) return 'calm';
  const lastProvocative = recent.find((a) => a !== 'calm');
  const i = lastProvocative ? PROVOCATIVE_ANGLES.indexOf(lastProvocative) : -1;
  return PROVOCATIVE_ANGLES[(i + 1) % PROVOCATIVE_ANGLES.length];
}

export interface IdeaLite {
  id: string;
  rubric: ShortRubric;
  assistantName: string | null;
  angle: ShortAngle;
  angleLocked: boolean;
  source: ShortSource;
  createdAt: Date;
}

/**
 * recent — ролики, дошедшие до слота, от свежего к старому; отклонённые,
 * упавшие и идеи вызывающий отфильтровывает сам (задача 15,
 * `ShortsTopicService`) — иначе ритм считался бы по роликам, которых зритель
 * не увидит.
 */
export interface RecentLite {
  rubric: ShortRubric;
  angle: ShortAngle;
}

export interface NextPlan {
  ideaId: string;
  angle: ShortAngle;
}

const health = (i: IdeaLite): boolean => Boolean(i.assistantName && isHealthAssistant(i.assistantName));

/**
 * Какую идею запускать и с какой подачей.
 *
 * 1. Рубрика не повторяет рубрику последнего ролика, если в очереди есть другая.
 * 2. Заказ владельца — раньше каталога, дальше — по времени заказа.
 * 3. Провокационный слот не отдаётся теме здоровья, пока в очереди есть
 *    другая — даже той же рубрики, что последний ролик: провокация важнее
 *    ротации рубрик (владелец, 25.10.2026); если другой нет, тема здоровья
 *    выходит спокойной (правило 12).
 * 4. Подача, заданная при заказе, не меняется.
 */
export function planNext(ideas: IdeaLite[], recent: RecentLite[]): NextPlan | null {
  if (!ideas.length) return null;
  const wanted = nextAngle(recent.map((r) => r.angle));
  const provocative = wanted !== 'calm';
  const lastRubric = recent[0]?.rubric;
  const ordered = [...ideas].sort(
    (a, b) =>
      Number(a.source !== 'manual') - Number(b.source !== 'manual') ||
      a.createdAt.getTime() - b.createdAt.getTime() ||
      a.id.localeCompare(b.id),
  );
  const other = ordered.filter((i) => i.rubric !== lastRubric);
  const pool = other.length ? other : ordered;
  let pick = pool[0];
  if (provocative && !pick.angleLocked && health(pick)) {
    pick = pool.find((i) => i.angleLocked || !health(i)) ?? ordered.find((i) => i.angleLocked || !health(i)) ?? pick;
  }
  const angle = pick.angleLocked ? pick.angle : provocative && health(pick) ? 'calm' : wanted;
  return { ideaId: pick.id, angle };
}

export interface CatalogAssistant {
  id: number;
  name: string;
  description: string;
}

/**
 * Ассистенты недели: сначала те, о ком роликов не было, затем давно
 * показанные. У кого уже есть идея в очереди — пропускается.
 */
export function pickAssistants(
  all: CatalogAssistant[],
  lastShown: Map<number, Date>,
  open: Set<number>,
  count: number,
): CatalogAssistant[] {
  return all
    .filter((a) => !open.has(a.id))
    .sort((a, b) => (lastShown.get(a.id)?.getTime() ?? 0) - (lastShown.get(b.id)?.getTime() ?? 0) || a.id - b.id)
    .slice(0, count);
}
