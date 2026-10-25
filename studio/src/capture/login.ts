import fs from 'node:fs';
import path from 'node:path';
import type { StudioConfig } from '../config';
import { StudioError } from '../errors';

// UUID-вебхуки входа — из spirits_front/src/services/authService.ts
// (те же стоят в e2e-помощниках фронта, tests/e2e/helpers/login.ts).
const SMS_WEBHOOK = '898c938d-f094-455c-86af-969617e62f7a';
const CHECK_WEBHOOK = 'a376a8ed-3bf7-4f23-aaa5-236eea72871b';

export interface Session {
  accessToken: string;
  refreshToken: string;
  userData: Record<string, unknown>;
}

async function fetchCode(cfg: StudioConfig): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const r = await fetch(`${cfg.apiUrl}/webhook/debug/sms-code/${cfg.demoPhone}`, { headers: { 'X-Debug-Secret': cfg.debugSecret } });
    if (r.status === 404) throw new StudioError('login', 'login: debug-ручка ответила 404 — неверный DEBUG_SECRET или ручки в этой среде выключены', false);
    if (r.ok) {
      const body = (await r.json()) as { code?: string };
      if (body.code) return body.code;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new StudioError('login', 'login: код не появился за 10 секунд', true);
}

/** Вход демо-аккаунта через API, без интерфейса: SMS → код из debug-ручки → check-code → профиль. */
export async function loginDemo(cfg: StudioConfig): Promise<Session> {
  const sms = await fetch(`${cfg.apiUrl}/webhook/${SMS_WEBHOOK}/sms/${cfg.demoPhone}`);
  if (!sms.ok) throw new StudioError('login', `login: запрос SMS — ${sms.status}`, true);
  const code = await fetchCode(cfg);
  const check = await fetch(`${cfg.apiUrl}/webhook/${CHECK_WEBHOOK}/check-code/${cfg.demoPhone}/${code}`);
  if (!check.ok) throw new StudioError('login', `login: check-code — ${check.status}`, true);
  const tokens = (await check.json()) as { 'access-token'?: string; 'refresh-token'?: string };
  const accessToken = tokens['access-token'];
  const refreshToken = tokens['refresh-token'];
  if (!accessToken || !refreshToken) throw new StudioError('login', 'login: в ответе check-code нет токенов', true);

  const prof = await fetch(`${cfg.apiUrl}/webhook/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!prof.ok) throw new StudioError('login', `login: профиль — ${prof.status}`, true);
  const raw = (await prof.json()) as unknown;
  const rec = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  const pj = ((rec?.profileJson as Record<string, unknown> | undefined) ?? rec ?? {}) as Record<string, unknown>;
  // Та же форма userData, что у AuthContext и e2e-помощников фронта.
  const userData = {
    id: cfg.demoPhone,
    phone: cfg.demoPhone,
    firstName: pj.name ?? '',
    lastName: pj.family_name ?? '',
    isAdmin: pj.isadmin === true,
    tokens: typeof pj.tokens === 'string' ? Number(pj.tokens) : (pj.tokens ?? 0),
    email: pj.email ?? '',
    preferredAgent: pj.preferred_agent ?? '',
  };
  return { accessToken, refreshToken, userData };
}

/**
 * Вход с кешем: SMS на номер ограничены по частоте, поэтому живой токен
 * переиспользуется. Файл лежит в out/ (вне git) с правами 600.
 */
export async function loginDemoCached(cfg: StudioConfig, cacheFile: string): Promise<Session> {
  if (fs.existsSync(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Session & { phone?: string; apiUrl?: string };
    if (cached.phone === cfg.demoPhone && cached.apiUrl === cfg.apiUrl) {
      const r = await fetch(`${cfg.apiUrl}/webhook/profile`, { headers: { Authorization: `Bearer ${cached.accessToken}` } });
      if (r.ok) return cached;
    }
  }
  const s = await loginDemo(cfg);
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify({ ...s, phone: cfg.demoPhone, apiUrl: cfg.apiUrl }), { mode: 0o600 });
  return s;
}
