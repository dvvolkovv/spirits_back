import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { answerProblems, isCounterQuestion } from '../answer';
import { toImageBoxes, type CssRect } from '../boxes';
import type { StudioConfig } from '../config';
import { probeFile } from '../ffprobe';
import type { CaptureResult, Scene } from '../types';
import type { Session } from './login';

/** 360×640 при плотности 3 — ровно кадр 1080×1920. */
export const VIEWPORT = { width: 360, height: 640 };
export const SCALE = 3;
/** Ответ готов, если он не меняется столько и в ленте нет признаков набора. */
const STABLE_MS = 3000;
const ANSWER_TIMEOUT_MS = 5 * 60_000;
/** Предел высокого кадра: 5000 CSS px × 3 = 15000 px, ниже предела скриншота Chromium. */
const MAX_TALL_CSS = 5000;
const ASSISTANT_MSG = '[data-testid="chat-message"].justify-start';
const USER_MSG = '[data-testid="chat-message"].justify-end';

export interface CaptureOptions {
  minAnswerChars: number;
  assistantsCount: number;
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
 * кнопками) и признаки, что набор ещё идёт — точка-пульс в пузыре
 * (ChatInterface, message.isStreaming), «печатает» и «работает» в ленте.
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
      streaming: Boolean(last?.querySelector('.animate-pulse')),
      busy: Boolean(list?.querySelector('.animate-bounce, .animate-spin')),
    };
  }, ASSISTANT_MSG);
}

async function waitAnswer(page: Page, before: number): Promise<string> {
  const started = Date.now();
  let last = '';
  let since = Date.now();
  while (Date.now() - started < ANSWER_TIMEOUT_MS) {
    const s = await answerState(page);
    const text = s.count > before ? s.text : '';
    if (text !== last) {
      last = text;
      since = Date.now();
    } else if (text && !s.streaming && !s.busy && Date.now() - since >= STABLE_MS) {
      return text;
    }
    await page.waitForTimeout(1000);
  }
  throw new Error('capture: ответ не закончился за 5 минут');
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
      throw new Error(`capture: кабинет не дошёл до чата — см. ${shot('blocked.png')}`);
    }
    await page.waitForTimeout(1500);
    const picked = (await page.locator('[data-testid="assistant-dropdown-btn"]').innerText().catch(() => '')).trim();
    if (!picked.includes(scene.assistantName)) {
      await page.screenshot({ path: shot('wrong-assistant.png') });
      throw new Error(`capture: открыт не тот ассистент: «${picked}» вместо «${scene.assistantName}»`);
    }
    if (opts.probeOnly) {
      await page.screenshot({ path: shot('probe.png') });
      return null;
    }

    let before = await send(page, scene.question);
    await page.waitForTimeout(800);
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
      throw new Error(`capture: ответ не годится — ${problems.join('; ')}`);
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
    const boxes = toImageBoxes(rects, SCALE, img.height);
    if (boxes.length === 0) throw new Error('capture: в ответе не нашлось ни одного абзаца');
    for (const f of ['question.png', 'answer.png']) {
      if (fs.statSync(shot(f)).size < 20_000) throw new Error(`capture: ${f} меньше 20 КБ — похоже на пустой кадр`);
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
      assistantsCount: opts.assistantsCount,
    };
  } finally {
    await browser.close();
  }
}
