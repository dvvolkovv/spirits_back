import { PriemController } from './priem.controller';
import { PACKAGES } from './packages';

/**
 * Ответ этого эндпоинта читают уже выложенные витрины, поэтому форма
 * расширяется только аддитивно: поле `usd` у валютных пакетов остаётся до тех
 * пор, пока все витрины не перейдут на `price`.
 */

function fakeRes() {
  const out: any = {};
  return {
    out,
    status(code: number) { out.code = code; return this; },
    json(body: any) { out.body = body; return this; },
  };
}

/** «Приём» настроен и отдаёт свои пакеты. */
const priemOn = {
  configured: () => true,
  packages: () => [{ id: 'pro_usd', tokens: 1_000_000, usd: 25, cardAvailable: true }],
};

describe('payments/methods', () => {
  it('для русского языка отдаёт рублёвый прайс', async () => {
    const res = fakeRes();
    await new PriemController(priemOn as any).methods('ru', res as any);

    expect(res.out.body.provider).toBe('yookassa');
    expect(res.out.body.currency).toBe('RUB');
    expect(res.out.body.packages.map((p: any) => p.id)).toEqual(PACKAGES.map((p) => p.id));
  });

  it('рублёвый пакет несёт цену, объём и ярлык скидки', async () => {
    const res = fakeRes();
    await new PriemController(priemOn as any).methods('ru', res as any);

    const pro = res.out.body.packages.find((p: any) => p.id === 'professional');
    expect(pro).toMatchObject({ price: 1990, tokens: 1_000_000, savingsPct: 30 });
  });

  it('исторические псевдонимы наружу не отдаются', async () => {
    const res = fakeRes();
    await new PriemController(priemOn as any).methods('ru', res as any);

    const ids = res.out.body.packages.map((p: any) => p.id);
    expect(ids).not.toContain('basic');
    expect(ids).not.toContain('premium');
  });

  // Выложенная витрина читает p.usd. Уберём его — крипто-витрина у всех
  // сломается в момент выката, ещё до обновления фронта.
  it('валютный пакет сохраняет usd и получает price рядом', async () => {
    const res = fakeRes();
    await new PriemController(priemOn as any).methods('en', res as any);

    expect(res.out.body.provider).toBe('priem');
    const pkg = res.out.body.packages[0];
    expect(pkg.usd).toBe(25);
    expect(pkg.price).toBe(25);
  });

  it('без настроенного «Приёма» иностранец видит рублёвую витрину', async () => {
    const priemOff = { configured: () => false, packages: () => [] };
    const res = fakeRes();
    await new PriemController(priemOff as any).methods('en', res as any);

    expect(res.out.body.provider).toBe('yookassa');
    expect(res.out.body.packages.length).toBe(PACKAGES.length);
  });
});
