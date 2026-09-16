/**
 * Опыт: постучаться в Meet через Selenium, а не через Playwright.
 *
 * Meet пускает анонимного человека и молча режет наш браузер: стук до хозяина
 * не доходит вовсе (проверено 16.09.2026 — в инкогнито запрос появляется, у
 * бота нет). Мы уже сняли очевидные признаки автоматики: убрали
 * `--enable-automation`, спрятали `navigator.webdriver`, перешли на настоящий
 * Chrome, набираем имя посимвольно. Не помогло.
 *
 * Осталось единственное известное различие с Attendee, у которого Meet
 * работает: он водит браузер через Selenium, а Playwright держит постоянное
 * отладочное соединение с включённым доменом `Runtime` — признак, который
 * умеют читать.
 *
 * Скрипт делает ровно то же, что бот, и ничего больше: открывает встречу,
 * вписывает имя, жмёт «Ask to join» и ждёт. Смотреть надо не в его вывод, а в
 * панель «Люди» у хозяина встречи.
 *
 * Запуск на стенде:
 *
 *     cd ~/spirits_back/infra/meeting-bot
 *     xvfb-run -a node probe-selenium.mjs https://meet.google.com/xxx-yyyy-zzz
 */
import { Builder, By, until } from 'selenium-webdriver';
import chrome from 'selenium-webdriver/chrome.js';

const url = process.argv[2];
if (!url) {
  console.error('нужен адрес встречи');
  process.exit(1);
}

const options = new chrome.Options();
// Те же флаги, что у Attendee, — ни больше ни меньше: смысл опыта в том, чтобы
// отличие осталось единственным.
for (const arg of [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-application-cache',
  '--disable-blink-features=AutomationControlled',
  '--lang=en-US',
  '--window-size=1280,800',
]) options.addArguments(arg);

const driver = await new Builder().forBrowser('chrome').setChromeOptions(options).build();

try {
  await driver.get(url);
  console.log('страница открыта, ищем поле имени');

  const name = await driver.wait(
    until.elementLocated(By.css('input[type="text"][aria-label="Your name"]')),
    30_000,
  );
  await name.click();
  // Посимвольно: подстановка не оставляет следов ввода.
  for (const ch of 'Роман (ассистент)') {
    await name.sendKeys(ch);
    await driver.sleep(60 + Math.random() * 60);
  }
  console.log('имя введено');

  const camera = await driver.findElements(By.css('[aria-label*="Turn off camera" i]'));
  if (camera[0]) { await camera[0].click(); console.log('камера выключена'); }

  const join = await driver.wait(
    until.elementLocated(By.xpath('//button[.//span[text()="Ask to join" or text()="Join now"]]')),
    20_000,
  );
  await join.click();
  console.log('постучались в', new Date().toISOString().slice(11, 19), '— смотрите панель «Люди»');

  // Ждём впуска: признак — панель встречи.
  for (let i = 0; i < 60; i++) {
    const people = await driver.findElements(By.css('button[aria-label="People"], button[aria-label*="People" i]'));
    if (people.length) { console.log('ВПУСТИЛИ: панель встречи на месте'); break; }
    await driver.sleep(2000);
  }
  const body = await driver.findElement(By.tagName('body')).getText();
  console.log('текст страницы:', body.replace(/\s+/g, ' ').slice(0, 300));
} finally {
  await driver.quit();
}
