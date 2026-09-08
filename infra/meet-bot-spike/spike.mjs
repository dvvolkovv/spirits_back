/**
 * Спайк: проходит ли звук в обе стороны через виртуальные устройства и
 * Chromium под Xvfb.
 *
 * Две разные частоты в двух направлениях — чтобы нельзя было спутать
 * настоящую передачу с закольцовкой:
 *   страница играет 440 Гц  → мы должны услышать его в meet_out.monitor
 *   мы вливаем     880 Гц   → страница должна услышать его на микрофоне
 *
 * Замер не «на слух»: частота считается фильтром Гёрцеля, то есть числом.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RATE = 48_000;
const TONE_TO_PAGE = 880;
const TONE_FROM_PAGE = 440;
const CAPTURE_MS = 3_000;

/** Мощность на конкретной частоте. Гёрцель — DFT в одной точке, без БПФ. */
function goertzel(samples, freq, rate) {
  const k = (2 * Math.cos((2 * Math.PI * freq) / rate));
  let s1 = 0, s2 = 0;
  for (const x of samples) {
    const s0 = x + k * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / samples.length;
}

function rms(samples) {
  let acc = 0;
  for (const v of samples) acc += v * v;
  return Math.sqrt(acc / samples.length);
}

/** Генератор синуса в PCM16 моно — им кормим pacat. */
function tone(freq, ms, rate) {
  const n = Math.floor((rate * ms) / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.round(0.4 * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), i * 2);
  }
  return buf;
}

const log = (...a) => console.log(...a);

const browser = await chromium.launch({
  // Именно headful под Xvfb. Настоящий headless не отдаёт звук в
  // аудиоустройства системы, а нам нужны именно они.
  headless: false,
  // НАСТОЯЩИЙ Google Chrome, а не Chromium от Playwright.
  //
  // Проверено 08.09.2026: Meet отвергает Chromium от Playwright ещё на
  // загрузке страницы — «You can't join this video call» с отсчётом до
  // возврата на домашний экран, до всякого ввода имени. Причина в опознании
  // браузера, а не в кодеках (H.264 и AAC у Playwright есть):
  //
  //   Chromium от Playwright:  brands пусто,                     webdriver true
  //   настоящий Chrome:        Chromium | Not?A_Brand | Google Chrome, webdriver false
  //
  // Meet опознаёт поддерживаемые браузеры через User-Agent Client Hints, и
  // пустой список брендов для него — неопознанный браузер.
  executablePath: process.env.SPIKE_CHROME || '/usr/bin/google-chrome',
  // Playwright по умолчанию добавляет --enable-automation, из-за которого
  // navigator.webdriver === true. Без этого даже настоящий Chrome выглядит
  // управляемым автоматикой.
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-blink-features=AutomationControlled',
    // Разрешение на микрофон без диалога.
    '--use-fake-ui-for-media-stream',
    // НЕ ставим --use-fake-device-for-media-stream: он подменил бы наш
    // виртуальный микрофон встроенным генератором тона.
    '--autoplay-policy=no-user-gesture-required',
    '--window-size=1280,720',
  ],
});

try {
  const page = await browser.newPage();
  await page.goto('file://' + join(HERE, 'selftest.html'));
  await page.waitForFunction('window.__spike && (window.__spike.ready || window.__spike.error)', { timeout: 20_000 });
  const err = await page.evaluate('window.__spike.error || null');
  if (err) throw new Error('страница не смогла открыть микрофон: ' + err);
  log('страница готова: тон 440 Гц играет, микрофон открыт');

  // Даём Chromium подцепить устройства.
  await new Promise((r) => setTimeout(r, 1500));

  // Направление 1: страница → мы. Читаем monitor того синка, куда играет Chromium.
  const rec = spawn('parec', ['--device=meet_out.monitor', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  const chunks = [];
  rec.stdout.on('data', (d) => chunks.push(d));
  rec.stderr.on('data', (d) => process.stderr.write('[parec] ' + d));

  // Направление 2: мы → страница. Пишем 880 Гц в синк, чей monitor стал микрофоном.
  const play = spawn('pacat', ['--device=bot_mic_sink', '--format=s16le', `--rate=${RATE}`, '--channels=1']);
  play.stderr.on('data', (d) => process.stderr.write('[pacat] ' + d));
  play.stdin.write(tone(TONE_TO_PAGE, CAPTURE_MS + 500, RATE));
  play.stdin.end();

  await new Promise((r) => setTimeout(r, CAPTURE_MS));
  const heard = await page.evaluate('({ rms: window.__spike.micRms, hz: window.__spike.micPeakHz, ticks: window.__spike.ticks })');
  rec.kill('SIGINT'); play.kill('SIGINT');
  await new Promise((r) => setTimeout(r, 300));

  // Разбор захваченного.
  const pcm = Buffer.concat(chunks);
  const samples = new Float32Array(pcm.length >> 1);
  for (let i = 0; i < samples.length; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;

  const capRms = rms(samples);
  const at440 = goertzel(samples, TONE_FROM_PAGE, RATE);
  const at880 = goertzel(samples, TONE_TO_PAGE, RATE);

  log('');
  log('=== направление «страница → мы» (звук встречи) ===');
  log(`  захвачено: ${(samples.length / RATE).toFixed(2)} с, rms=${capRms.toFixed(4)}`);
  log(`  мощность на 440 Гц: ${at440.toFixed(5)}   (ожидаем заметную)`);
  log(`  мощность на 880 Гц: ${at880.toFixed(5)}   (ожидаем около нуля — иначе есть закольцовка)`);
  log('');
  log('=== направление «мы → страница» (голос ассистента) ===');
  log(`  страница слышит: rms=${heard.rms.toFixed(4)}, пик=${heard.hz} Гц, замеров=${heard.ticks}`);
  log(`  (ожидаем пик около ${TONE_TO_PAGE} Гц)`);
  log('');

  const okOut = at440 > 0.005 && at440 > at880 * 5;
  const okIn = heard.rms > 0.01 && Math.abs(heard.hz - TONE_TO_PAGE) <= 30;
  log(`ИТОГ: звук встречи → нам: ${okOut ? 'РАБОТАЕТ' : 'НЕ РАБОТАЕТ'}`);
  log(`      наш голос → в встречу: ${okIn ? 'РАБОТАЕТ' : 'НЕ РАБОТАЕТ'}`);
  process.exitCode = okOut && okIn ? 0 : 1;
} finally {
  await browser.close();
}
