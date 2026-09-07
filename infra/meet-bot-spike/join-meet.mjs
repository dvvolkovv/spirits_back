/**
 * Этап Б спайка: войти в НАСТОЯЩУЮ встречу Google Meet и проверить звук.
 *
 * Этап А (spike.mjs) уже доказал водопровод на замкнутой петле. Здесь
 * проверяется другое: пускает ли Meet гостя из этого браузера, как выглядит
 * ожидание впуска и доходит ли звук до живых участников.
 *
 * Запуск:
 *   SPIKE_CHROMIUM=$HOME/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome \
 *   xvfb-run -a --server-args="-screen 0 1280x720x24" \
 *   node join-meet.mjs 'https://meet.google.com/abc-defg-hij' 'Роман · ассистент'
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

const browser = await chromium.launch({
  headless: false,
  executablePath: process.env.SPIKE_CHROMIUM || undefined,
  args: [
    '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
  ],
});

try {
  const ctx = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('  [страница]', m.text().slice(0, 160)));

  console.log(`открываю ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForTimeout(4_000);
  await shot(page, '01-открыто');

  // Имя гостя. Селектор специально широкий: у Meet он меняется, и жёсткий
  // placeholder — первое, что отвалится.
  const nameField = page.locator('input[type="text"]').first();
  if (await nameField.count()) {
    await nameField.fill(botName).catch(() => {});
    console.log(`  имя введено: ${botName}`);
    await shot(page, '02-имя');
  } else {
    console.log('  поля имени нет — возможно, Meet требует аккаунт');
  }

  // Кнопка входа. Пробуем все известные формулировки, включая русские.
  const joinNames = [/ask to join/i, /join now/i, /попросить.*войти/i, /присоединиться/i, /войти/i];
  let clicked = false;
  for (const re of joinNames) {
    const b = page.getByRole('button', { name: re }).first();
    if (await b.count().catch(() => 0)) {
      await b.click({ timeout: 5_000 }).catch(() => {});
      console.log(`  нажал кнопку: ${re}`);
      clicked = true;
      break;
    }
  }
  if (!clicked) console.log('  кнопку входа не нашёл — смотри снимок 02');
  await page.waitForTimeout(5_000);
  await shot(page, '03-после-входа');

  console.log('');
  console.log('ЖДУ ВПУСКА. Подтвердите вход в интерфейсе Meet.');
  console.log('Через 60 секунд начну лить тон 880 Гц — вы должны его услышать.');
  await page.waitForTimeout(60_000);
  await shot(page, '04-во-встрече');

  const play = spawn('pacat', ['--device=bot_mic_sink', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  play.stdin.write(tone(880, 15_000, RATE));
  play.stdin.end();
  console.log('лью тон 880 Гц пятнадцать секунд — слышно ли его в встрече?');

  // Одновременно слушаем встречу: если участники говорят, тут будет не тишина.
  const rec = spawn('parec', ['--device=meet_out.monitor', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  const chunks = [];
  rec.stdout.on('data', (d) => chunks.push(d));
  await page.waitForTimeout(15_000);
  rec.kill('SIGINT'); play.kill('SIGINT');

  const pcm = Buffer.concat(chunks);
  let acc = 0;
  for (let i = 0; i < pcm.length >> 1; i++) { const v = pcm.readInt16LE(i * 2) / 32768; acc += v * v; }
  const level = Math.sqrt(acc / Math.max(1, pcm.length >> 1));
  console.log('');
  console.log(`из встречи пришло ${(pcm.length / 2 / RATE).toFixed(1)} с звука, rms=${level.toFixed(4)}`);
  console.log(level > 0.001 ? 'звук встречи ДОХОДИТ до нас' : 'из встречи тишина — говорите в неё и повторите');
  await shot(page, '05-финал');
} finally {
  await browser.close();
}
