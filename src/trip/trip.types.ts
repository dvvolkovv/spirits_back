export type TripStatus = 'upcoming' | 'active' | 'done';

export interface TripLeg {
  from: string;
  to: string;
  distanceKm: number;
  departPlanned?: string;
  arrivePlanned?: string;
  overnight?: { city: string; note?: string };
}

export interface FuelPoint {
  nearLocation: string;
  lat?: number;
  lon?: number;
  note: string;
  kmWithoutFuelAfter?: number;
}

export interface RoadMark {
  type: 'm12_enter' | 'm12_exit';
  nearLocation: string;
  lat?: number;
  lon?: number;
}

export interface TripReminder {
  id: string;
  when: string;
  text: string;
  critical: boolean;
  done?: boolean;
}

export interface TripPlan {
  id: string;
  title: string;
  status: TripStatus;
  window: { activateFrom: string; departPlanned: string; endEstimated: string };
  deadline: { title: string; datetime: string; flexible: boolean; note?: string };
  legs: TripLeg[];
  fuelPoints: FuelPoint[];
  roadMarks: RoadMark[];
  reminders: TripReminder[];
  prefs?: Record<string, string>;
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function isValidIsoDatetime(v: any): boolean {
  if (typeof v !== 'string' || !ISO_DATETIME_RE.test(v)) return false;
  return !isNaN(new Date(v).getTime());
}

export function validateTripPlan(p: any): string[] {
  const errors: string[] = [];

  if (!p || typeof p !== 'object') {
    errors.push('plan: must be an object');
    return errors;
  }

  if (!p.id || typeof p.id !== 'string') errors.push('id: is required');
  if (!p.title || typeof p.title !== 'string') errors.push('title: is required');
  if (!['upcoming', 'active', 'done'].includes(p.status)) {
    errors.push('status: must be one of upcoming|active|done');
  }

  if (!p.window || typeof p.window !== 'object') {
    errors.push('window: is required');
  } else {
    if (!isValidIsoDatetime(p.window.activateFrom)) errors.push('window.activateFrom: must be an ISO datetime');
    if (!isValidIsoDatetime(p.window.departPlanned)) errors.push('window.departPlanned: must be an ISO datetime');
    if (!isValidIsoDatetime(p.window.endEstimated)) errors.push('window.endEstimated: must be an ISO datetime');
  }

  if (!p.deadline || typeof p.deadline !== 'object') {
    errors.push('deadline: is required');
  } else {
    if (!p.deadline.title || typeof p.deadline.title !== 'string') errors.push('deadline.title: is required');
    if (!isValidIsoDatetime(p.deadline.datetime)) errors.push('deadline.datetime: must be an ISO datetime');
    if (typeof p.deadline.flexible !== 'boolean') errors.push('deadline.flexible: must be a boolean');
  }

  if (!Array.isArray(p.legs) || p.legs.length === 0) {
    errors.push('legs: must be a non-empty array');
  } else {
    p.legs.forEach((leg: any, i: number) => {
      if (!leg || typeof leg !== 'object') {
        errors.push(`legs[${i}]: must be an object`);
        return;
      }
      if (!leg.from || typeof leg.from !== 'string') errors.push(`legs[${i}].from: is required`);
      if (!leg.to || typeof leg.to !== 'string') errors.push(`legs[${i}].to: is required`);
      if (typeof leg.distanceKm !== 'number' || leg.distanceKm <= 0) {
        errors.push(`legs[${i}].distanceKm: must be a positive number`);
      }
    });
  }

  if (!Array.isArray(p.fuelPoints)) errors.push('fuelPoints: must be an array');
  if (!Array.isArray(p.roadMarks)) errors.push('roadMarks: must be an array');

  if (!Array.isArray(p.reminders)) {
    errors.push('reminders: must be an array');
  } else {
    p.reminders.forEach((r: any, i: number) => {
      if (!r || typeof r !== 'object') {
        errors.push(`reminders[${i}]: must be an object`);
        return;
      }
      if (!r.id || typeof r.id !== 'string') errors.push(`reminders[${i}].id: is required`);
      if (!isValidIsoDatetime(r.when)) errors.push(`reminders[${i}].when: must be an ISO datetime`);
      if (!r.text || typeof r.text !== 'string') errors.push(`reminders[${i}].text: is required`);
      if (typeof r.critical !== 'boolean') errors.push(`reminders[${i}].critical: must be a boolean`);
    });
  }

  return errors;
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
  mode: 'idle' | 'pre_trip' | 'active' | 'done';
  headline: string;
  sub?: string; // «ближайшее действие»
  contextLines: { icon: string; text: string; tone?: 'ok' | 'warn' | 'crit' }[];
  reminders: TripReminder[];
  geoTriggers: GeoTrigger[];
  timeTriggers: TimeTrigger[];
  deadlineBufferHours?: number;
  version: number;
  serverTime: string;
}
