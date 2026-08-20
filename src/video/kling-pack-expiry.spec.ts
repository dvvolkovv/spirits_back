/**
 * Пакет Kling сгорает по сроку, а не по расходу — предупреждать надо заранее.
 *
 * Разбор 20.08.2026: пакет `Trial-Video-100Units-5Con-1Months` куплен 13.07,
 * истёк 12.08 с остатком 94 из 100 юнитов. Первый отказ `1102 Account balance
 * not enough` пришёл 13.08 — на следующий день. Неделю видео не работало, и
 * узнали мы это случайно.
 *
 * Реактивная тревога (video.provider-billing-alert) ловит поломку в день, когда
 * она уже случилась. Этот сторож должен успевать раньше: предупредить, пока
 * пакет ещё жив, и отдельно сказать, если активного пакета не осталось вовсе.
 */
import { KlingService } from '../misc/kling.service';
import { VideoService } from './video.service';

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => undefined),
  telegramConfigured: () => true,
}));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { sendTelegramAlert } = require('../common/telegram-alert');

jest.mock('axios');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

const DAY = 24 * 3600 * 1000;
const NOW = 1787195374077; // 20.08.2026 06:09 UTC — время разбора

function pack(over: Partial<any> = {}) {
  return {
    resource_pack_name: 'Trial-Video-100Units-5Con-1Months',
    resource_pack_id: '842480030994940425',
    total_quantity: 100,
    remaining_quantity: 98,
    purchase_time: NOW - 30 * DAY,
    effective_time: NOW - 30 * DAY,
    invalid_time: NOW + 30 * DAY,
    status: 'online',
    ...over,
  };
}

/**
 * Пакет уже в разобранном виде — именно так его отдаёт getResourcePacks.
 * Сырые поля Kling живут только в тесте на разбор ответа выше.
 */
function mapped(over: Partial<any> = {}) {
  const raw = pack(over);
  return {
    name: raw.resource_pack_name,
    total: raw.total_quantity,
    remaining: raw.remaining_quantity,
    expiresAt: raw.invalid_time,
    status: raw.status,
  };
}

/** Сервис с подставным Kling: сам HTTP не трогаем, кроме теста разбора ответа. */
function videoServiceWith(packs: any[] | null) {
  const kling = { getResourcePacks: jest.fn(async () => packs) };
  return new (VideoService as any)(undefined, kling, undefined, undefined, undefined, undefined);
}

describe('KlingService.getResourcePacks', () => {
  beforeEach(() => (axios.get as jest.Mock)?.mockReset?.());

  it('достаёт пакеты из вложенного ответа Kling', async () => {
    axios.get = jest.fn(async () => ({
      data: { data: { code: 0, resource_pack_subscribe_infos: [pack(), pack({ status: 'expired', remaining_quantity: 94 })] } },
    }));
    const svc = new KlingService();
    (svc as any).ak = 'ak';
    (svc as any).sk = 'sk';

    const packs = await svc.getResourcePacks();

    expect(packs).toHaveLength(2);
    expect(packs![0]).toMatchObject({ total: 100, remaining: 98, status: 'online' });
    expect(packs![1]).toMatchObject({ remaining: 94, status: 'expired' });
  });

  it('без ключей не ходит в сеть и отдаёт null', async () => {
    axios.get = jest.fn();
    const svc = new KlingService();
    (svc as any).ak = '';
    (svc as any).sk = '';

    expect(await svc.getResourcePacks()).toBeNull();
    expect(axios.get).not.toHaveBeenCalled();
  });

  it('ошибка сети — null, а не исключение', async () => {
    axios.get = jest.fn(async () => { throw new Error('timeout'); });
    const svc = new KlingService();
    (svc as any).ak = 'ak';
    (svc as any).sk = 'sk';

    await expect(svc.getResourcePacks()).resolves.toBeNull();
  });
});

describe('VideoService.checkKlingPackExpiry', () => {
  beforeEach(() => (sendTelegramAlert as jest.Mock).mockClear());

  it('до срока далеко — молчит', async () => {
    await videoServiceWith([mapped({ invalid_time: NOW + 20 * DAY })]).checkKlingPackExpiry(NOW);

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('за три дня до сгорания предупреждает и называет остаток', async () => {
    await videoServiceWith([
      mapped({ invalid_time: NOW + 2 * DAY, remaining_quantity: 95, total_quantity: 100 }),
    ]).checkKlingPackExpiry(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    const text = String((sendTelegramAlert as jest.Mock).mock.calls[0][0]);
    expect(text).toMatch(/95/);
    expect(text).toMatch(/100/);
    expect(text).toMatch(/2026-08-22/); // дата сгорания, а не «через сколько-то дней»
  });

  it('активного пакета не осталось — отдельная тревога', async () => {
    await videoServiceWith([
      mapped({ status: 'expired', invalid_time: NOW - DAY, remaining_quantity: 94 }),
    ]).checkKlingPackExpiry(NOW);

    expect(sendTelegramAlert).toHaveBeenCalledTimes(1);
    expect(String((sendTelegramAlert as jest.Mock).mock.calls[0][0])).toMatch(/нет активного пакета|закончил/i);
  });

  it('просроченный пакет рядом с живым тревоги не поднимает', async () => {
    await videoServiceWith([
      mapped({ status: 'expired', invalid_time: NOW - DAY }),
      mapped({ invalid_time: NOW + 25 * DAY }),
    ]).checkKlingPackExpiry(NOW);

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('API недоступен — молчим, а не пугаем ложной тревогой', async () => {
    await videoServiceWith(null).checkKlingPackExpiry(NOW);

    expect(sendTelegramAlert).not.toHaveBeenCalled();
  });

  it('падение телеграма крон не роняет', async () => {
    (sendTelegramAlert as jest.Mock).mockImplementationOnce(async () => { throw new Error('tg down'); });

    await expect(
      videoServiceWith([mapped({ invalid_time: NOW + DAY })]).checkKlingPackExpiry(NOW),
    ).resolves.toBeUndefined();
  });
});
