import { promises as dnsp } from 'dns';

/** Имя TXT-записи подтверждения: `_linkeon.<домен>`. */
export const TXT_LABEL = '_linkeon';

export interface DnsResolver {
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
}

export interface RecordCheck {
  type: 'TXT' | 'A' | 'AAAA';
  name: string;
  ok: boolean;
  /** Что сейчас в DNS. При сбое резолвера — одна строка «ошибка DNS: …». */
  current: string[];
  /** Что должно быть. У AAAA — пусто: записей быть не должно. */
  want: string;
}

export interface DnsCheckResult {
  ok: boolean;
  records: RecordCheck[];
}

export interface DnsCheckInput {
  domain: string;
  names: string[];
  token: string;
  hostIp: string;
}

/**
 * Публичные резолверы, а не системный кеш прод-сервера: пользователь поправит
 * запись, а системный резолвер ещё час отдавал бы старую. Проверено 24.09.2026 —
 * с прод-сервера 1.1.1.1 и 8.8.8.8 доступны, Resolver отдаёт A, TXT и AAAA.
 */
export function publicResolver(): DnsResolver {
  const r = new dnsp.Resolver({ timeout: 3000, tries: 1 });
  r.setServers(['1.1.1.1', '8.8.8.8']);
  return r;
}

/** «Записи нет» — не ошибка, а ответ. Всё остальное — сбой, и он называется. */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

async function lookup<T>(fn: () => Promise<T[]>): Promise<{ values: T[]; error: string | null }> {
  try {
    return { values: await fn(), error: null };
  } catch (e: any) {
    if (NO_RECORD.has(e?.code)) return { values: [], error: null };
    return { values: [], error: String(e?.code ?? e?.message ?? e) };
  }
}

/**
 * Готов ли домен к выпуску сертификата: все три условия сразу.
 *
 * 1. TXT `_linkeon.<домен>` содержит разовый код — домен принадлежит заявителю.
 *    Без этого на общем IP любой пользователь мог бы занять домен, уже
 *    направленный на машину другим.
 * 2. У КАЖДОГО имени ВСЕ A-записи — IP машины продукта. CNAME резолвер
 *    разворачивает сам и отдаёт итоговый A.
 * 3. AAAA нет ни у одного имени: у машин продуктов нет IPv6, а Let's Encrypt
 *    предпочитает IPv6 — одна оставшаяся AAAA роняет выпуск.
 */
export async function checkDns(input: DnsCheckInput, resolver: DnsResolver): Promise<DnsCheckResult> {
  const records: RecordCheck[] = [];

  const txtName = `${TXT_LABEL}.${input.domain}`;
  const txt = await lookup(() => resolver.resolveTxt(txtName));
  const txtValues = txt.values.map((chunks) => chunks.join(''));
  records.push({
    type: 'TXT',
    name: txtName,
    ok: !txt.error && txtValues.includes(input.token),
    current: txt.error ? [`ошибка DNS: ${txt.error}`] : txtValues,
    want: input.token,
  });

  for (const name of input.names) {
    const a = await lookup(() => resolver.resolve4(name));
    records.push({
      type: 'A',
      name,
      ok: !a.error && a.values.length > 0 && a.values.every((ip) => ip === input.hostIp),
      current: a.error ? [`ошибка DNS: ${a.error}`] : a.values,
      want: input.hostIp,
    });
    const aaaa = await lookup(() => resolver.resolve6(name));
    records.push({
      type: 'AAAA',
      name,
      ok: !aaaa.error && aaaa.values.length === 0,
      current: aaaa.error ? [`ошибка DNS: ${aaaa.error}`] : aaaa.values,
      want: '',
    });
  }

  return { ok: records.every((r) => r.ok), records };
}
