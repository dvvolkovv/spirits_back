import { computeState } from './trip.service';
import { TRIP_2026_07 } from './seed-2026-07';

// TRIP_2026_07 window: activateFrom 2026-07-18T00:00:00, departPlanned
// 2026-07-20T16:00:00, endEstimated 2026-07-23T14:10:00. deadline.datetime =
// 2026-07-23T14:10:00 (same as endEstimated, flexible=true).

describe('computeState', () => {
  it('mode = idle before activateFrom', () => {
    const now = new Date('2026-07-17T12:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.mode).toBe('idle');
  });

  it('mode = pre_trip within [activateFrom, departPlanned), reminders present, headline about prep', () => {
    const now = new Date('2026-07-19T10:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.mode).toBe('pre_trip');
    expect(state.reminders.length).toBeGreaterThan(0);
    expect(/подготов|собра|выезд/i.test(state.headline)).toBe(true);
  });

  it('mode = active within [departPlanned, endEstimated], deadlineBufferHours > 0, headline non-empty', () => {
    const now = new Date('2026-07-21T12:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.mode).toBe('active');
    expect(state.deadlineBufferHours).toBeGreaterThan(0);
    expect(state.headline.length).toBeGreaterThan(0);
  });

  it('mode = active at the exact boundary endEstimated (inclusive)', () => {
    const now = new Date('2026-07-23T14:10:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.mode).toBe('active');
  });

  it('deadline_update action shifts the datetime and recomputes deadlineBufferHours', () => {
    const now = new Date('2026-07-21T12:00:00');
    const base = computeState(TRIP_2026_07, now, []);
    const shifted = computeState(TRIP_2026_07, now, [
      { kind: 'deadline_update', payload: { datetime: '2026-07-24T18:00:00' } },
    ]);
    expect(shifted.deadlineBufferHours).toBeGreaterThan(base.deadlineBufferHours as number);
  });

  it('reminder_done action marks that reminder done=true and leaves others untouched', () => {
    const now = new Date('2026-07-19T10:00:00');
    const state = computeState(TRIP_2026_07, now, [
      { kind: 'reminder_done', payload: { id: 'meds' } },
    ]);
    const meds = state.reminders.find((r) => r.id === 'meds');
    const pack = state.reminders.find((r) => r.id === 'pack');
    expect(meds?.done).toBe(true);
    expect(pack?.done).toBeFalsy();
  });

  it('geoTriggers only include fuelPoints/roadMarks with lat/lon (seed has none -> empty)', () => {
    const now = new Date('2026-07-21T12:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(Array.isArray(state.geoTriggers)).toBe(true);
    expect(state.geoTriggers.length).toBe(0);
  });

  it('timeTriggers include departPlanned and prep reminders', () => {
    const now = new Date('2026-07-19T10:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.timeTriggers.some((t) => t.at === TRIP_2026_07.window.departPlanned)).toBe(true);
    expect(state.timeTriggers.length).toBeGreaterThan(1);
  });

  it('serverTime and version are set', () => {
    const now = new Date('2026-07-19T10:00:00');
    const state = computeState(TRIP_2026_07, now, []);
    expect(state.version).toBeGreaterThan(0);
    expect(state.serverTime).toBe(now.toISOString());
  });
});
