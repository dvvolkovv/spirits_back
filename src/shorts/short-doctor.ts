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

/** «Позже»: первый повтор круга через 30 минут, второй — через 2 часа (паузы считаются на весь круг, а не на этап). */
export const LATER_DELAYS_MIN = [30, 120];
/** Самопочинок на круг — всего и по видам (спека, «Пределы на ролик»); «позже» — сколько пауз. */
export const MAX_AUTO_RECOVERIES = 3;
export const MAX_PER_ACTION: Record<HealAction, number> = { later: LATER_DELAYS_MIN.length, new_scene: 1, no_skits: 1 };
/** Начало строки доктора в замечаниях: по нему сценарист отличает её от замечаний владельца (shorts-writer.service.ts). */
export const DOCTOR_NOTE_PREFIX = 'Сам:';

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

/** Сбои сети, Google, распознавания, стенда — «позже» (у оживления исчерпано — без сценок). Новый код студии — сюда или в таблицы выше. */
const LATER: readonly string[] = [
  'relay', 'lease', 'login', 'blocked', 'idle_timeout', 'answer_timeout', 'empty_frame', 'unknown',
  'omni_failed', 'omni_timeout', 'google_quota', 'keyframe', 'clip_invalid', 'stt', 'omni_unreadable', 'tts', 'video_invalid',
];

type Rule = HealAction | 'later_then_no_skits' | 'never';

function ruleFor(from: ShortStatus | null, code: string | null): Rule {
  // Публикация — никогда: риск двойного поста, у неё свой разбор. no_input — настройка или данные, нужен человек.
  if (!from || from === 'publishing' || code === 'no_input') return 'never';
  // Этап, с которого «Повторить» не продолжит (RESUME_FROM), — к владельцу при любом коде.
  if (!retryTarget({ status: 'failed', failedFrom: from, approvedAt: null })) return 'never';
  if (from === 'directing' && code === 'no_assistant') return 'never';
  if (code && NEW_SCENE[from]?.includes(code)) return 'new_scene';
  if (code && NO_SKITS[from]?.includes(code)) return 'no_skits';
  if (code && LATER.includes(code)) return from === 'animating' ? 'later_then_no_skits' : 'later';
  // Сбои Omni, Google и распознавания — повтор, а исчерпан — без сценок. Незнакомый код — тоже «позже».
  return from === 'animating' ? 'later_then_no_skits' : 'later';
}

/** Текущий круг — последние autoRecoveries записей истории; не записи (ручной SQL, мусор) отбрасываются. */
export function currentCircle(v: Pick<ShortVideo, 'recoveries' | 'autoRecoveries'>): ShortRecovery[] {
  const all = (Array.isArray(v.recoveries) ? v.recoveries : []).filter((r): r is ShortRecovery => !!r && typeof r === 'object');
  return v.autoRecoveries > 0 ? all.slice(-v.autoRecoveries) : [];
}

export type Prescription = { action: 'later'; delayMin: number } | { action: 'new_scene' } | { action: 'no_skits' } | { action: 'never' };
type Heal = Exclude<Prescription, { action: 'never' }>;

/** Что делать с упавшим роликом. «Никак» — и когда пределы круга кончились. */
export function prescribe(
  v: Pick<ShortVideo, 'failedFrom' | 'failedCode' | 'format' | 'scene' | 'capture' | 'recoveries' | 'autoRecoveries'>,
): Prescription {
  const circle = currentCircle(v);
  // Источник правды о круге — счётчик: история могла разойтись с ним (ручной SQL).
  const total = Math.max(circle.length, v.autoRecoveries);
  if (total >= MAX_AUTO_RECOVERIES) return { action: 'never' };
  const used = (a: HealAction): number => circle.filter((r) => r.action === a).length;
  const allowed = (a: HealAction): boolean => used(a) < MAX_PER_ACTION[a];
  // Без сценок — только ролику со сценками, сценой и съёмкой: сценарист пишет текст по ним.
  const noSkits = (): Prescription =>
    allowed('no_skits') && v.format === 'skit' && v.scene && v.capture ? { action: 'no_skits' } : { action: 'never' };
  const later = (): Prescription | null => (allowed('later') ? { action: 'later', delayMin: LATER_DELAYS_MIN[used('later')] } : null);
  const animating = v.failedFrom === 'animating';
  switch (ruleFor(v.failedFrom, v.failedCode)) {
    case 'later':
      return later() ?? { action: 'never' };
    case 'later_then_no_skits':
      // Последнее действие круга у оживления — без сценок: после неудачного «позже» ролика не было бы
      // (решение владельца: сценки не удались — собрать без сценок).
      return total === MAX_AUTO_RECOVERIES - 1 ? noSkits() : later() ?? noSkits();
    case 'new_scene':
      // Оживление на последнем действии круга — без сценок: новой сцене (пять этапов) круга уже не хватит.
      if (animating && total === MAX_AUTO_RECOVERIES - 1) return noSkits();
      if (allowed('new_scene')) return { action: 'new_scene' };
      // Новая сцена круга израсходована: у оживления — без сценок, у прочих этапов — к владельцу.
      return animating ? noSkits() : { action: 'never' };
    case 'no_skits':
      return noSkits();
    default:
      return { action: 'never' };
  }
}

/** Пауза словами: «через 30 мин», «через 2 ч», «через 1 ч 30 мин»; без паузы — «позже». */
function delayWords(min: number | undefined): string {
  if (!min || min <= 0) return 'позже';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `через ${[h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ')}`;
}

const ACTION_WORDS: Record<HealAction, (r: ShortRecovery) => string> = {
  later: (r) => `повтор ${delayWords(r.delayMin)}`,
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
  return `${DOCTOR_NOTE_PREFIX} прошлая сцена не удалась — ${clip(oneLine(v.lastError || v.failedCode || 'причина не записана'), 300)}`;
}
