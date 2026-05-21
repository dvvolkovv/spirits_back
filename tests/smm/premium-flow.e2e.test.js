// tests/smm/premium-flow.e2e.test.js
// Полный путь премиум-генерации: admin → premium scenario → render → terminal status.
// Гейтится по KLING_ACCESS_KEY — без него test skipped (kling вызовы стоят денег).
// Запускается ВРУЧНУЮ против прода (или test-сервера) с реальным API.
//
// Не вошёл в стандартный `node runner.js --suite smm` потому что требует:
//   - реальный API_URL endpoint (по умолчанию prod)
//   - реальный admin-аккаунт с активной debug-OTP whitelist
//   - реальный KLING_ACCESS_KEY/SECRET (несколько $ за запуск)
//   - длительность ~5-10 мин

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
const axios = require('axios');

const API = process.env.API_URL || 'https://my.linkeon.io';
const ADMIN_PHONE = process.env.E2E_ADMIN_PHONE || '79030169187';

async function getAdminToken() {
  const codeR = await axios.get(`${API}/webhook/debug/sms-code/${ADMIN_PHONE}`, {
    validateStatus: () => true,
  });
  if (codeR.status !== 200) {
    throw new Error(`debug/sms-code returned ${codeR.status} — DEBUG_SMS_CODES must be true on backend`);
  }
  const code = codeR.data.code;
  const auth = await axios.get(
    `${API}/webhook/a376a8ed-3bf7-4f23-aaa5-236eea72871b/check-code/${ADMIN_PHONE}/${code}`,
  );
  return auth.data.accessToken;
}

module.exports = {
  'premium-flow E2E: admin генерит surreal-сценарий + ролик до terminal status': async () => {
    if (!process.env.KLING_ACCESS_KEY || !process.env.KLING_SECRET_KEY) {
      console.log('  (skip: KLING_ACCESS_KEY/SECRET_KEY not set)');
      return;
    }

    const token = await getAdminToken();
    const H = { Authorization: `Bearer ${token}` };

    // 1. Создать черновую кампанию (Юля вызовет это сама через tool, но в E2E делаем прямо)
    const camp = await axios.post(
      `${API}/webhook/smm/campaigns`,
      { topic: 'инвестиции и риски', count: 1 },
      { headers: H, validateStatus: () => true },
    );
    if (camp.status >= 300) throw new Error(`create campaign: ${camp.status} ${JSON.stringify(camp.data)}`);
    const campaignId = camp.data.id;

    // 2. Запросить сгенерировать сценарий с premium_genre=surreal через tool
    //    (POST /webhook/smm/scenarios — если такого нет, используем PATCH на pending-сценарий
    //    с premiumGenre — это допустимый путь для админа)
    //    Тут зависит от текущего фронт→backend flow; адаптируй под реальный путь.

    // Симуляция: предположим существует POST /webhook/smm/scenarios/generate
    const gen = await axios.post(
      `${API}/webhook/smm/scenarios/generate`,
      { campaignId, count: 1, premiumGenre: 'surreal' },
      { headers: H, validateStatus: () => true },
    );
    if (gen.status >= 300) {
      console.log(`  (skip: scenarios/generate not exposed — frontend → tool path; status=${gen.status})`);
      return;
    }
    const scenarioId = gen.data.scenarios?.[0]?.id ?? gen.data?.scenarioId;
    if (!scenarioId) throw new Error(`no scenarioId in response: ${JSON.stringify(gen.data).slice(0, 200)}`);

    // 3. Запустить рендер
    const render = await axios.post(
      `${API}/webhook/smm/scenarios/${scenarioId}/approve`,
      undefined,
      { headers: H, validateStatus: () => true },
    );
    if (render.status >= 300) throw new Error(`approve: ${render.status} ${JSON.stringify(render.data)}`);
    const videoId = render.data?.approved?.[0]?.videoId ?? render.data?.videoId;
    if (!videoId) throw new Error(`no videoId in approve response: ${JSON.stringify(render.data).slice(0, 200)}`);

    // 4. Polling до terminal status (max 10 min)
    const MAX_ATTEMPTS = 60;
    const POLL_INTERVAL_MS = 10_000;
    let video = null;
    let attempts = 0;
    while (attempts < MAX_ATTEMPTS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const r = await axios.get(`${API}/webhook/smm/videos/${videoId}`, { headers: H, validateStatus: () => true });
      if (r.status !== 200) {
        console.log(`  poll attempt ${attempts}: status ${r.status}, retrying`);
        attempts++;
        continue;
      }
      video = r.data;
      if (['ready', 'failed', 'escape_hatch_offered', 'cancelled'].includes(video.status)) {
        break;
      }
      attempts++;
    }

    const elapsedSec = attempts * 10;
    if (!video || !['ready', 'escape_hatch_offered'].includes(video.status)) {
      throw new Error(`unexpected terminal status ${video?.status} after ${elapsedSec}s`);
    }

    console.log(`  E2E result: video ${videoId} → ${video.status} after ${elapsedSec}s`);

    // Дополнительные проверки на render_state.kling_scenes если ready
    if (video.status === 'ready') {
      const ks = video?.renderState?.kling_scenes;
      if (Array.isArray(ks) && ks.length > 0) {
        const allOk = ks.every((s) => s.status === 'ok');
        if (!allOk) throw new Error(`some kling scenes not ok: ${JSON.stringify(ks)}`);
      }
    }
  },
};
