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
  reminders: TripReminder[];
  geoTriggers: GeoTrigger[];
  timeTriggers: TimeTrigger[];
  version: number;
  serverTime: string;
}
