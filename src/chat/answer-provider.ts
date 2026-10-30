import type { LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch).
 * Пробы мониторинга — всегда Claude: они меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'get'>,
): Promise<LlmProvider> {
  if (probe || !svc || !userId) return 'claude';
  return svc.get(userId);
}

/** Поля формы запроса к релею: проба — только Claude, выбор «Qwen» — provider. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'qwen' ? { provider: 'qwen' } : {};
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  const provider = ev?.provider === 'qwen' || ev?.provider === 'claude' ? ev.provider : undefined;
  return { provider, fallback: ev?.fallback === true };
}
