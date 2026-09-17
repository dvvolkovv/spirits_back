/**
 * Разведчик разметки.
 *
 * Открывает страницу встречи ровно теми же настройками браузера, что и бот, и
 * рассказывает, что там видно: заголовок, текст, поля ввода, кнопки с их
 * подписями — и кладёт снимок экрана рядом.
 *
 * Нужен потому, что вслепую зацепки не пишутся: разметка площадок обфусцирована
 * и меняется, а единственный честный источник — живая страница. Телемост так
 * прошёл три захода, Meet — свой первый.
 *
 * Запуск на стенде:
 *
 *     cd ~/spirits_back/infra/meeting-bot
 *     xvfb-run -a node probe.mjs https://meet.google.com/xxx-yyyy-zzz meet
 *
 * Второй параметр — площадка: от неё зависит локаль браузера (у Meet английская).
 */
import { chromium } from 'playwright';
import { cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const url = process.argv[2];
const platform = process.argv[3] || 'telemost';

/**
 * Профиль с выполненным входом — тот же, на котором работает бот.
 *
 * Под учётной записью площадка рисует ДРУГУЮ прихожую: имени не спрашивает,
 * кнопки называются иначе. Разведывать надо ровно то, что увидит бот.
 */
const profile = process.env.PROBE_PROFILE_DIR || '';
if (!url) {
  console.error('нужен адрес встречи');
  process.exit(1);
}

const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

// Не представляться автоматикой.
//
// Google Meet отказывает роботам ещё до экрана входа — «You can't join this
// video call», без поля имени (проверено 16.09.2026). Playwright по умолчанию
// объявляет себя: флаг `--enable-automation` и `navigator.webdriver`. У
// Attendee ровно поэтому в списке стоит `--disable-blink-features=
// AutomationControlled`.
const launch = {
  headless: false,
  ...(platform === 'meet' ? { channel: 'chrome' } : {}),
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox',
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-dev-shm-usage',
    '--disable-features=IsolateOrigins,site-per-process',
    '--disable-blink-features=AutomationControlled',
    '--disable-extensions',
  ],
};
const context = {
  permissions: ['microphone', 'camera'],
  locale: platform === 'meet' ? 'en-US' : 'ru-RU',
};

let browser = null;
let copy = '';
let ctx;
if (profile) {
  // На копии, как и бот: Chrome держит на профиле замок.
  copy = join(tmpdir(), 'probe-profile-' + Date.now());
  await cp(profile, copy, { recursive: true });
  ctx = await chromium.launchPersistentContext(copy, { ...launch, ...context, viewport: null });
} else {
  browser = await chromium.launch(launch);
  ctx = await browser.newContext(context);
}
await ctx.addInitScript(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch (e) { /* уже переопределено */ }
});
const page = ctx.pages()[0] || (await ctx.newPage());
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  консоль:', m.text().slice(0, 160));
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(Number(process.argv[4] || 15_000));

console.log('адрес:   ', page.url());
console.log('заголовок:', await page.title());
console.log('текст страницы:', clean(await page.evaluate(() => document.body.innerText)).slice(0, 600));

const dump = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const take = (sel, f) => [...document.querySelectorAll(sel)].slice(0, 25).map(f).filter(Boolean);
  return {
    inputs: take('input, textarea', (e) => `${e.tagName.toLowerCase()} type=${e.type || '-'} aria="${e.getAttribute('aria-label') || ''}" placeholder="${e.placeholder || ''}"`),
    buttons: take('button, [role="button"]', (e) => {
      const label = e.getAttribute('aria-label') || '';
      const text = clean(e.innerText).slice(0, 40);
      // Тег и роль важны не меньше подписи: зацепка `button:...` не возьмёт
      // `div[role="button"]`, и по логу это неотличимо от «кнопки нет».
      const tag = e.tagName.toLowerCase() + (e.getAttribute('role') ? `[role=${e.getAttribute('role')}]` : '');
      return label || text ? `${tag} aria="${label}" текст="${text}"` : null;
    }),
    frames: [...document.querySelectorAll('iframe')].map((f) => f.src).slice(0, 10),
  };
});

console.log('\nполя ввода:');
for (const i of dump.inputs) console.log('  ', i);
console.log('\nкнопки:');
for (const b of dump.buttons) console.log('  ', b);
if (dump.frames.length) {
  console.log('\nкадры:');
  for (const f of dump.frames) console.log('  ', f);
}

// Проверка НАШИХ зацепок на живой странице.
//
// Разметку посмотреть мало: зацепка может не взять элемент, который на экране
// прекрасно виден, и по логу бота это неотличимо от «элемента нет». Поэтому
// спрашиваем прямо — сколько ловит каждая.
if (platform === 'meet') {
  const { MEET_JOIN } = await import('./src/payload/meet.mjs');
  console.log('');
  console.log('наши зацепки:');
  for (const [name, sel] of Object.entries(MEET_JOIN)) {
    let n = -1;
    try { n = await page.locator(sel).count(); } catch (e) { console.log(`   ${name}: ОШИБКА ${e.message.slice(0, 80)}`); continue; }
    console.log(`   ${name}: ${n}`);
  }
}

const shot = `/tmp/probe-${platform}.png`;
await page.screenshot({ path: shot });
console.log('\nснимок:', shot);

if (browser) await browser.close();
else await ctx.close();
if (copy) await rm(copy, { recursive: true, force: true });
