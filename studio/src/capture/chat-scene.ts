import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { answerProblems, isCounterQuestion } from '../answer';
import { toAnswerLayout, type CssRect } from '../boxes';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';
import { probeFile } from '../ffprobe';
import { CAPTURE_SCALE, CAPTURE_VIEWPORT } from '../frame';
import type { CaptureResult, Scene } from '../types';
import type { Session } from './login';

/** Окно съёмки и плотность — из frame.ts: 360×640 при плотности 3 — ровно кадр 1080×1920. */
export const VIEWPORT = CAPTURE_VIEWPORT;
export const SCALE = CAPTURE_SCALE;
/** Ответ готов, если он не меняется столько и в ленте нет признаков набора. */
const STABLE_MS = 3000;
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** Предел высокого кадра: 5000 CSS px × 3 = 15000 px, ниже предела скриншота Chromium. */
const MAX_TALL_CSS = 5000;
const ASSISTANT_MSG = '[data-testid="chat-message"].justify-start';
const USER_MSG = '[data-testid="chat-message"].justify-end';

export interface CaptureOptions {
  minAnswerChars: number;
  probeOnly?: boolean;
}

interface AnswerState {
  count: number;
  text: string;
  streaming: boolean;
  busy: boolean;
}

/**
 * Последний ответ ассистента: текст его блоков (без строки с временем и
 * кнопками) и признаки, что набор ещё идёт — точка-пульс набираемого
 * пузыря (StreamingMessage — без data-testid, поэтому ищем по всей ленте),
 * «печатает» и «работает» в ленте.
 */
function answerState(page: Page): Promise<AnswerState> {
  return page.evaluate((sel) => {
    const msgs = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const last = msgs[msgs.length - 1];
    const blocks = last ? (Array.from(last.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote')) as HTMLElement[]) : [];
    const leaves = blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)));
    const list = document.querySelector('[data-testid="chat-messages-list"]');
    return {
      count: msgs.length,
      text: leaves.map((el) => el.innerText.trim()).filter(Boolean).join('\n'),
      streaming: Boolean(list?.querySelector('.animate-pulse')),
      busy: Boolean(list?.querySelector('.animate-bounce, .animate-spin')),
    };
  }, ASSISTANT_MSG);
}

async function waitAnswer(page: Page, before: number): Promise<string> {
  const started = Date.now();
  let last: string | null = null;
  let since = Date.now();
  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    const s = await answerState(page);
    const arrived = s.count > before;
    const text = arrived ? s.text : null;
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (arrived && !s.streaming && !s.busy && Date.now() - since >= STABLE_MS) {
      // Даже пустой текст возвращаем: «ответ без абзацев» отловит answerProblems,
      // а не пятиминутный таймаут.
      return s.text;
    }
    await page.waitForTimeout(1000);
  }
  throw new StudioError('answer_timeout', 'capture: ответ не закончился за 5 минут', true);
}

/**
 * Ждёт, пока лента успокоится. В пустом «чистом листе» кабинет сам шлёт
 * приветствие (ChatInterface.sendInitialGreeting — настоящий ход ассистента);
 * вопрос, отправленный поверх, ушёл бы в очередь. Готово, когда есть хотя бы
 * одно сообщение ассистента и STABLE_MS нет признаков набора.
 */
async function waitIdle(page: Page): Promise<void> {
  const started = Date.now();
  let lastCount = -1;
  let since = Date.now();
  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    const s = await answerState(page);
    const idle = s.count > 0 && !s.streaming && !s.busy;
    if (!idle || s.count !== lastCount) {
      lastCount = s.count;
      since = Date.now();
    } else if (Date.now() - since >= STABLE_MS) {
      return;
    }
    await page.waitForTimeout(1000);
  }
  throw new StudioError('idle_timeout', 'capture: лента не успокоилась за 5 минут — приветствие ассистента не закончилось', true);
}

/** Отправляет реплику и ждёт её пузырь; возвращает число ответов ассистента до отправки. */
async function send(page: Page, text: string): Promise<number> {
  const before = (await answerState(page)).count;
  await page.locator('[data-testid="chat-input"]').fill(text);
  await page.locator('[data-testid="chat-send-btn"]').click();
  await page.locator(USER_MSG).filter({ hasText: text.slice(0, 30) }).last().waitFor({ timeout: 15_000 });
  return before;
}

/**
 * Докручивает ленту до низа и говорит, виден ли последний пузырь пользователя
 * целиком. Сам кабинет едет вниз, только если до низа ленты меньше 150 px
 * (автопрокрутка ChatInterface), а пузырь длинного вопроса выше — без докрутки
 * он остаётся под полем ввода. Верх ленты на мобильном перекрывает шапка: под
 * неё у ленты верхний отступ, туда пузырь попадать не должен.
 */
async function revealLastUserMessage(page: Page): Promise<boolean> {
  await page.evaluate(() => {
    const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement | null;
    if (list) list.scrollTop = list.scrollHeight;
  });
  await page.waitForTimeout(800);
  return page.evaluate((sel) => {
    const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement | null;
    const msgs = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
    const bubble = msgs[msgs.length - 1];
    if (!list || !bubble) return false;
    const l = list.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const covered = parseFloat(getComputedStyle(list).paddingTop) || 0;
    return b.top >= l.top + covered - 1 && b.bottom <= l.bottom + 1;
  }, USER_MSG);
}

/**
 * Снимает сцену чата на демо-аккаунте: вопрос, ответ целиком высоким
 * кадром, координаты абзацев. probeOnly — только открыть чат и снять probe.png.
 */
export async function captureChat(
  scene: Scene,
  cfg: StudioConfig,
  session: Session,
  outDir: string,
  opts: CaptureOptions,
): Promise<CaptureResult | null> {
  fs.mkdirSync(outDir, { recursive: true });
  const shot = (name: string) => path.join(outDir, name);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: SCALE,
      isMobile: true,
      hasTouch: true,
      locale: 'ru-RU',
      httpCredentials: cfg.basicAuth ?? undefined,
    });
    // Вход без интерфейса: токены в localStorage, как кладёт AuthContext;
    // «чистый лист» — ключ fresh_ts_<id> в sessionStorage (ChatInterface).
    await context.addInitScript(
      (a: { session: Session; assistantId: number; freshTs: string }) => {
        localStorage.setItem('jwt_access_token', a.session.accessToken);
        localStorage.setItem('jwt_refresh_token', a.session.refreshToken);
        localStorage.setItem('authToken', a.session.accessToken);
        localStorage.setItem('userData', JSON.stringify(a.session.userData));
        sessionStorage.setItem(`fresh_ts_${a.assistantId}`, a.freshTs);
      },
      { session, assistantId: scene.assistantId, freshTs: String(Date.now()) },
    );
    const page = await context.newPage();
    await page.goto(`${cfg.cabinetUrl}/chat?assistant=${scene.assistantId}&lang=ru&utm_source=studio`, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('[data-testid="chat-input"]').waitFor({ timeout: 30_000 });
    } catch {
      await page.screenshot({ path: shot('blocked.png') });
      throw new StudioError('blocked', `capture: кабинет не дошёл до чата — см. ${shot('blocked.png')}`, true);
    }
    await waitIdle(page);
    const picked = (await page.locator('[data-testid="assistant-dropdown-btn"]').innerText().catch(() => '')).trim();
    if (!picked.includes(scene.assistantName)) {
      await page.screenshot({ path: shot('wrong-assistant.png') });
      throw new StudioError('wrong_assistant', `capture: открыт не тот ассистент: «${picked}» вместо «${scene.assistantName}»`, false);
    }
    if (opts.probeOnly) {
      await page.screenshot({ path: shot('probe.png') });
      return null;
    }

    let before = await send(page, scene.question);
    if (!(await revealLastUserMessage(page))) {
      await page.screenshot({ path: shot('question-hidden.png') });
      throw new StudioError('question_hidden', `capture: пузырь вопроса не виден целиком — см. ${shot('question-hidden.png')}`, true);
    }
    await page.screenshot({ path: shot('question.png') });
    let answer = await waitAnswer(page, before);
    let turns = 1;
    for (const followup of scene.followups.slice(0, 2)) {
      if (!isCounterQuestion(answer, opts.minAnswerChars)) break;
      before = await send(page, followup);
      answer = await waitAnswer(page, before);
      turns += 1;
    }
    const problems = answerProblems(answer, opts.minAnswerChars);
    if (problems.length) {
      await page.screenshot({ path: shot('rejected.png') });
      throw new StudioError('answer_rejected', `capture: ответ не годится — ${problems.join('; ')}`, true);
    }

    // Высокий кадр: окно раскрывается на всю ленту, и ответ виден целиком без прокрутки.
    const need = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement;
      return Math.ceil(document.documentElement.scrollHeight - list.clientHeight + list.scrollHeight);
    });
    await page.setViewportSize({ width: VIEWPORT.width, height: Math.min(MAX_TALL_CSS, Math.max(VIEWPORT.height, need)) });
    await page.waitForTimeout(800);
    const stillScrolls = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement;
      return list.scrollHeight > list.clientHeight + 2;
    });
    if (stillScrolls) {
      // Запасной путь: лента не растёт вместе с окном — снимаем с неё ограничение высоты.
      await page.addStyleTag({
        content: '[data-testid="chat-messages-list"]{overflow:visible!important;height:auto!important;max-height:none!important;flex:none!important}',
      });
      await page.waitForTimeout(500);
    }
    const rects: CssRect[] = await page.evaluate((sel) => {
      const msgs = Array.from(document.querySelectorAll(sel)) as HTMLElement[];
      const last = msgs[msgs.length - 1];
      const all = Array.from(last.querySelectorAll('p, li, h1, h2, h3, h4, pre, blockquote, img')) as HTMLElement[];
      const leaves = all.filter((el) => !all.some((o) => o !== el && el.contains(o)));
      return leaves.map((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top + window.scrollY, height: r.height, text: el.tagName === 'IMG' ? '[картинка]' : el.innerText };
      });
    }, ASSISTANT_MSG);
    await page.screenshot({ path: shot('answer.png'), fullPage: true });

    const img = await probeFile(shot('answer.png'));
    const { boxes, paragraphs } = toAnswerLayout(rects, SCALE, img.height);
    if (boxes.length === 0) throw new StudioError('no_paragraphs', 'capture: в ответе не нашлось ни одного абзаца', true);
    for (const f of ['question.png', 'answer.png']) {
      if (fs.statSync(shot(f)).size < 20_000) throw new StudioError('empty_frame', `capture: ${f} меньше 20 КБ — похоже на пустой кадр`, true);
    }
    return {
      scene,
      cabinetUrl: cfg.cabinetUrl,
      capturedAt: new Date().toISOString(),
      questionShot: 'question.png',
      answerShot: 'answer.png',
      answerShotWidth: img.width,
      answerShotHeight: img.height,
      answerText: answer,
      turns,
      boxes,
      paragraphs,
    };
  } finally {
    await browser.close();
  }
}
