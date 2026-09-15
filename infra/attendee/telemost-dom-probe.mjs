/**
 * Разведка разметки Телемоста: участники и чат.
 *
 * Заходит во встречу вторым гостем и печатает КАНДИДАТОВ в селекторы — по
 * тексту, ролям и атрибутам, — а не угаданные заранее классы. Классы у
 * Телемоста собраны сборщиком (`s3s0r`, `k2n1v`) и меняются от выката к
 * выкату; по ним писать адаптер нельзя.
 *
 * Нужен, потому что первая редакция адаптера читала участников наугад и
 * приносила мусор: «Ваше имя на встрече» и склеенное «ГостьРоман · ассистент
 * пользователя». На таком составе не работают ни гейт по имени, ни правила
 * выхода.
 *
 * ЗАПУСК (встреча должна идти):
 *   xvfb-run -a node infra/attendee/telemost-dom-probe.mjs '<ссылка>'
 */
import { chromium } from 'playwright';

const URL_ARG = process.argv[2];
if (!URL_ARG) {
  console.error('нужна ссылка на встречу Телемоста');
  process.exit(1);
}

const PROBE = `(() => {
  const out = { участники: [], чат: [], поляВвода: [], кнопки: [] };

  // Кнопки нижней панели — по ним ищем «Участники» и «Чат».
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    const label = (el.getAttribute('aria-label') || el.innerText || '').trim().slice(0, 40);
    if (!label) continue;
    out.кнопки.push({
      подпись: label,
      тег: el.tagName.toLowerCase(),
      testid: el.getAttribute('data-testid') || null,
    });
  }

  // Всё, что похоже на список участников: ищем по подписям для незрячих и по
  // testid, а не по классам.
  for (const el of document.querySelectorAll('[data-testid], [aria-label], [role="listitem"], [role="list"]')) {
    const id = el.getAttribute('data-testid') || '';
    const aria = el.getAttribute('aria-label') || '';
    if (/particip|user|member|участ/i.test(id + ' ' + aria)) {
      out.участники.push({
        testid: id || null,
        aria: aria || null,
        role: el.getAttribute('role') || null,
        тег: el.tagName.toLowerCase(),
        текст: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      });
    }
    if (/chat|message|чат|сообщ/i.test(id + ' ' + aria)) {
      out.чат.push({
        testid: id || null,
        aria: aria || null,
        тег: el.tagName.toLowerCase(),
        текст: (el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
      });
    }
  }

  // Поля ввода — кандидаты на строку отправки сообщения.
  for (const el of document.querySelectorAll('input, textarea, [contenteditable="true"]')) {
    out.поляВвода.push({
      тег: el.tagName.toLowerCase(),
      тип: el.getAttribute('type') || null,
      placeholder: el.getAttribute('placeholder') || null,
      aria: el.getAttribute('aria-label') || null,
      testid: el.getAttribute('data-testid') || null,
    });
  }

  return out;
})()`;

const run = async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ permissions: ['microphone', 'camera'], locale: 'ru-RU' });
  const page = await ctx.newPage();

  await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(5_000);

  const nameField = page.locator('input[type="text"], input[placeholder*="мя" i]').first();
  if (await nameField.count().catch(() => 0)) await nameField.fill('Разведка разметки').catch(() => {});
  const join = page.locator('button:has-text("Подключиться"), [role="button"]:has-text("Подключиться")').first();
  if (await join.count().catch(() => 0)) await join.click().catch(() => {});
  await page.waitForTimeout(12_000);

  console.log('=== до открытия панелей ===');
  console.log(JSON.stringify(await page.evaluate(PROBE), null, 1));

  for (const name of ['Участники', 'Чат']) {
    const btn = page.locator(`button:has-text("${name}"), [role="button"]:has-text("${name}")`).first();
    if (await btn.count().catch(() => 0)) {
      await btn.click().catch(() => {});
      await page.waitForTimeout(3_000);
      console.log(`=== открыта панель «${name}» ===`);
      console.log(JSON.stringify(await page.evaluate(PROBE), null, 1));
    } else {
      console.log(`панели «${name}» не нашлось`);
    }
  }

  await page.screenshot({ path: '/tmp/telemost-dom.png' }).catch(() => {});
  await browser.close();
};

run().catch((e) => { console.error('разведка упала:', e); process.exit(1); });
