import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser } from 'playwright';
import { revealLastUserMessage } from './chat-scene';

/**
 * Лента кабинета на мобильном — размеры замерены на стенде 27.10.2026: лента
 * 37–465 px, сверху под шапкой отступ 80 px, снизу 16 px; под последним вопросом
 * ещё «Думает». Вопрос в 358 знаков — пузырь 263 px.
 */
const page = (bubblePx: number) => `<!doctype html><html><body style="margin:0">
<header style="position:fixed;top:0;left:0;right:0;height:117px;background:#fff;z-index:2"></header>
<div data-testid="chat-messages-list" style="position:absolute;top:37px;bottom:175px;left:0;right:0;overflow-y:auto;padding-top:80px;padding-bottom:16px;box-sizing:border-box">
  <div data-testid="chat-message" class="justify-start" style="height:600px;margin:8px">прошлый ответ</div>
  <div data-testid="chat-message" class="justify-end" style="height:${bubblePx}px;margin:8px">вопрос</div>
  <div style="height:90px;margin:8px">Думает · 0 с</div>
</div></body></html>`;

async function withPage<T>(html: string, fn: (p: import('playwright').Page) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await p.setContent(html);
    return await fn(p);
  } finally {
    await browser.close();
  }
}

const listTop = (p: import('playwright').Page) =>
  p.evaluate(() => (document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement).scrollTop);

test('длинный вопрос: внизу ленты верх пузыря под шапкой — лента поднимается до пузыря, и он виден целиком', { timeout: 60_000 }, async () => {
  await withPage(page(263), async (p) => {
    assert.equal(await revealLastUserMessage(p), true);
    const top = await p.evaluate(() => (document.querySelector('[data-testid="chat-message"].justify-end') as HTMLElement).getBoundingClientRect().top);
    assert.ok(top >= 117 - 1 && top <= 117 + 12, `верх пузыря ${top}`);
  });
});

test('короткий вопрос — лента остаётся внизу', { timeout: 60_000 }, async () => {
  await withPage(page(80), async (p) => {
    assert.equal(await revealLastUserMessage(p), true);
    const max = await p.evaluate(() => { const l = document.querySelector('[data-testid="chat-messages-list"]') as HTMLElement; return l.scrollHeight - l.clientHeight; });
    assert.equal(await listTop(p), max);
  });
});

test('пузырь выше видимой части ленты — честное «не виден», а не подрезанный кадр', { timeout: 60_000 }, async () => {
  await withPage(page(400), async (p) => {
    assert.equal(await revealLastUserMessage(p), false);
  });
});
