import { CENTER_IDS, CHANNELS, GATE_CENTER, MOTORS, type CenterId, type Channel } from './bodygraph';

/** Порядок — для показа и для проверки текстов. */
export const HD_TYPES = ['generator', 'manifestingGenerator', 'manifestor', 'projector', 'reflector'] as const;
export type HdType = (typeof HD_TYPES)[number];

export const HD_STRATEGIES = ['respond', 'respondThenInform', 'inform', 'waitForInvitation', 'waitLunarCycle'] as const;
export type HdStrategy = (typeof HD_STRATEGIES)[number];

/** Стратегия однозначно следует из типа. */
export const STRATEGY_OF: Readonly<Record<HdType, HdStrategy>> = {
  generator: 'respond',
  manifestingGenerator: 'respondThenInform',
  manifestor: 'inform',
  projector: 'waitForInvitation',
  reflector: 'waitLunarCycle',
};

/**
 * Авторитеты по старшинству; сама иерархия действует цепочкой условий в
 * hdAuthority. Лунный — у Рефлектора. Эго-манифестированный и
 * эго-проецированный — один авторитет «ego»: вид следует из типа (у
 * Манифестора — манифестированный, у Проектора — проецированный).
 */
export const HD_AUTHORITIES = ['emotional', 'sacral', 'splenic', 'ego', 'selfProjected', 'mental', 'lunar'] as const;
export type HdAuthority = (typeof HD_AUTHORITIES)[number];

/** Индекс — число связных групп определённых центров. */
export const HD_DEFINITIONS = ['none', 'single', 'split', 'triple', 'quadruple'] as const;
export type HdDefinition = (typeof HD_DEFINITIONS)[number];

/** Каналы, у которых активны оба ворот. */
export function definedChannels(gates: ReadonlySet<number>): Channel[] {
  return CHANNELS.filter(([a, b]) => gates.has(a) && gates.has(b));
}

/** Определённые центры — концы определённых каналов, в порядке CENTER_IDS. */
export function definedCenters(channels: readonly Channel[]): CenterId[] {
  const set = new Set<CenterId>();
  for (const [a, b] of channels) {
    set.add(GATE_CENTER[a]);
    set.add(GATE_CENTER[b]);
  }
  return CENTER_IDS.filter((c) => set.has(c));
}

/** Центры, достижимые из `from` по определённым каналам (включая сам `from`). */
function reachable(from: CenterId, channels: readonly Channel[]): Set<CenterId> {
  const seen = new Set<CenterId>([from]);
  const queue: CenterId[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [a, b] of channels) {
      const [ca, cb] = [GATE_CENTER[a], GATE_CENTER[b]];
      const next = ca === current ? cb : cb === current ? ca : null;
      if (next && !seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/**
 * Тип. Мотор связан с горлом — напрямую или цепочкой определённых каналов
 * (gethumandesign.com: «directly or through a chain of channels»).
 */
export function hdType(channels: readonly Channel[]): HdType {
  const centers = definedCenters(channels);
  if (centers.length === 0) return 'reflector';
  const fromThroat = reachable('throat', channels);
  const motorToThroat = MOTORS.some((m) => fromThroat.has(m));
  if (centers.includes('sacral')) return motorToThroat ? 'manifestingGenerator' : 'generator';
  return motorToThroat ? 'manifestor' : 'projector';
}

/**
 * Внутренний авторитет — первый сверху в иерархии. До G дело доходит, только
 * когда G определён каналом к горлу: остальные его каналы ведут в сакрал,
 * селезёнку и сердце — они выше по иерархии.
 */
export function hdAuthority(channels: readonly Channel[]): HdAuthority {
  const centers = new Set(definedCenters(channels));
  if (centers.size === 0) return 'lunar';
  if (centers.has('solarPlexus')) return 'emotional';
  if (centers.has('sacral')) return 'sacral';
  if (centers.has('spleen')) return 'splenic';
  if (centers.has('heart')) return 'ego';
  if (centers.has('g')) return 'selfProjected';
  return 'mental';
}

/**
 * Определённость — число связных групп определённых центров. Больше четырёх
 * не бывает: канал соединяет два разных центра, значит, в группе не меньше
 * двух центров, а центров девять.
 */
export function hdDefinition(channels: readonly Channel[]): HdDefinition {
  const remaining = new Set(definedCenters(channels));
  let groups = 0;
  for (const center of CENTER_IDS) {
    if (!remaining.has(center)) continue;
    groups += 1;
    for (const c of reachable(center, channels)) remaining.delete(c);
  }
  return HD_DEFINITIONS[groups];
}
