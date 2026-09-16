/**
 * Опыт: постучаться в Meet, нажимая и печатая через X11.
 *
 * Последняя невыясненная разница с Attendee, чей бот в ту же встречу проходит:
 * он вводит имя и жмёт кнопки настоящими событиями системы, а не через
 * браузер. Здесь то же самое — и ничего больше, чтобы отличие осталось
 * единственным.
 *
 *     cd ~/spirits_back/infra/meeting-bot
 *     xvfb-run -a --server-args="-screen 0 1280x800x24" node probe-x11.mjs <ссылка>
 */
import { chromium } from 'playwright';
import * as x11 from './src/x11.mjs';

const url = process.argv[2];
if (!url) { console.error('нужен адрес встречи'); process.exit(1); }
if (!(await x11.available())) { console.error('нет xdotool'); process.exit(1); }

const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox', '--disable-setuid-sandbox',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
    '--disable-extensions', '--disable-blink-features=AutomationControlled',
    '--window-position=0,0', '--window-size=1280,800',
  ],
});
const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], locale: 'en-US', viewport: null });
await ctx.addInitScript(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) {}
});
const page = await ctx.newPage();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

/** Экранные координаты середины элемента. */
const centerOf = async (locator) => {
  const box = await locator.boundingBox();
  if (!box) return null;
  const m = await page.evaluate(() => ({
    sx: window.screenX, sy: window.screenY,
    ox: (window.outerWidth - window.innerWidth) / 2,
    oy: window.outerHeight - window.innerHeight,
    dpr: window.devicePixelRatio || 1,
  }));
  return {
    x: (m.sx + m.ox + box.x + box.width / 2) * m.dpr,
    y: (m.sy + m.oy + box.y + box.height / 2) * m.dpr,
  };
};

const name = page.locator('input[type="text"][aria-label="Your name"]').first();
await name.waitFor({ state: 'visible', timeout: 30_000 });
const nameAt = await centerOf(name);
console.log('поле имени на экране:', nameAt);
await x11.humanMove(nameAt.x, nameAt.y);
await x11.click();
await x11.paste('Роман (ассистент)');
console.log('имя введено:', JSON.stringify(await name.inputValue()));

const cam = page.locator('[aria-label*="Turn off camera" i]').first();
if (await cam.count()) {
  const at = await centerOf(cam);
  if (at) { await x11.humanMove(at.x, at.y); await x11.click(); console.log('камера выключена'); }
}

const join = page.locator('button:has-text("Ask to join"), button:has-text("Join now")').first();
await join.waitFor({ state: 'visible', timeout: 20_000 });
const joinAt = await centerOf(join);
await x11.humanMove(joinAt.x, joinAt.y);
await x11.click();
console.log('постучались в', new Date().toISOString().slice(11, 19), '— смотрите панель «Люди»');

for (let i = 0; i < 45; i++) {
  if (await page.locator('button[aria-label="People"], button[aria-label*="People" i]').first().count()) {
    console.log('ВПУСТИЛИ: панель встречи на месте');
    break;
  }
  await page.waitForTimeout(2000);
}
console.log('текст страницы:', (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ').slice(0, 200));
await browser.close();
