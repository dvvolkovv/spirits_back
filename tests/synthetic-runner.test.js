/**
 * Раннер synthetic (крутится по cron на node-3).
 *
 * Инцидент 2026-08-21 10:30 UTC: bootstrap-refresh завис на 30 с и был убит
 * своим же AbortController. Ретрая не было, поэтому один подвисший коннект
 * пометил красными три сценария (profile_with_jwt, tokens_balance,
 * chat_streaming), не отправив ни одного запроса, и поднял критичный алерт.
 * Секундой позже тот же запрос прошёл за 263 мс — раннер держал доказательство
 * собственной неправоты, но выбрасывал его.
 *
 * Повтор refresh безопасен: на бэке он stateless (проверка подписи + выдача
 * новой пары, старый токен не отзывается — auth.service.ts refreshTokens).
 */

const os = require('os');
const path = require('path');
const fs = require('fs');

const BASE = 'https://my.linkeon.io';

function okJson(body) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Map() };
}

function okStream(text) {
  const chunk = new TextEncoder().encode(text);
  let sent = false;
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (sent ? { done: true } : ((sent = true), { value: chunk, done: false })),
        cancel: async () => {},
      }),
    },
  };
}

function okImage() {
  return { ok: true, status: 200, headers: { get: () => 'image/jpeg' } };
}

const SPA_PAGE = '<!doctype html><html><head><title>Linkeon</title></head><body><div id="root"></div></body></html>';
const WG_PUSH = 'http://10.10.0.1:3001/webhook/monitoring/synthetic/push';

function okHtml(page) {
  return { ok: true, status: 200, headers: { get: () => 'text/html; charset=utf-8' }, text: async () => page };
}

/**
 * @param refreshOutcomes массив 'fail' | 'ok' — исход по номеру попытки refresh.
 * @param opts.siteDown   всё, что идёт на BASE (через прокси), падает как
 *                        «fetch failed» — так выглядел прокси, заблокированный 23.10.
 * @param opts.page       что отдаёт главная страница.
 * @param opts.siteFailures сколько первых запросов к главной падают (подвисший коннект).
 */
function installFetch(refreshOutcomes, { siteDown = false, page = SPA_PAGE, siteFailures = 0 } = {}) {
  const pushes = [];
  let refreshCalls = 0;
  let siteCalls = 0;

  global.fetch = jest.fn(async (url, opts = {}) => {
    if (siteDown && url.startsWith(BASE)) throw new TypeError('fetch failed');
    if (url.includes('/webhook/monitoring/synthetic/push')) {
      pushes.push({ ...JSON.parse(opts.body), url });
      return { ok: true, status: 204, text: async () => '' };
    }
    if (url === `${BASE}/`) {
      siteCalls += 1;
      if (siteCalls <= siteFailures) throw new Error('This operation was aborted');
      return okHtml(page);
    }
    if (url.includes('/webhook/auth/refresh')) {
      const outcome = refreshOutcomes[refreshCalls] || 'ok';
      refreshCalls += 1;
      if (outcome === 'fail') throw new Error('This operation was aborted');
      return okJson({ 'access-token': 'access-jwt', 'refresh-token': `rotated-${refreshCalls}` });
    }
    if (url.includes('/webhook/agents')) return okJson(Array.from({ length: 14 }, (_, i) => ({ id: i })));
    if (url.includes('/agent/avatar/')) return okImage();
    if (url.includes('/webhook/profile')) return okJson({ ok: true });
    if (url.includes('/webhook/user/tokens/')) return okJson({ tokens: 42_000 });
    if (url.includes('/webhook/soulmate/chat')) return okStream('{"type":"chunk","content":"pong"}');
    throw new Error(`unexpected url ${url}`);
  });

  return { pushes, refreshCalls: () => refreshCalls };
}

/** Загружает раннер заново, с чистым env и своим state-файлом. */
function loadRunner(env = {}) {
  jest.resetModules();
  const stateFile = path.join(os.tmpdir(), `synthetic-state-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  process.env.BASE_URL = BASE;
  process.env.SYNTHETIC_PUSH_TOKEN = 'push-token';
  process.env.SYNTHETIC_TEST_REFRESH_JWT = 'bootstrap-refresh-jwt';
  process.env.SYNTHETIC_STATE_FILE = stateFile;
  process.env.SYNTHETIC_RETRY_BASE_MS = '1';
  process.env.SYNTHETIC_REFRESH_ATTEMPTS = '3';
  Object.assign(process.env, env);
  const mod = require('../scripts/synthetic-runner.js');
  return { mod, cleanup: () => fs.rmSync(stateFile, { force: true }) };
}

const byKey = (pushes, key) => pushes.filter((p) => p.scenario === key);

afterEach(() => {
  delete global.fetch;
  delete process.env.SYNTHETIC_PUSH_URL;
});

describe('synthetic-runner: доступность сайта и доставка отчётов', () => {
  /**
   * Инцидент 2026-10-23: Selectel заблокировал прокси my.linkeon.io. Раннер слал
   * отчёты на тот же my.linkeon.io — через тот же прокси, который проверял, —
   * и отчёты о падении не дошли: на проде прогона 08:15 UTC нет вообще.
   */
  it('проверяет, что my.linkeon.io открывается (site_reachable)', async () => {
    const { pushes } = installFetch([]);
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(byKey(pushes, 'site_reachable')).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    cleanup();
  });

  it('site_reachable красный, если вместо нашего SPA отдали чужую страницу', async () => {
    // Хостер при блокировке может отвечать 200 своей заглушкой.
    const { pushes } = installFetch([], { page: '<html><body>Услуга приостановлена</body></html>' });
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(byKey(pushes, 'site_reachable')[0]).toMatchObject({ success: false });
    cleanup();
  });

  it('сообщение о чужой странице без угловых скобок (уходит в Telegram как HTML)', async () => {
    const { pushes } = installFetch([], { page: '<html><body>Услуга приостановлена</body></html>' });
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(byKey(pushes, 'site_reachable')[0].message).not.toMatch(/[<>]/);
    cleanup();
  });

  it('один подвисший коннект к главной не красит site_reachable', async () => {
    // Как refresh 21.08: одиночный блип не должен будить людей «сайт не открывается».
    const { pushes } = installFetch([], { siteFailures: 1 });
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(byKey(pushes, 'site_reachable')).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    cleanup();
  });

  it('сайт не открывается ни с одной попытки — красный, с числом попыток', async () => {
    const { pushes } = installFetch([], { siteFailures: 99 });
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    const site = byKey(pushes, 'site_reachable')[0];
    expect(site.success).toBe(false);
    expect(site.message).toContain('попыток: 3');
    cleanup();
  });

  it('с SYNTHETIC_PUSH_URL отчёты идут туда, мимо проверяемого прокси', async () => {
    const { pushes } = installFetch([]);
    const { mod, cleanup } = loadRunner({ SYNTHETIC_PUSH_URL: WG_PUSH });

    await mod.runAll();

    expect(pushes.length).toBeGreaterThan(0);
    expect(pushes.every((p) => p.url === WG_PUSH)).toBe(true);
    cleanup();
  });

  it('прокси лёг — отчёт о падении всё равно доходит', async () => {
    const { pushes } = installFetch(['fail', 'fail', 'fail'], { siteDown: true });
    const { mod, cleanup } = loadRunner({ SYNTHETIC_PUSH_URL: WG_PUSH });

    await mod.runAll();

    expect(byKey(pushes, 'site_reachable')).toEqual([
      expect.objectContaining({ success: false, url: WG_PUSH }),
    ]);
    expect(byKey(pushes, 'refresh_jwt')[0]).toMatchObject({ success: false });
    cleanup();
  });

  it('без SYNTHETIC_PUSH_URL шлёт, как раньше, на BASE', async () => {
    const { pushes } = installFetch([]);
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(pushes.every((p) => p.url === `${BASE}/webhook/monitoring/synthetic/push`)).toBe(true);
    cleanup();
  });
});

describe('synthetic-runner: устойчивость авторизации', () => {
  it('переживает одиночный подвисший refresh и проверяет остальные сценарии', async () => {
    const { pushes, refreshCalls } = installFetch(['fail', 'ok']);
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(refreshCalls()).toBe(2); // первая попытка отвалилась, вторая прошла
    expect(byKey(pushes, 'refresh_jwt')).toEqual([
      expect.objectContaining({ scenario: 'refresh_jwt', success: true }),
    ]);
    // Главное: зависимые сценарии реально выполнились, а не были помечены
    // красными из-за блипа в первой попытке.
    expect(byKey(pushes, 'chat_streaming')[0]).toMatchObject({ success: true });
    expect(byKey(pushes, 'profile_with_jwt')[0]).toMatchObject({ success: true });
    expect(byKey(pushes, 'tokens_balance')[0]).toMatchObject({ success: true });

    cleanup();
  });

  it('шлёт ровно одну строку refresh_jwt за прогон', async () => {
    // Раньше bootstrap пушил refresh_jwt=false, а одноимённый сценарий следом
    // пушил true. DISTINCT ON в getOverview брал позднюю строку, и на дашборде
    // авторизация была зелёной рядом с красными зависимыми сценариями.
    const { pushes } = installFetch(['fail', 'ok']);
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(byKey(pushes, 'refresh_jwt')).toHaveLength(1);
    cleanup();
  });

  it('когда refresh не поднялся за все попытки — красит авторизацию и объясняет каскад', async () => {
    const { pushes, refreshCalls } = installFetch(['fail', 'fail', 'fail']);
    const { mod, cleanup } = loadRunner();

    await mod.runAll();

    expect(refreshCalls()).toBe(3);
    expect(byKey(pushes, 'refresh_jwt')).toEqual([
      expect.objectContaining({ success: false }),
    ]);

    // Зависимые красные — доступ пользователя действительно сломан, но
    // сообщение обязано указывать на refresh_jwt, а не читаться как отказ AI.
    const chat = byKey(pushes, 'chat_streaming')[0];
    expect(chat.success).toBe(false);
    expect(chat.message).toContain('refresh_jwt');

    // Сценарии без JWT от этого не страдают.
    expect(byKey(pushes, 'agents_endpoint')[0]).toMatchObject({ success: true });
    expect(byKey(pushes, 'agent_avatar')[0]).toMatchObject({ success: true });

    cleanup();
  });
});
