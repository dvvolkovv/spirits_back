/**
 * Страховка доставки алертов Prometheus.
 *
 * Инцидент 2026-10-23: прокси my.linkeon.io лежал 22 минуты. Prometheus на
 * node-3 поймал это за 3 минуты, но Alertmanager слал в единственный чат —
 * личку, где бота заблокировали ещё 09.08. Telegram отвечал 403, и за 2,5
 * месяца не дошёл ни один алерт инфраструктуры. Проверять сам канал было некому.
 */

jest.mock('../common/telegram-alert', () => ({
  sendTelegramAlert: jest.fn(async () => {}),
  telegramConfigured: jest.fn(() => true),
}));

import { AlertDeliveryService } from './alert-delivery.service';
import { sendTelegramAlert, telegramConfigured } from '../common/telegram-alert';

const mockedSend = sendTelegramAlert as jest.Mock;
const mockedConfigured = telegramConfigured as jest.Mock;
const texts = () => mockedSend.mock.calls.map((c) => String(c[0]));

type Sample = { metric: Record<string, string>; value: [number, string] };
const one = (v: number, metric: Record<string, string> = {}): Sample[] => [{ metric, value: [0, String(v)] }];

/** Ответы Prometheus по умолчанию — вся цепочка доставки здорова. */
function healthy(): Record<string, Sample[] | Error> {
  return {
    'up{job="alertmanager"}': one(1, { job: 'alertmanager' }),
    alertmanager_notifications_failed_total: one(0),
    alertmanager_notifications_total: one(0),
    prometheus_notifications_alertmanagers_discovered: one(1),
    prometheus_notifications_errors_total: one(0),
    'ALERTS{': [],
  };
}

function makeMonitoring(answers: Record<string, Sample[] | Error>) {
  return {
    query: jest.fn(async (promql: string) => {
      const key = Object.keys(answers).find((k) => promql.includes(k));
      if (!key) throw new Error(`unexpected promql ${promql}`);
      const a = answers[key];
      if (a instanceof Error) throw a;
      return a;
    }),
  };
}

/** monitor_alert_state в памяти — переживает «рестарт» (новый экземпляр сервиса). */
function makePg(seed: Record<string, { alerted: boolean; updated_at: Date }> = {}, { failReads = false } = {}) {
  const table = { ...seed };
  return {
    table,
    query: jest.fn(async (sql: string, params: any[] = []) => {
      if (sql.includes('SELECT')) {
        if (failReads) throw new Error('connection terminated');
        const r = table[params[0]];
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('INSERT')) {
        table[params[0]] = { alerted: params[1], updated_at: new Date() };
      }
      return { rows: [] };
    }),
  };
}

function makeService(answers: Record<string, Sample[] | Error>, pg = makePg()) {
  const monitoring = makeMonitoring(answers);
  const svc = new AlertDeliveryService(monitoring as any, pg as any);
  return { svc, monitoring, pg, answers };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockedConfigured.mockReturnValue(true);
});

describe('AlertDeliveryService', () => {
  it('цепочка здорова — молчим', async () => {
    const { svc } = makeService(healthy());

    await svc.check();
    await svc.check();

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('Alertmanager не может отправить в Telegram — алерт с горящими page-алертами', async () => {
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(12);
    answers['ALERTS{'] = [
      { metric: { alertname: 'BlackboxProbeFailed', instance: 'https://my.linkeon.io' }, value: [0, '1'] },
    ];
    const { svc } = makeService(answers);

    await svc.check();
    expect(mockedSend).not.toHaveBeenCalled(); // одна проверка — ещё не повод

    await svc.check();
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('Alertmanager');
    expect(texts()[0]).toContain('BlackboxProbeFailed');
    expect(texts()[0]).toContain('https://my.linkeon.io');

    await svc.check(); // сбой длится — повтор не раньше кулдауна
    expect(texts()).toHaveLength(1);
  });

  it('Prometheus не отвечает — алерт: инфраструктурные алерты не работают', async () => {
    const answers = healthy();
    for (const k of Object.keys(answers)) answers[k] = new Error('fetch failed');
    const { svc } = makeService(answers);

    await svc.check();
    await svc.check();

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('Prometheus');
    expect(texts()[0]).toContain('fetch failed');
  });

  it('Alertmanager выпал из скрейпа — алерт', async () => {
    const answers = healthy();
    answers['up{job="alertmanager"}'] = one(0, { job: 'alertmanager' });
    const { svc } = makeService(answers);

    await svc.check();
    await svc.check();

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('Alertmanager');
  });

  it('Prometheus не может отдать алерты в Alertmanager — алерт', async () => {
    const answers = healthy();
    answers.prometheus_notifications_errors_total = one(3);
    const { svc } = makeService(answers);

    await svc.check();
    await svc.check();

    expect(texts()).toHaveLength(1);
  });

  it('одиночный блип не алертит', async () => {
    const answers = healthy();
    const { svc } = makeService(answers);

    answers['up{job="alertmanager"}'] = new Error('timeout');
    await svc.check();
    answers['up{job="alertmanager"}'] = one(1, { job: 'alertmanager' });
    await svc.check();
    answers['up{job="alertmanager"}'] = new Error('timeout');
    await svc.check();

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('после сбоя — один отбой, когда Alertmanager реально доставил сообщение', async () => {
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(5);
    answers.alertmanager_notifications_total = one(5);
    const { svc } = makeService(answers);
    await svc.check();
    await svc.check();
    mockedSend.mockClear();

    answers.alertmanager_notifications_failed_total = one(0);
    answers.alertmanager_notifications_total = one(1); // одна отправка — и успешная
    await svc.check();
    await svc.check();

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('🔔');
  });

  it('отказы прекратились, но и отправок не было — «снова доходят» не пишем', async () => {
    // Алерт погас, Alertmanager перестал пытаться — отказов ноль, но получатель
    // может быть сломан по-прежнему. Отбой без доказательства был бы ложью.
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(3);
    answers.alertmanager_notifications_total = one(3);
    const { svc } = makeService(answers);
    await svc.check();
    await svc.check();
    mockedSend.mockClear();

    answers.alertmanager_notifications_failed_total = one(0);
    answers.alertmanager_notifications_total = one(0);
    await svc.check();
    await svc.check();
    expect(mockedSend).not.toHaveBeenCalled();

    answers.alertmanager_notifications_total = one(1); // первая успешная отправка
    await svc.check();
    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('🔔');
  });

  it('Prometheus снова отвечает — отбой без ожидания отправок', async () => {
    // Доставку в Telegram никто не ломал — доказывать её не нужно.
    const answers = healthy();
    for (const k of Object.keys(answers)) answers[k] = new Error('fetch failed');
    const { svc } = makeService(answers);
    await svc.check();
    await svc.check();
    mockedSend.mockClear();

    Object.assign(answers, healthy());
    await svc.check();

    expect(texts()).toHaveLength(1);
    expect(texts()[0]).toContain('🔔');
  });

  it('база недоступна — тик пропускаем, а не шлём каждые 5 минут', async () => {
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(5);
    const { svc } = makeService(answers, makePg({}, { failReads: true }));

    await svc.check();
    await svc.check();
    await svc.check();

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('рестарт посреди сбоя не дублирует алерт', async () => {
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(5);
    const pg = makePg({
      prom_alert_delivery: { alerted: true, updated_at: new Date(Date.now() - 10 * 60_000) },
    });
    const { svc } = makeService(answers, pg);

    await svc.check();
    await svc.check();

    expect(mockedSend).not.toHaveBeenCalled();
  });

  it('сбой тянется дольше кулдауна — напоминаем', async () => {
    const answers = healthy();
    answers.alertmanager_notifications_failed_total = one(5);
    const pg = makePg({
      prom_alert_delivery: { alerted: true, updated_at: new Date(Date.now() - 4 * 3600_000) },
    });
    const { svc } = makeService(answers, pg);

    await svc.check();
    await svc.check();

    expect(texts()).toHaveLength(1);
  });

  it('Telegram не настроен (test-стенд) — Prometheus не опрашиваем', async () => {
    mockedConfigured.mockReturnValue(false);
    const { svc, monitoring } = makeService(healthy());

    await svc.check();

    expect(monitoring.query).not.toHaveBeenCalled();
    expect(mockedSend).not.toHaveBeenCalled();
  });
});
