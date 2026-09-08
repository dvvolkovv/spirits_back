/**
 * Этап Б спайка: войти в НАСТОЯЩУЮ встречу Google Meet и проверить звук.
 *
 * Этап А (spike.mjs) доказал водопровод на замкнутой петле. Здесь проверяется
 * другое: пускает ли Meet гостя из этого браузера, как выглядит ожидание
 * впуска и доходит ли звук до живых участников.
 *
 * Запуск:
 *   ./setup-audio.sh
 *   xvfb-run -a --server-args="-screen 0 1280x720x24" \
 *     node join-meet.mjs 'https://meet.google.com/abc-defg-hij' 'Роман · ассистент'
 *
 * Скриншоты падают в ./shots/ — по ним видно, на каком шаге всё встало.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const url = process.argv[2];
const botName = process.argv[3] || 'Ассистент Linkeon';
if (!url) {
  console.error('нужна ссылка: node join-meet.mjs <url встречи> [имя бота]');
  process.exit(2);
}
mkdirSync('shots', { recursive: true });

const RATE = 48_000;

/** Тексты, которыми Meet отказывает. Ловим до того, как отсчёт уведёт страницу. */
const REJECTIONS = [
  "can't join this video call",
  'не удаётся присоединиться',
  'не можете присоединиться',
  'Check your meeting code',
  'Проверьте код',
  'Return to home screen',
];

const shot = async (page, name) => {
  await page.screenshot({ path: `shots/${name}.png` }).catch(() => {});
  console.log(`  снимок: shots/${name}.png`);
};

function tone(freq, ms, rate) {
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(0.35 * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  }
  return buf;
}

/**
 * Постоянный профиль браузера.
 *
 * Нужен для входа в аккаунт Google: автоматизировать сам вход бессмысленно —
 * Google его активно блокирует («этот браузер небезопасен»). Рабочий путь —
 * войти ОДИН раз руками в этом профиле и потом переиспользовать его.
 */
const userDataDir = process.env.SPIKE_USER_DATA_DIR || '';

const launchOpts = {
  headless: false,
  // НАСТОЯЩИЙ Google Chrome, а не Chromium от Playwright.
  //
  // Проверено 08.09.2026: Meet отвергает Chromium от Playwright ещё на
  // загрузке — «You can't join this video call», до всякого ввода имени.
  // Причина в опознании браузера, а не в кодеках:
  //
  //   Chromium от Playwright:  brands пусто,                          webdriver true
  //   настоящий Chrome:        Chromium | Not?A_Brand | Google Chrome, webdriver false
  //
  // Meet опознаёт браузеры через User-Agent Client Hints, и пустой список
  // брендов для него — неопознанный браузер.
  executablePath: process.env.SPIKE_CHROME || '/usr/bin/google-chrome',
  // Playwright по умолчанию добавляет --enable-automation, из-за которого
  // navigator.webdriver === true. Без этого даже настоящий Chrome выглядит
  // управляемым автоматикой.
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
  ],
};

const browser = userDataDir ? null : await chromium.launch(launchOpts);

try {
  const ctx = userDataDir
    ? await chromium.launchPersistentContext(userDataDir, {
        ...launchOpts,
        permissions: ['microphone'],
        viewport: { width: 1280, height: 720 },
      })
    : await browser.newContext({
        permissions: ['microphone'],
        viewport: { width: 1280, height: 720 },
      });
  if (userDataDir) console.log(`профиль: ${userDataDir}`);
  const page = ctx.pages()[0] || (await ctx.newPage());
  page.on('console', (m) => console.log('  [страница]', m.text().slice(0, 160)));

  console.log(`открываю ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Снимок СРАЗУ, до всяких ожиданий: экран отказа держится секунды, а потом
  // отсчёт уводит на домашнюю страницу — и по позднему снимку уже не понять,
  // что именно случилось. Ровно так и потерялась причина в прогоне 08.09.2026.
  await shot(page, '01-сразу-после-загрузки');

  const body = (await page.evaluate('document.body?.innerText || ""')).slice(0, 4000);
  const hit = REJECTIONS.find((t) => body.toLowerCase().includes(t.toLowerCase()));
  if (hit) {
    console.log('');
    console.log(`ОТКАЗ: Meet не пустил, на странице «${hit}»`);
    console.log('');
    console.log('Первые строки страницы:');
    console.log(body.split('\n').filter(Boolean).slice(0, 8).map((l) => '  ' + l).join('\n'));
    console.log('');
    console.log('Что проверить в первую очередь:');
    console.log('  1. Встреча действительно идёт и код верный (Meet отказывает и на завершённой).');
    console.log('  2. Запущен ли настоящий Chrome:', process.env.SPIKE_CHROME || '/usr/bin/google-chrome');
    console.log('  3. Не требует ли встреча входа в аккаунт Google (тогда нужен свой аккаунт для бота).');
    process.exitCode = 1;
    await shot(page, '02-отказ');
    throw new Error('вход отклонён на загрузке');
  }

  await page.waitForTimeout(4_000);
  await shot(page, '02-предвстреча');

  // Имя гостя. Селектор широкий: у Meet он меняется, и жёсткий placeholder —
  // первое, что отвалится при очередном обновлении вёрстки.
  const nameField = page.locator('input[type="text"]').first();
  if (await nameField.count().catch(() => 0)) {
    // Настоящими нажатиями, а не fill(): поле управляется фреймворком, и
    // подстановка значения без событий клавиатуры оставляет кнопку входа
    // неактивной. Проверяем результат, а не верим вызову.
    await nameField.click().catch(() => {});
    await nameField.pressSequentially(botName, { delay: 30 }).catch(() => {});
    const got = await nameField.inputValue().catch(() => '');
    console.log(got === botName ? `  имя введено: ${got}` : `  ИМЯ НЕ ДОЕХАЛО, в поле «${got}»`);
  } else {
    console.log('  поля имени нет — либо встреча требует аккаунт, либо вёрстка изменилась');
  }

  // «Ask to join» первым: это гостевой путь. «Join now» показывают, когда
  // вход разрешён напрямую, и он же бывает неактивен, пока не введено имя.
  const joinNames = [/ask to join/i, /попросить.*войти/i, /join now/i, /присоединиться/i, /^войти$/i];
  let clicked = false;
  for (const re of joinNames) {
    const b = page.getByRole('button', { name: re }).first();
    if (!(await b.count().catch(() => 0))) continue;
    const enabled = await b.isEnabled().catch(() => false);
    console.log(`  кнопка ${re}: ${enabled ? 'активна' : 'НЕАКТИВНА'}`);
    if (!enabled) continue;
    try {
      await b.click({ timeout: 5_000 });
      console.log(`  нажал: ${re}`);
      clicked = true;
      break;
    } catch (e) {
      // Ошибку клика НЕ глотаем: раньше она пряталась в catch, и по логу
      // нельзя было понять, нажалась кнопка или Playwright отвалился.
      console.log(`  клик по ${re} не удался: ${String(e).split(String.fromCharCode(10))[0]}`);
    }
  }
  // Снимок сразу после клика, до ожиданий: переходное состояние живёт секунды.
  await shot(page, '03-сразу-после-клика');
  if (!clicked) {
    console.log('  кнопку входа не нашёл. Кнопки на странице:');
    const names = await page.evaluate(
      '[...document.querySelectorAll("button")].map(b => (b.innerText || b.ariaLabel || "").trim()).filter(Boolean).slice(0, 20)',
    ).catch(() => []);
    for (const n of names) console.log('    •', n);
  }
  await page.waitForTimeout(5_000);
  await shot(page, '04-через-5с');

  console.log('');
  console.log('ЖДУ ВПУСКА 60 секунд. Подтвердите вход в интерфейсе Meet.');
  await page.waitForTimeout(60_000);
  await shot(page, '05-во-встрече');

  const play = spawn('pacat', ['--device=bot_mic_sink', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  play.stdin.write(tone(880, 15_000, RATE));
  play.stdin.end();
  console.log('лью тон 880 Гц пятнадцать секунд — слышно ли его в встрече?');

  const rec = spawn('parec', ['--device=meet_out.monitor', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  const chunks = [];
  rec.stdout.on('data', (d) => chunks.push(d));
  await page.waitForTimeout(15_000);
  rec.kill('SIGINT');
  play.kill('SIGINT');

  const pcm = Buffer.concat(chunks);
  let acc = 0;
  const n = pcm.length >> 1;
  for (let i = 0; i < n; i++) { const v = pcm.readInt16LE(i * 2) / 32768; acc += v * v; }
  const level = Math.sqrt(acc / Math.max(1, n));
  console.log('');
  console.log(`из встречи пришло ${(n / RATE).toFixed(1)} с звука, rms=${level.toFixed(4)}`);
  console.log(level > 0.001 ? 'звук встречи ДОХОДИТ до нас' : 'из встречи тишина — говорите в неё и повторите');
  await shot(page, '06-финал');
} finally {
  await (userDataDir ? ctx?.close() : browser.close());
}
