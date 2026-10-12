import { indexCities, type CityDb } from './cities';
import { HumanDesignToolService } from './hd-tool.service';

const IMAGE = 'https://media.example/linkeon-assets/images/1-abc.png';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

function service() {
  const upload = jest.fn(async () => IMAGE);
  const svc = new HumanDesignToolService({ uploadAssetImage: upload } as any);
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
    const { svc, upload } = service();
    svc['index'] = indexCities(TWINS);
    const r = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск' });
    expect(r).toEqual({
      ok: true,
      kind: 'choose_city',
      candidates: [
        { cityId: 0, name: 'Кировск', region: 'Мурманская область', country: 'Россия', zone: 'Europe/Moscow' },
        { cityId: 1, name: 'Кировск', region: 'Ленинградская область', country: 'Россия', zone: 'Europe/Moscow' },
      ],
    });
    expect(upload).not.toHaveBeenCalled();
    const again = await svc.calculate({ date: '1990-03-12', time: '14:25', city: 'Кировск', cityId: 1 });
    expect(again).toMatchObject({ ok: true, kind: 'chart', city: { region: 'Ленинградская область' } });
  });

  it('час перевода стрелок — вопрос «до или после»; с ответом — карта', async () => {
    const { svc } = service();
    const r = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия' });
    expect(r).toEqual({ ok: true, kind: 'choose_dst', transition: 'ambiguous', before: 'UTC+4', after: 'UTC+3' });
    const after = await svc.calculate({ date: '2014-10-26', time: '01:30', city: 'Москва, Россия', dst: 'after' });
    expect(after).toMatchObject({ ok: true, kind: 'chart', offset: 'UTC+3' });
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
});
