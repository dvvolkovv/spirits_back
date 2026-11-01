import { clip } from './short-captions';
import { ShortRecovery, ShortStatus, ShortVideo, retryTarget } from './shorts.types';

/**
 * Доктор упавших роликов — решение без базы (спека самовосстановления,
 * «Доктор»). По этапу падения и коду сбоя — самопочинка: «позже» (тот же этап
 * через 30 мин, во второй раз через 2 ч), «новая сцена» (с режиссёра со
 * строкой «Сам: …» в замечаниях), «без сценок» (сценарист в формате chat) или
 * «никак» — сообщение владельцу. Пределы — на круг: кнопка владельца начинает
 * новый (auto_recoveries = 0). Запись — ShortsDoctorService.
 */

export type HealAction = ShortRecovery['action'];

/** Самопочинок на круг — всего и по видам (спека, «Пределы на ролик»). */
export const MAX_AUTO_RECOVERIES = 3;
export const MAX_PER_ACTION: Record<HealAction, number> = { later: 2, new_scene: 1, no_skits: 1 };
/** «Позже»: первый повтор через 30 минут, второй — через 2 часа. */
export const LATER_DELAYS_MIN = [30, 120];

/** Сцена или съёмка не годится, сценарист с ней не справился — новая сцена. */
const NEW_SCENE: Partial<Record<ShortStatus, readonly string[]>> = {
  directing: ['rules'],
  writing: ['rules', 'recapture', 'no_scene', 'no_conflict', 'too_long', 'too_short', 'line_too_short', 'script_invalid'],
  capturing: ['wrong_assistant', 'question_hidden', 'answer_rejected', 'no_paragraphs'],
  animating: ['keyframe_blocked', 'script_invalid'],
  rendering: ['frame_size'],
};

/** Сценки не снять: у сценариста кончились круги отзыва о сценке, у оживления — секунды, модель, ключ или запрос. */
const NO_SKITS: Partial<Record<ShortStatus, readonly string[]>> = {
  writing: ['speech_mismatch', 'omni_rejected'],
  animating: ['omni_budget', 'model_gone', 'google_auth', 'omni_bad_request', 'speech_mismatch', 'omni_rejected'],
};

type Rule = HealAction | 'later_then_no_skits' | 'never';

function ruleFor(from: ShortStatus | null, code: string | null): Rule {
  // Публикация — никогда: риск двойного поста, у неё свой разбор. no_input — настройка или данные, нужен человек.
  if (!from || from === 'publishing' || code === 'no_input') return 'never';
  if (from === 'directing' && code === 'no_assistant') return 'never';
  if (code && NEW_SCENE[from]?.includes(code)) return 'new_scene';
  if (code && NO_SKITS[from]?.includes(code)) return 'no_skits';
  // Сбои Omni, Google и распознавания — повтор, а исчерпан — без сценок. Незнакомый код — тоже «позже».
  if (from === 'animating') return 'later_then_no_skits';
  return retryTarget({ status: 'failed', failedFrom: from, approvedAt: null }) ? 'later' : 'never';
}

/** Текущий круг — последние autoRecoveries записей истории. */
export function currentCircle(v: Pick<ShortVideo, 'recoveries' | 'autoRecoveries'>): ShortRecovery[] {
  return v.autoRecoveries > 0 ? v.recoveries.slice(-v.autoRecoveries) : [];
}

export type Prescription = { action: HealAction; delayMin?: number } | { action: 'never' };
type Heal = Exclude<Prescription, { action: 'never' }>;

/** Что делать с упавшим роликом. «Никак» — и когда пределы круга кончились. */
export function prescribe(
  v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'format' | 'capture' | 'recoveries' | 'autoRecoveries'>,
): Prescription {
  const circle = currentCircle(v);
  if (circle.length >= MAX_AUTO_RECOVERIES) return { action: 'never' };
  const used = (a: HealAction): number => circle.filter((r) => r.action === a).length;
  const allowed = (a: HealAction): boolean => used(a) < MAX_PER_ACTION[a];
  // Без сценок — только ролику со сценками и со съёмкой: сценарист пишет текст по съёмке.
  const noSkits = (): Prescription => (allowed('no_skits') && v.format === 'skit' && v.capture ? { action: 'no_skits' } : { action: 'never' });
  const later = (): Prescription | null => (allowed('later') ? { action: 'later', delayMin: LATER_DELAYS_MIN[used('later')] } : null);
  switch (ruleFor(v.failedFrom, v.failedCode)) {
    case 'later':
      return later() ?? { action: 'never' };
    case 'later_then_no_skits':
      return later() ?? noSkits();
    case 'new_scene':
      return allowed('new_scene') ? { action: 'new_scene' } : { action: 'never' };
    case 'no_skits':
      return noSkits();
    default:
      return { action: 'never' };
  }
}

const ACTION_WORDS: Record<HealAction, (r: ShortRecovery) => string> = {
  later: (r) => `повтор через ${r.delayMin && r.delayMin >= 60 ? `${r.delayMin / 60} ч` : `${r.delayMin ?? LATER_DELAYS_MIN[0]} мин`}`,
  new_scene: () => 'новая сцена',
  no_skits: () => 'без сценок',
};

/** Самопочинки словами: «повтор через 30 мин (google_quota), новая сцена (answer_rejected)». */
export function recoveryWords(entries: ShortRecovery[]): string {
  return entries.map((r) => `${ACTION_WORDS[r.action]?.(r) ?? r.action} (${r.code ?? 'без кода'})`).join(', ');
}

/** Ошибка одной строкой: замечания построчные (appendOwnerNote), а ошибки студии бывают многострочными. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Запись истории: этап и код сбоя, действие, пауза «позже», причина — last_error одной строкой до 300 знаков. */
export function recoveryEntry(v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'lastError'>, p: Heal, now: Date): ShortRecovery {
  return {
    at: now.toISOString(),
    from: v.failedFrom as ShortStatus,
    code: v.failedCode,
    action: p.action,
    ...(p.action === 'later' ? { delayMin: p.delayMin } : {}),
    reason: clip(oneLine(v.lastError ?? ''), 300),
  };
}

/** Строка в замечания перед новой сценой: режиссёр и сценарист увидят, что прошлая не удалась. */
export function newSceneNote(v: Pick<ShortVideo, 'lastError' | 'failedCode'>): string {
  return `Сам: прошлая сцена не удалась — ${clip(oneLine(v.lastError || v.failedCode || 'причина не записана'), 300)}`;
}
