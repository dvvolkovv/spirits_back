// Universal co-pilot types (Task 3). The trip-specific TripPlan schema
// (legs/fuel/roadMarks/deadline/window/geoTriggers-from-coords) has been
// retired — the co-pilot now reasons over the user's real tasks + calendar
// events (see CalendarService). These types are the surviving contract the
// launcher/app already render against.

export interface TripReminder {
  id: string;
  when: string;
  text: string;
  critical: boolean;
  done?: boolean;
}

export interface GeoTrigger {
  id: string;
  lat: number;
  lon: number;
  radiusM: number;
  title: string;
  body: string;
}

export interface TimeTrigger {
  id: string;
  at: string;
  title: string;
  body: string;
}

export interface CoPilotState {
  mode?: 'idle' | 'pre_trip' | 'active' | 'done';
  headline: string;
  sub?: string; // «ближайшее действие»
  contextLines: { icon: string; text: string; tone?: 'ok' | 'warn' | 'crit' }[];
  /**
   * Структурированные события календаря (в дополнение к contextLines, которые несут лишь
   * форматированный текст) — чтобы лаунчер мог РАНЖИРОВАТЬ и показывать «ближайшую встречу»
   * по времени [784fd182]. Отсортированы по времени начала. Старые потребители поле игнорируют.
   */
  events?: { at: string; end?: string; title: string; conflict: boolean; uid?: string; source?: string }[];
  /**
   * Pending-предложения агента [a5131311]: типизированные артефакты (пока `calendar_event`),
   * которые лаунчер показывает карточкой с [Добавить]/[Отклонить]. Absent/[] — нечего предлагать.
   */
  proposals?: { id: string; kind: string; payload: any }[];
  reminders: TripReminder[];
  geoTriggers: GeoTrigger[];
  timeTriggers: TimeTrigger[];
  version: number;
  serverTime: string;
}
