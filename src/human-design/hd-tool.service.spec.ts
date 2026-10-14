import { type CityDb } from './cities';
import { CITIES_DIR, HumanDesignToolService } from './hd-tool.service';
import { loadMultilingualCities, multilingualCities, type MultilingualCities } from './multilang-index';

const IMAGE = 'https://media.example/linkeon-assets/images/1-abc.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

/** Настоящие базы — один раз на файл: сборка указателя семи баз — около секунды. */
let REAL: MultilingualCities;
beforeAll(() => {
  REAL = loadMultilingualCities(CITIES_DIR);
});

/** cities — готовый указатель (по умолчанию настоящий); null — сервис читает базы сам. */
function service(cities: MultilingualCities | null = REAL) {
  const upload = jest.fn(async () => IMAGE);
  const svc = new HumanDesignToolService({ uploadAssetImage: upload } as any);
  if (cities) svc['cities'] = cities;
  return { svc, upload };
}

/** База из двух одноимённых городов — для ветки уточнения (настоящая база может измениться). */
const TWINS: CityDb = {
  v: 1,
  zones: ['Europe/Moscow'],
  countries: { RU: 'Россия' },
  regions: ['Мурманская область', 'Ленинградская область'],
  cities: [
    ['Кировск', 'Kirovsk', 'RU', 0, 27, 0],
    ['Кировск', 'Kirovsk', 'RU', 0, 26, 1],
  ],
};
/** TWINS на всех языках сайта — одна и та же база, указатель тот же, что у настоящих. */
const twins = () => multilingualCities(() => TWINS);

describe('инструмент calculate_human_design', () => {
  it('Казань, 12.03.1990, 14:25 — Манифестор 5/2, эмоциональный, картинка PNG', async () => {
    const { svc, upload } = service();
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Казань' });
    expect(r).toMatchObject({
      ok: true,
      kind: 'chart',
      city: { name: 'Казань', zone: 'Europe/Moscow' },
      offset: 'UTC+3',
      type: 'manifestor',
      profile: '5/2',
      authority: 'emotional',
      imageUrl: IMAGE,
    });
    if (!(r.ok && r.kind === 'chart')) throw new Error('ожидалась карта');
    expect(r.personality).toHaveLength(13);
    expect(r.design).toHaveLength(13);
    expect(r.personality[0]).toEqual({ body: 'sun', gate: expect.any(Number), line: expect.any(Number) });
    expect(upload).toHaveBeenCalledTimes(1);
    const [buf, ext] = upload.mock.calls[0] as unknown as [Buffer, string];
    expect(ext).toBe('png');
    expect(buf.subarray(0, 4)).toEqual(PNG);
  });

  it('одноимённые города — варианты, без расчёта и картинки; cityId из вариантов — карта', async () => {
    const { svc, upload } = service(twins());
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск' });
    expect(r).toEqual({
      ok: true,
      kind: 'choose_city',
      total: 2,
      candidates: [
        { cityId: 0, name: 'Кировск', region: 'Мурманская область', country: 'Россия', zone: 'Europe/Moscow' },
        { cityId: 1, name: 'Кировск', region: 'Ленинградская область', country: 'Россия', zone: 'Europe/Moscow' },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    const again = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск', cityId: 1 });
    expect(again).toMatchObject({ ok: true, kind: 'chart', city: { region: 'Ленинградская область' } });
  });

  it('cityId строкой — тоже принимается, если совпадает с названием города', async () => {
    const { svc } = service(twins());
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск', cityId: '1' });
    expect(r).toMatchObject({ ok: true, kind: 'chart', city: { region: 'Ленинградская область' } });
  });

  it('cityId не из вариантов — понятная ошибка, не падение', async () => {
    const { svc } = service(twins());

    const bad = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск', cityId: 'abc' });
    expect(bad).toEqual({ ok: false, error: 'cityId не из вариантов прошлого ответа — вызовите без cityId.' });

    // cityId=0 — «Кировск», а город в этом же вызове назван «Казань»: несоответствие.
    const mismatch = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Казань', cityId: 0 });
    expect(mismatch).toEqual({ ok: false, error: 'cityId не из вариантов прошлого ответа — вызовите без cityId.' });
  });

  it('cityId из подсказки (не только точного совпадения) — реальная база: «Новгород» → Великий Новгород', async () => {
    const { svc } = service();
    const first = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Новгород' });
    expect(first.ok && first.kind).toBe('choose_city');
    if (!(first.ok && first.kind === 'choose_city')) throw new Error('ожидались варианты');
    const veliky = first.candidates.find((c) => c.name === 'Великий Новгород');
    expect(veliky).toBeDefined();
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Новгород', cityId: veliky!.cityId });
    expect(r).toMatchObject({ ok: true, kind: 'chart', city: { name: 'Великий Новгород' } });
  });

  it('город на любом языке сайта — карта с русскими подписями', async () => {
    const { svc } = service();
    for (const city of ['München, Bayern', 'Munich', '慕尼黑']) {
      const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city });
      expect(r).toMatchObject({
        ok: true,
        kind: 'chart',
        city: { name: 'Мюнхен', region: 'Бавария', country: 'Германия', zone: 'Europe/Berlin' },
        offset: 'UTC+1',
      });
    }
  });

  it('варианты по названию не по-русски — с русскими подписями; cityId из них принимается с тем же названием', async () => {
    const { svc } = service();
    const first = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Sevilla' });
    if (!(first.ok && first.kind === 'choose_city')) throw new Error('ожидались варианты');
    expect(first.candidates.map((c) => c.country)).toEqual(['Испания', 'Колумбия']);
    const spain = first.candidates[0];
    expect(spain.name).toBe('Севилья');
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Sevilla', cityId: spain.cityId });
    expect(r).toMatchObject({ ok: true, kind: 'chart', city: { name: 'Севилья', zone: 'Europe/Madrid' } });
  });

  it('час перевода стрелок — вопрос «до или после»; с ответом — карта', async () => {
    const { svc } = service();
    const r = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия' });
    expect(r).toEqual({ ok: true, kind: 'choose_dst', transition: 'ambiguous', before: 'UTC+4', after: 'UTC+3' });
    const after = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия', dst: 'after' });
    expect(after).toMatchObject({ ok: true, kind: 'chart', offset: 'UTC+3' });
  });

  it('1799 год, местное среднее время — карта считается, смещение UTC+2…', async () => {
    const { svc } = service();
    const r = await svc.calculate({ date: '1799-06-06', time: '11:00', city: 'Москва, Россия' });
    expect(r.ok).toBe(true);
    expect(r.ok && r.kind).toBe('chart');
    expect(r.ok && r.kind === 'chart' && r.offset.startsWith('UTC+2')).toBe(true);
  });

  it('время с одной цифрой часа и с секундами — нормализуется', async () => {
    const { svc } = service();
    const a = await svc.calculate({ date: '1990-03-12', time: '9:05', city: 'Казань' });
    expect(a.ok && a.kind === 'chart').toBe(true);
    const b = await svc.calculate({ date: '1990-03-12', time: '14:25:00', city: 'Казань' });
    expect(b.ok && b.kind === 'chart').toBe(true);
  });

  it('дата проверяется раньше города: при плохой дате — ошибка даты, а не выбор города', async () => {
    const { svc } = service(twins()); // «Кировск» здесь неоднозначен
    const r = await svc.calculate({ date: '1990-02-30', time: '14:25', city: 'Кировск' });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/дат/);
  });

  it('ранняя проверка будущего — запас в сутки для восточных поясов (Владивосток), но не в двое суток', async () => {
    const { svc } = service();
    // Фиксируем «сейчас»: вечер по UTC — так дата «на сутки вперёд» по UTC
    // гарантированно даёт момент рождения в прошлом (Владивосток на 10 часов
    // впереди UTC: местная полночь — ещё день по UTC не кончился).
    jest.useFakeTimers().setSystemTime(new Date('2026-06-15T20:00:00Z'));
    try {
      const tomorrow = await svc.calculate({ date: '2026-06-16', time: '00:30', city: 'Владивосток' });
      expect(tomorrow).toMatchObject({ ok: true, kind: 'chart' });

      const dayAfter = await svc.calculate({ date: '2026-06-17', time: '00:30', city: 'Владивосток' });
      expect(dayAfter).toEqual({ ok: false, error: 'Дата рождения в будущем — проверьте год.' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('город длиннее 100 символов — обрезается, не падает', async () => {
    const { svc } = service();
    const longCity = 'а'.repeat(150);
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: longCity });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.includes('а'.repeat(100))).toBe(true);
    expect(!r.ok && r.error.includes('а'.repeat(101))).toBe(false);
  });

  it('без подмены — базы читаются из каталога data при первом вызове', async () => {
    const { svc } = service(null);
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'München, Bayern' });
    expect(r).toMatchObject({ ok: true, kind: 'chart', city: { name: 'Мюнхен' } });
  });

  it('база городов недоступна — понятная ошибка, без падения', async () => {
    const { svc } = service(null);
    (svc as any).citiesDir = '/no/such/dir';
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Казань' });
    expect(r).toEqual({ ok: false, error: 'Инструмент расчёта временно недоступен — посчитайте прежним способом.' });
  });

  it('сбой загрузки баз запоминается на минуту: семь файлов не перечитываются на каждый вызов', async () => {
    const { svc } = service(null);
    let now = 1_000_000;
    (svc as any).now = () => now;
    const loadCities = jest.fn((): MultilingualCities => {
      throw new Error('нет файла');
    });
    (svc as any).loadCities = loadCities;
    const call = () => svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск' });
    const unavailable = { ok: false, error: 'Инструмент расчёта временно недоступен — посчитайте прежним способом.' };

    expect(await call()).toEqual(unavailable);
    expect(await call()).toEqual(unavailable);
    now += 59_000;
    expect(await call()).toEqual(unavailable);
    expect(loadCities).toHaveBeenCalledTimes(1);

    now += 2_000; // минута прошла — пробуем снова, и базы на месте
    loadCities.mockImplementation(twins);
    expect(await call()).toMatchObject({ ok: true, kind: 'choose_city', total: 2 });
    expect(await call()).toMatchObject({ ok: true, kind: 'choose_city', total: 2 });
    expect(loadCities).toHaveBeenCalledTimes(2);
  });

  it('cityId с городом, где регион после «、» или «；», — тоже принимается', async () => {
    const { svc } = service(twins());
    for (const city of ['Кировск、Ленинградская область', 'Кировск；Ленинградская область']) {
      const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city, cityId: 1 });
      expect([city, r]).toMatchObject([city, { ok: true, kind: 'chart', city: { region: 'Ленинградская область' } }]);
    }
  });

  it('картинка не нарисовалась или не загрузилась — карта всё равно возвращается, imageUrl null', async () => {
    const upload = jest.fn(async () => {
      throw new Error('upload failed');
    });
    const svc = new HumanDesignToolService({ uploadAssetImage: upload } as any);
    svc['cities'] = REAL;
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Казань' });
    expect(r).toMatchObject({ ok: true, kind: 'chart', imageUrl: null });
  });

  it('ошибки — понятным текстом и без картинки', async () => {
    const { svc, upload } = service();
    const cases = [
      { input: { date: '1990-03-12', time: '14:25', city: 'Атлантидаград' }, error: /не найден/ },
      { input: { date: '1990-02-30', time: '14:25', city: 'Казань' }, error: /дат/ },
      { input: { date: '1990-03-12', time: '25:00', city: 'Казань' }, error: /врем|дат/ },
      { input: { date: '2999-01-01', time: '12:00', city: 'Казань' }, error: /будущ/ },
      { input: { date: '1990-03-12', time: '14:25' }, error: /город/i },
    ];
    for (const { input, error } of cases) {
      const r = await svc.calculate(input);
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toMatch(error);
    }
    expect(upload).not.toHaveBeenCalled();
  });

  it('«город не найден» — что передать: любой язык сайта, иначе перевод, и страну', async () => {
    const { svc } = service();
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Атлантидаград' });
    const error = r.ok ? '' : r.error;
    expect(error).toMatch(/не найден/);
    expect(error).toMatch(/на любом языке сайта/);
    expect(error).toContain('переведите на английский или русский');
    expect(error).toMatch(/страну/);
    expect(error).not.toMatch(/на языке человека/);
  });
});
