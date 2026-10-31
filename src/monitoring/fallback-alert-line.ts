import { FALLBACK_ORDER, FallbackProvider, PROVIDER_LABELS } from '../common/services/llm-fallback';

// Общая строка двух алертов: «Локальный Claude CLI недоступен»
// (claude-health.service.ts) и алерта релея (relay-qwen-monitor.service.ts).

/** Строка про запасных в алерте «Локальный Claude CLI недоступен»: видно,
 *  обслуживаются ли люди, пока вход не починен, и не лежат ли сами запасные.
 *  Без склонений — счётчики после тире. */
export function fallbackAlertLine(s: {
  windowMs: number;
  providers?: Partial<Record<FallbackProvider, { enabled: boolean; ok: number; failed: number }>>;
}): string {
  const parts = FALLBACK_ORDER.map((n) => {
    const p = s.providers?.[n];
    return p?.enabled ? `${PROVIDER_LABELS[n]} — ответов ${p.ok}, ошибок ${p.failed}` : `${PROVIDER_LABELS[n]} — не настроен`;
  });
  return `Запасные за ${Math.round(s.windowMs / 60_000)} мин: ${parts.join('; ')}`;
}
