import { Injectable, Logger, OnModuleInit, BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { TripPlan, CoPilotState, GeoTrigger, TimeTrigger, validateTripPlan } from './trip.types';
import { TRIP_2026_07 } from './seed-2026-07';

export const TRIP_STATE_VERSION = 1;
const OWNER_USER_ID = '79656445804';

export interface TripAction {
  kind: string;
  payload: any;
}

// Pure function: given a plan, "now", and the ordered list of actions applied
// so far, deterministically compute the co-pilot State. No I/O, no LLM — the
// launcher and tests both need this to be reproducible.
export function computeState(plan: TripPlan, now: Date, actions: TripAction[] = []): CoPilotState {
  const reminders = plan.reminders.map((r) => ({ ...r }));
  let deadlineDatetime = plan.deadline.datetime;

  for (const action of actions) {
    if (action.kind === 'deadline_update' && action.payload?.datetime) {
      deadlineDatetime = action.payload.datetime;
    } else if (action.kind === 'reminder_done' && action.payload?.id) {
      const rem = reminders.find((r) => r.id === action.payload.id);
      if (rem) rem.done = true;
    }
  }

  const activateFrom = new Date(plan.window.activateFrom);
  const departPlanned = new Date(plan.window.departPlanned);
  const endEstimated = new Date(plan.window.endEstimated);

  let mode: CoPilotState['mode'];
  if (now.getTime() < activateFrom.getTime()) mode = 'idle';
  else if (now.getTime() < departPlanned.getTime()) mode = 'pre_trip';
  else if (now.getTime() <= endEstimated.getTime()) mode = 'active';
  else mode = 'done';

  const deadlineDate = new Date(deadlineDatetime);
  const deadlineBufferHours =
    mode === 'idle' || mode === 'done'
      ? undefined
      : Math.max(0, (deadlineDate.getTime() - now.getTime()) / 3_600_000);

  const pendingReminders = reminders.filter((r) => !r.done);
  const contextLines: CoPilotState['contextLines'] = [];
  let headline = '';
  let sub: string | undefined;

  if (mode === 'idle') {
    headline = `Поездка «${plan.title}» ещё впереди`;
    sub = `Подготовка начнётся ${plan.window.activateFrom}`;
  } else if (mode === 'pre_trip') {
    const nextReminder = pendingReminders
      .slice()
      .sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime())[0];
    headline = nextReminder
      ? `Подготовка к поездке: ${nextReminder.text}`
      : `Подготовка к поездке «${plan.title}» — выезд ${plan.window.departPlanned}`;
    sub = `Выезд запланирован на ${plan.window.departPlanned}`;
    contextLines.push({ icon: '🧳', text: `Выезд: ${plan.window.departPlanned}`, tone: 'ok' });
    if (nextReminder) {
      contextLines.push({
        icon: nextReminder.critical ? '⚠️' : '📝',
        text: nextReminder.text,
        tone: nextReminder.critical ? 'crit' : 'ok',
      });
    }
  } else if (mode === 'active') {
    const upcomingLeg =
      plan.legs.find((l) => l.arrivePlanned && new Date(l.arrivePlanned).getTime() > now.getTime()) ||
      plan.legs[plan.legs.length - 1];

    if (upcomingLeg) {
      headline = `В пути: ${upcomingLeg.from} → ${upcomingLeg.to}`;
      if (upcomingLeg.overnight) {
        sub = `Ночёвка: ${upcomingLeg.overnight.city}`;
      }
    } else {
      headline = `В поездке «${plan.title}»`;
    }

    if (deadlineBufferHours !== undefined) {
      const tone: 'ok' | 'warn' | 'crit' =
        deadlineBufferHours < 6 ? 'crit' : deadlineBufferHours < 24 ? 'warn' : 'ok';
      contextLines.push({
        icon: '⏰',
        text: `${plan.deadline.title}: через ~${Math.round(deadlineBufferHours)} ч`,
        tone,
      });
    }
    if (upcomingLeg) {
      contextLines.push({
        icon: '🚗',
        text: `Дальше: ${upcomingLeg.from} → ${upcomingLeg.to} (${upcomingLeg.distanceKm} км)`,
        tone: 'ok',
      });
    }
    const nextReminder = pendingReminders
      .slice()
      .sort((a, b) => new Date(a.when).getTime() - new Date(b.when).getTime())[0];
    if (nextReminder) {
      contextLines.push({
        icon: nextReminder.critical ? '⚠️' : '📝',
        text: nextReminder.text,
        tone: nextReminder.critical ? 'crit' : 'ok',
      });
    }
  } else {
    headline = `Поездка «${plan.title}» завершена`;
  }

  const geoTriggers: GeoTrigger[] = [];
  for (const fp of plan.fuelPoints) {
    if (typeof fp.lat === 'number' && typeof fp.lon === 'number') {
      geoTriggers.push({
        id: `fuel-${fp.nearLocation}`,
        lat: fp.lat,
        lon: fp.lon,
        radiusM: 2000,
        title: 'Заправка',
        body: fp.note,
      });
    }
  }
  for (const rm of plan.roadMarks) {
    if (typeof rm.lat === 'number' && typeof rm.lon === 'number') {
      geoTriggers.push({
        id: `road-${rm.type}-${rm.nearLocation}`,
        lat: rm.lat,
        lon: rm.lon,
        radiusM: 3000,
        title: rm.type === 'm12_enter' ? 'Въезд на M-12' : 'Съезд с M-12',
        body: rm.nearLocation,
      });
    }
  }
  // legs' overnight has no lat/lon in the schema — always skipped (no coords).

  const timeTriggers: TimeTrigger[] = [
    {
      id: 'depart',
      at: plan.window.departPlanned,
      title: 'Выезд',
      body: `Пора выезжать: ${plan.title}`,
    },
    ...plan.reminders.map((r) => ({
      id: `reminder-${r.id}`,
      at: r.when,
      title: r.critical ? 'Важно' : 'Напоминание',
      body: r.text,
    })),
  ];

  return {
    mode,
    headline,
    sub,
    contextLines,
    reminders,
    geoTriggers,
    timeTriggers,
    deadlineBufferHours,
    version: TRIP_STATE_VERSION,
    serverTime: now.toISOString(),
  };
}

@Injectable()
export class TripService implements OnModuleInit {
  private readonly logger = new Logger(TripService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    const file = '001_trip.sql';
    const candidates = [
      path.join(__dirname, 'migrations', file),
      path.join(__dirname, '..', '..', 'src', 'trip', 'migrations', file),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`trip migration ${file} applied from ${p}`);
          break;
        }
      } catch (e: any) {
        this.logger.error(`trip migration ${file} failed (${p}): ${e.message}`);
      }
    }

    try {
      const existing = await this.pg.query(`SELECT id FROM trips WHERE user_id = $1 LIMIT 1`, [OWNER_USER_ID]);
      if (!existing.rows[0]) {
        await this.pg.query(
          `INSERT INTO trips (id, user_id, plan) VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [TRIP_2026_07.id, OWNER_USER_ID, JSON.stringify(TRIP_2026_07)],
        );
        this.logger.log(`seeded TRIP_2026_07 for owner ${OWNER_USER_ID}`);
      }
    } catch (e: any) {
      this.logger.error(`trip seed failed: ${e.message}`);
    }
  }

  private async loadPlan(userId: string): Promise<TripPlan | null> {
    const res = await this.pg.query(
      `SELECT plan FROM trips WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [userId],
    );
    const row = res.rows[0] as { plan: TripPlan } | undefined;
    return row ? row.plan : null;
  }

  private async loadActions(userId: string, tripId: string): Promise<TripAction[]> {
    const res = await this.pg.query(
      `SELECT kind, payload FROM trip_actions WHERE user_id = $1 AND trip_id = $2 ORDER BY created_at ASC`,
      [userId, tripId],
    );
    return res.rows.map((r: any) => ({ kind: r.kind, payload: r.payload }));
  }

  async getState(userId: string): Promise<CoPilotState> {
    const plan = await this.loadPlan(userId);
    if (!plan) {
      return {
        mode: 'idle',
        headline: 'Поездка ещё не запланирована',
        contextLines: [],
        reminders: [],
        geoTriggers: [],
        timeTriggers: [],
        version: TRIP_STATE_VERSION,
        serverTime: new Date().toISOString(),
      };
    }
    const actions = await this.loadActions(userId, plan.id);
    return computeState(plan, new Date(), actions);
  }

  async applyAction(userId: string, idemKey: string, kind: string, payload: any): Promise<CoPilotState> {
    if (!idemKey) throw new BadRequestException('idemKey required');
    if (!kind) throw new BadRequestException('kind required');
    const plan = await this.loadPlan(userId);
    if (!plan) throw new BadRequestException('no trip plan for user');

    await this.pg.query(
      `INSERT INTO trip_actions (trip_id, user_id, idem_key, kind, payload)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (idem_key) DO NOTHING`,
      [plan.id, userId, idemKey, kind, JSON.stringify(payload ?? {})],
    );

    return this.getState(userId);
  }

  async getPlan(userId: string): Promise<TripPlan | null> {
    return this.loadPlan(userId);
  }

  async upsertPlan(userId: string, plan: TripPlan): Promise<TripPlan> {
    const errors = validateTripPlan(plan);
    if (errors.length > 0) {
      throw new BadRequestException(`invalid trip plan: ${errors.join('; ')}`);
    }
    await this.pg.query(
      `INSERT INTO trips (id, user_id, plan, updated_at)
       VALUES ($1, $2, $3::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan, updated_at = now()`,
      [plan.id, userId, JSON.stringify(plan)],
    );
    return plan;
  }
}
