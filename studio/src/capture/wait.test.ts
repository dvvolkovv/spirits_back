import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium, type Browser, type Page } from 'playwright';
import { waitAnswer, waitIdle } from './chat-scene';

/**
 * Лента кабинета: приветствие ассистента и, пока где-то идёт ход, признак
 * «работает» — точки (.animate-bounce) или спиннер (.animate-spin).
 */
const feed = (working: '' | 'animate-bounce' | 'animate-spin') => `<!doctype html><html><body>
<div data-testid="chat-messages-list">
  <div data-testid="chat-message" class="justify-start"><p>Здравствуйте! С чем пришли?</p></div>
  ${working ? `<div id="working" class="${working}">Ассистент работает</div>` : ''}
</div></body></html>`;

async function withPage<T>(html: string, fn: (p: Page) => Promise<T>): Promise<T> {
  const browser: Browser = await chromium.launch({ headless: true });
  try {
    const p = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await p.setContent(html);
    return await fn(p);
  } finally {
    await browser.close();
  }
}

/** Не дольше ms: ожидание, не знающее срока, — провал теста, а не пятиминутный прогон. */
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`не уложилось в ${ms} мс`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

test('waitAnswer: долгий ответ бросает к сроку съёмки, а не по своим пяти минутам', { timeout: 60_000 }, async () => {
  await withPage(feed('animate-spin'), async (p) => {
    await assert.rejects(within(waitAnswer(p, 1, Date.now() + 3000), 15_000), { code: 'answer_timeout', retryable: true });
  });
});

test('waitAnswer: дописанный ответ отдаёт до срока', { timeout: 60_000 }, async () => {
  await withPage(feed(''), async (p) => {
    await p.evaluate(() => {
      setTimeout(() => {
        const m = document.createElement('div');
        m.dataset.testid = 'chat-message';
        m.className = 'justify-start';
        m.innerHTML = '<p>Короткий ответ по делу.</p>';
        document.querySelector('[data-testid="chat-messages-list"]')!.append(m);
      }, 500);
    });
    assert.equal(await within(waitAnswer(p, 1, Date.now() + 30_000), 20_000), 'Короткий ответ по делу.');
  });
});

/**
 * Повтор съёмки открывает чистый лист, пока прежний ход с тем же вопросом ещё
 * идёт: кабинет показывает его признак «работает» (опрос active-turn). Бэкенд
 * 12 с после конца хода считает тот же вопрос дублем (DEDUP_COOLDOWN_MS,
 * src/chat/chat.service.ts) и вместо ответа шлёт заглушку «Этот запрос я только
 * что обработал…». 14.11.2026 вопрос уходил через 3 с после конца прежнего
 * хода — заглушка сдвигала пузырь вопроса под шапку, и ролик падал
 * question_hidden раз за разом.
 */
test('waitIdle: после прежнего хода молчит дольше кулдауна дублей бэкенда', { timeout: 60_000 }, async () => {
  await withPage(feed('animate-bounce'), async (p) => {
    await p.evaluate(() => {
      setTimeout(() => {
        document.getElementById('working')!.remove();
        document.body.dataset.clearedAt = String(Date.now());
      }, 1000);
    });
    await within(waitIdle(p, Date.now() + 50_000), 40_000);
    const clearedAt = Number(await p.evaluate(() => document.body.dataset.clearedAt));
    assert.ok(Date.now() - clearedAt > 12_000, `вопрос ушёл бы через ${Date.now() - clearedAt} мс после конца прежнего хода`);
  });
});

test('waitIdle: лента не успокоилась — idle_timeout к сроку съёмки', { timeout: 60_000 }, async () => {
  await withPage(feed('animate-bounce'), async (p) => {
    await assert.rejects(within(waitIdle(p, Date.now() + 3000), 15_000), { code: 'idle_timeout', retryable: true });
  });
});
