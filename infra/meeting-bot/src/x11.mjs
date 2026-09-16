import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Ввод через X11 — настоящими событиями системы, а не через браузер.
 *
 * Google Meet отказывает анонимному боту, если тот управляется браузерным
 * протоколом: стук до хозяина встречи не доходит вовсе (16.09.2026 — опыты
 * подряд на Playwright, на настоящем Chrome и на Selenium дали один результат,
 * а бот Attendee в ту же встречу прошёл). У Attendee режим ввода для Meet по
 * умолчанию `humanized`: он печатает и кликает через XTEST, а траектории мыши
 * берёт из записанных человеческих движений.
 *
 * Здесь то же самое, но проще: события шлём через `xdotool` (он и есть обёртка
 * над XTEST), а траекторию рисуем кривой Безье со случайными изгибами,
 * переменной скоростью и промахом с доводкой в конце.
 *
 * Работает только под своим дисплеем — у нас это Xvfb, и он уже есть.
 *
 * Важно: фокус ввода под Xvfb без оконного менеджера следует за указателем
 * (PointerRoot). Поэтому клавиши шлём ТОЛЬКО после того, как навели мышь на
 * нужное место, — иначе они уйдут в пустоту.
 */

/** Есть ли чем работать. Нет — зовущий сам решит, падать или идти обычным путём. */
export async function available() {
  try {
    await run('xdotool', ['getmouselocation']);
    return true;
  } catch {
    return false;
  }
}

/** Где сейчас указатель. */
export async function pointer() {
  const { stdout } = await run('xdotool', ['getmouselocation', '--shell']);
  const get = (k) => Number(/^\w+=(\d+)$/m.exec(stdout.split('\n').find((l) => l.startsWith(k + '=')) || '')?.[1] ?? 0);
  return { x: get('X'), y: get('Y') };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * Провести указатель к точке по-человечески.
 *
 * Прямая линия с равномерной скоростью — первое, что отличает робота. Поэтому
 * кубическая Безье со случайными контрольными точками в стороне от прямой,
 * плавный разгон и торможение, дрожание в один пиксель и небольшой промах,
 * который тут же исправляется коротким довеском.
 */
export async function humanMove(toX, toY) {
  const from = await pointer();
  const dx = toX - from.x;
  const dy = toY - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 2) return;

  // Контрольные точки сносим перпендикулярно пути — так рука и ведёт.
  const nx = -dy / dist;
  const ny = dx / dist;
  const bow = rnd(0.08, 0.22) * dist * (Math.random() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + dx * 0.3 + nx * bow, y: from.y + dy * 0.3 + ny * bow };
  const c2 = { x: from.x + dx * 0.7 + nx * bow * rnd(0.4, 1.1), y: from.y + dy * 0.7 + ny * bow * rnd(0.4, 1.1) };

  // Промахиваемся мимо цели и доводим: так делает рука, и так не получается у
  // программы, которая ставит указатель сразу в центр.
  const miss = { x: toX + rnd(-6, 6), y: toY + rnd(-6, 6) };

  const steps = Math.min(48, Math.max(14, Math.round(dist / 14)));
  for (let i = 1; i <= steps; i++) {
    // Плавный разгон и торможение вместо равномерного шага.
    const t = i / steps;
    const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const u = 1 - e;
    const x = u * u * u * from.x + 3 * u * u * e * c1.x + 3 * u * e * e * c2.x + e * e * e * miss.x;
    const y = u * u * u * from.y + 3 * u * u * e * c1.y + 3 * u * e * e * c2.y + e * e * e * miss.y;
    await run('xdotool', ['mousemove', '--sync', String(Math.round(x + rnd(-1, 1))), String(Math.round(y + rnd(-1, 1)))]);
    await sleep(rnd(6, 18));
  }

  await sleep(rnd(40, 110));
  await run('xdotool', ['mousemove', '--sync', String(Math.round(toX)), String(Math.round(toY))]);
  await sleep(rnd(60, 140));
}

/** Нажать левой кнопкой там, где стоит указатель. */
export async function click() {
  await run('xdotool', ['click', '1']);
  await sleep(rnd(80, 200));
}

/**
 * Вставить текст из буфера обмена.
 *
 * Не посимвольно: имя ассистента кириллическое, а посимвольный ввод через X11
 * упирается в раскладку — нужного символа в ней может не быть вовсе. Attendee
 * по той же причине для непростых имён вставляет из буфера.
 */
export async function paste(text) {
  await run('bash', ['-c', 'xclip -selection clipboard'], { input: text });
  await sleep(rnd(150, 350));
  await run('xdotool', ['key', '--clearmodifiers', 'ctrl+v']);
  await sleep(rnd(150, 300));
}

/** Небольшое движение на месте: страница видит живой указатель. */
export async function wiggle() {
  const p = await pointer();
  await humanMove(p.x + rnd(-40, 40), p.y + rnd(-30, 30));
}
