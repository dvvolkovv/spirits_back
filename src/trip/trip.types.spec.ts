import { TripPlan, validateTripPlan } from './trip.types';
import { TRIP_2026_07 } from './seed-2026-07';

function validPlan(): TripPlan {
  return {
    id: 'trip-2026-07',
    title: 'Уфа — Москва (суд)',
    status: 'upcoming',
    window: {
      activateFrom: '2026-07-18T00:00:00',
      departPlanned: '2026-07-20T16:00:00',
      endEstimated: '2026-07-23T14:10:00',
    },
    deadline: {
      title: 'Заседание суда',
      datetime: '2026-07-23T14:10:00',
      flexible: true,
      note: 'может сдвинуться в тот же день или перенестись',
    },
    legs: [
      { from: 'Уфа', to: 'Буздяк', distanceKm: 115 },
      { from: 'Буздяк', to: 'Наб. Челны', distanceKm: 230 },
      { from: 'Наб. Челны', to: 'Нижний Новгород', distanceKm: 600, overnight: { city: 'Нижний Новгород', note: 'прогулка по городу' } },
      { from: 'Нижний Новгород', to: 'Москва', distanceKm: 420 },
    ],
    fuelPoints: [
      { nearLocation: 'АЗС на M-12 у Челнов', note: 'держать бак выше половины', kmWithoutFuelAfter: 120 },
    ],
    roadMarks: [
      { type: 'm12_enter', nearLocation: 'у Наб. Челнов' },
      { type: 'm12_exit', nearLocation: 'подъезд к Москве' },
    ],
    reminders: [
      { id: 'meds', when: '2026-07-20T15:30:00', text: 'ОБЯЗАТЕЛЬНО взять лекарства Савы', critical: true },
    ],
  };
}

describe('validateTripPlan', () => {
  it('returns [] for a valid plan', () => {
    expect(validateTripPlan(validPlan())).toEqual([]);
  });

  it('returns errors when title is missing', () => {
    const p: any = validPlan();
    delete p.title;
    const errors = validateTripPlan(p);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /title/i.test(e))).toBe(true);
  });

  it('returns errors when deadline.datetime is missing', () => {
    const p: any = validPlan();
    delete p.deadline.datetime;
    const errors = validateTripPlan(p);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /deadline/i.test(e))).toBe(true);
  });

  it('returns errors when legs is empty', () => {
    const p: any = validPlan();
    p.legs = [];
    const errors = validateTripPlan(p);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /legs/i.test(e))).toBe(true);
  });

  it('returns errors when plan is null/undefined', () => {
    expect(validateTripPlan(null).length).toBeGreaterThan(0);
    expect(validateTripPlan(undefined).length).toBeGreaterThan(0);
  });

  it('the real seeded 2026-07 trip plan is valid', () => {
    expect(validateTripPlan(TRIP_2026_07)).toEqual([]);
  });
});
