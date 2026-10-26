/**
 * Админский API роликов стенда — с ноды, прямо в API на 127.0.0.1:3001 (мимо
 * Nginx и Basic Auth стенда). Вход — админ стенда (ADMIN_PHONE из studio/.env)
 * по debug-OTP с DEBUG_SECRET; токен кешируется в out/.admin-session.json (600).
 *
 *   npx tsx scripts/stand-admin.ts <действие> [ключ=строка | ключ:=json]...
 *   npx tsx scripts/stand-admin.ts list
 *   npx tsx scripts/stand-admin.ts order topic='Как не потерять залог' rubric=assistant angle=uncomfortable assistantId:=10
 *   npx tsx scripts/stand-admin.ts update_settings settings:='{"tgChannelChatId":"-1003290853538"}'
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { CHECK_WEBHOOK, SMS_WEBHOOK } from '../src/capture/login';

const API = (process.env.ADMIN_API_URL?.trim() || 'http://127.0.0.1:3001').replace(/\/+$/, '');
const CACHE = path.resolve('out', '.admin-session.json');

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`stand-admin: не задана переменная ${name} в studio/.env`);
  return v;
}

async function login(phone: string, secret: string): Promise<string> {
  const sms = await fetch(`${API}/webhook/${SMS_WEBHOOK}/sms/${phone}`);
  if (!sms.ok) throw new Error(`stand-admin: запрос SMS — ${sms.status}`);
  let code = '';
  for (let i = 0; i < 10 && !code; i++) {
    const r = await fetch(`${API}/webhook/debug/sms-code/${phone}`, { headers: { 'X-Debug-Secret': secret } });
    if (r.status === 404) throw new Error('stand-admin: debug-ручка ответила 404 — неверный DEBUG_SECRET');
    if (r.ok) code = String(((await r.json()) as { code?: string }).code ?? '');
    if (!code) await new Promise((res) => setTimeout(res, 1000));
  }
  if (!code) throw new Error('stand-admin: код не появился за 10 секунд');
  const check = await fetch(`${API}/webhook/${CHECK_WEBHOOK}/check-code/${phone}/${code}`);
  if (!check.ok) throw new Error(`stand-admin: check-code — ${check.status}`);
  const token = ((await check.json()) as Record<string, string>)['access-token'];
  if (!token) throw new Error('stand-admin: в ответе check-code нет токена');
  fs.mkdirSync(path.dirname(CACHE), { recursive: true });
  fs.writeFileSync(CACHE, JSON.stringify({ phone, token }), { mode: 0o600 });
  return token;
}

function parseArgs(args: string[]): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const a of args) {
    const json = a.indexOf(':=');
    const eq = a.indexOf('=');
    if (json > 0 && json + 1 === eq) body[a.slice(0, json)] = JSON.parse(a.slice(json + 2));
    else if (eq > 0) body[a.slice(0, eq)] = a.slice(eq + 1);
    else throw new Error(`stand-admin: аргумент «${a}» — ключ=строка или ключ:=json`);
  }
  return body;
}

const [action, ...rest] = process.argv.slice(2);
if (!action) {
  console.error('usage: npx tsx scripts/stand-admin.ts <действие> [ключ=строка | ключ:=json]...');
  process.exit(2);
}
const phone = need('ADMIN_PHONE');
const secret = need('DEBUG_SECRET');
const body = JSON.stringify({ action, ...parseArgs(rest) });
const cached = fs.existsSync(CACHE) ? (JSON.parse(fs.readFileSync(CACHE, 'utf8')) as { phone?: string; token?: string }) : {};
let token = cached.phone === phone && cached.token ? cached.token : await login(phone, secret);
const call = (t: string) =>
  fetch(`${API}/webhook/admin/shorts`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body });
let res = await call(token);
if (res.status === 401) {
  token = await login(phone, secret);
  res = await call(token);
}
const text = await res.text();
let out = text;
try {
  out = JSON.stringify(JSON.parse(text), null, 2);
} catch {
  // не JSON — печатаем как есть
}
console.log(`HTTP ${res.status}\n${out}`);
if (!res.ok) process.exit(1);
