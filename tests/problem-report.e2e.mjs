/**
 * Живая проверка «сообщить в поддержку» через ассистента релея (Кира, id 22).
 * Спека: docs/superpowers/specs/2026-10-24-assistant-problem-reports-design.md.
 *
 * Вручную, на проде, тестовым аккаунтом (не админом): один ход с просьбой
 * сообщить о выдуманной поломке. Скрипт проверяет, что ход дошёл и ответ
 * говорит о передаче команде. Дошло ли до группы — по логу прода: строка
 * «problem-report: передано в фанаут TELEGRAM_CHAT_ID (assistant_report)» и
 * перед ней ни одной «not delivered» для чата группы.
 *
 *   BASE_URL=https://my.linkeon.io TEST_PHONE=… DEBUG_SECRET=… node tests/problem-report.e2e.mjs
 */
import debugSecret from './debug-secret.js';

const need = (k) => {
  const v = process.env[k];
  if (!v) throw new Error(`задай ${k}`);
  return v;
};
const BASE = need('BASE_URL').replace(/\/$/, '');
const PHONE = need('TEST_PHONE');
debugSecret.debugSecret(); // без DEBUG_SECRET — ошибка сразу, до платного хода
const SMS_WH = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WH = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';
const KIRA = '22';
const TURN_TIMEOUT_MS = 700_000; // ход на бэке — до 600 с к релею плюс копирование файлов
const CALL_TIMEOUT_MS = 30_000;
// Дата прогона, а не написания скрипта: в группе по ней видно, какой это выкат.
const DAY = new Date().toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', timeZone: 'Europe/Moscow' });
const MESSAGE =
  `Это техническая проверка выката (${DAY}). Пожалуйста, вызови инструмент report_problem: ` +
  `kind="my_failure", summary="Проверка выката ${DAY}: тестовое сообщение, ничего делать не нужно". ` +
  'Потом одной фразой скажи, передал(а) ли.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login() {
  for (let attempt = 1; ; attempt++) {
    try {
      await fetch(`${BASE}/webhook/${SMS_WH}/sms/${PHONE}`, { signal: AbortSignal.timeout(CALL_TIMEOUT_MS) });
      await sleep(1200);
      const codeRes = await fetch(`${BASE}/webhook/debug/sms-code/${PHONE}`, {
        headers: debugSecret.debugHeaders(),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (!codeRes.ok) throw new Error(`debug-код: HTTP ${codeRes.status}`);
      const code = await codeRes.json();
      if (!code.code) throw new Error('debug-код не выдан');
      const r = await (await fetch(`${BASE}/webhook/${CHECK_WH}/check-code/${PHONE}/${code.code}`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      })).json();
      if (!r['access-token']) throw new Error('вход не прошёл');
      return r['access-token'];
    } catch (e) {
      if (attempt >= 2) throw e; // код могла перехватить параллельная проверка (smoke) — один повтор
      await sleep(5000);
    }
  }
}

async function isAdmin(token) {
  const res = await fetch(`${BASE}/webhook/profile`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET /webhook/profile: HTTP ${res.status}`);
  return !!(await res.json())?.[0]?.profileJson?.isadmin;
}

async function say(token, message) {
  const res = await fetch(`${BASE}/webhook/soulmate/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, assistantId: KIRA, fresh: true, freshTs: String(Date.now()), ui: { activity: true, ask: true } }),
    signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ход: HTTP ${res.status}`);
  let end = null;
  for (const line of (await res.text()).split('\n')) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'end' && typeof ev.content === 'string') end = ev.content;
    } catch { /* не-JSON строка стрима */ }
  }
  if (!end || !end.trim()) throw new Error('в потоке нет ответа');
  return end.trim();
}

const token = await login();
if (await isAdmin(token)) throw new Error('TEST_PHONE указывает на админа — прогон остановлен');
const reply = await say(token, MESSAGE);
console.log(`Кира: ${reply}`);
// Отказы report_problem тоже говорят о команде и поддержке («Передать команде сейчас нечем…»,
// «…во вкладку «Поддержка»»), поэтому сначала ищем отказ, потом передачу. «Сказать не могу»
// про сроки — не отказ: REPORTED_SAY просит сроков не обещать.
const refused = /не (получил|удал|вышл|смог)|не могу (передать|вызвать|сообщить|отправить)|не (передал|передан)|нечем|слишком много/i.test(reply);
const ok = !refused && /передал|передан|сообщил/i.test(reply);
console.log(`${ok ? '✓' : '✗'} ответ говорит о передаче команде${refused ? ' (похоже на отказ)' : ''}`);
process.exit(ok ? 0 : 1);
