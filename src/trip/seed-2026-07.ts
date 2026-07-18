import { TripPlan } from './trip.types';

// Реальная поездка владельца: Уфа → Буздяк (забрать маму, высадить маму + сына Саву)
// → Наб. Челны (заезд на M-12) → Нижний Новгород (ночёвка, прогулка по городу) → Москва
// (суд 23.07). Собран из диалога с Романом (см. план "Штурман").
export const TRIP_2026_07: TripPlan = {
  id: 'trip-2026-07-ufa-moscow',
  title: 'Уфа — Москва (суд 23.07)',
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
    {
      from: 'Уфа',
      to: 'Буздяк',
      distanceKm: 115,
      departPlanned: '2026-07-20T16:00:00',
      arrivePlanned: '2026-07-20T17:30:00',
    },
    {
      from: 'Буздяк',
      to: 'Наб. Челны',
      distanceKm: 230,
      departPlanned: '2026-07-20T18:00:00',
      arrivePlanned: '2026-07-20T21:00:00',
      overnight: { city: 'Наб. Челны', note: 'ночёвка, разумная цена' },
    },
    {
      from: 'Наб. Челны',
      to: 'Нижний Новгород',
      distanceKm: 600,
      departPlanned: '2026-07-21T09:00:00',
      arrivePlanned: '2026-07-21T18:00:00',
      overnight: { city: 'Нижний Новгород', note: 'прогулка по городу' },
    },
    {
      from: 'Нижний Новгород',
      to: 'Москва',
      distanceKm: 420,
      departPlanned: '2026-07-22T10:00:00',
      arrivePlanned: '2026-07-22T17:00:00',
    },
  ],
  fuelPoints: [
    {
      nearLocation: 'Лукойл на M-12 у Наб. Челнов',
      note: 'держать бак выше половины, заправляться утром — меньше очередей',
      kmWithoutFuelAfter: 120,
    },
    {
      nearLocation: 'Роснефть на M-12 (участок Чебоксары — Нижний Новгород)',
      note: 'держать бак выше половины, заправляться утром — меньше очередей',
    },
  ],
  roadMarks: [
    { type: 'm12_enter', nearLocation: 'у Наб. Челнов' },
    { type: 'm12_exit', nearLocation: 'подъезд к Москве' },
  ],
  reminders: [
    {
      id: 'meds',
      when: '2026-07-20T15:30:00',
      text: 'ОБЯЗАТЕЛЬНО взять лекарства Савы',
      critical: true,
    },
    {
      id: 'pack',
      when: '2026-07-19T17:00:00',
      text: 'Начать собирать вещи Савы',
      critical: false,
    },
    {
      id: 'toys',
      when: '2026-07-20T10:00:00',
      text: 'Купить Саве большой конструктор + пазл (занять в Буздяке)',
      critical: false,
    },
  ],
  prefs: {
    overnight_nn: 'прогулка по городу',
    comfort: 'разумная цена, комфорт',
    fuel: 'бак выше половины',
  },
};
