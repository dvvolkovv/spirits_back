import { ZoomController } from './zoom.controller';

/**
 * Возврат от Zoom ведёт на карточку Zoom в профиле с пометкой исхода
 * (/profile?open=zoom&zoom_connect=…): кабинет раскрывает «Настройки» и
 * прокручивает к карточке, а та показывает исход. Раньше — на корень, откуда
 * кабинет уводил в чат и пометку терял (RootRedirect переносит только
 * ?assistant=): человек не видел ни «подключено», ни «отказались».
 */
describe('возврат от Zoom', () => {
  const saved = process.env.PUBLIC_BASE_URL;
  beforeEach(() => {
    process.env.PUBLIC_BASE_URL = 'https://my.linkeon.io';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = saved;
  });

  function run(o: { error?: string; userId?: string | null; ok?: boolean } = {}) {
    const oauth = {
      claimState: jest.fn(async () => (o.userId === undefined ? 'u-1' : o.userId)),
      complete: jest.fn(async () => o.ok ?? true),
    };
    const res = { redirect: jest.fn() };
    const done = new ZoomController(oauth as any).callback('code', 'state', o.error as any, res as any);
    return { done, res, oauth };
  }

  it('успех — на карточку Zoom с пометкой ok', async () => {
    const { done, res } = run();
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=ok');
  });

  it('человек отказался — denied, код не обменивается', async () => {
    const { done, res, oauth } = run({ error: 'access_denied' });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=denied');
    expect(oauth.complete).not.toHaveBeenCalled();
  });

  it('протухший state — expired', async () => {
    const { done, res } = run({ userId: null });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=expired');
  });

  it('обмен не удался — failed', async () => {
    const { done, res } = run({ ok: false });
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://my.linkeon.io/profile?open=zoom&zoom_connect=failed');
  });

  it('слэш в конце базового адреса не удваивается', async () => {
    process.env.PUBLIC_BASE_URL = 'https://test.linkeon.io/';
    const { done, res } = run();
    await done;
    expect(res.redirect).toHaveBeenCalledWith('https://test.linkeon.io/profile?open=zoom&zoom_connect=ok');
  });
});
