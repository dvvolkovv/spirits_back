import { isAnswerProvider } from '../common/services/llm-fallback';
import type { FallbackProvider } from '../common/services/llm-fallback';
import type { LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-kimi-provider-design). Пробы мониторинга — всегда Claude: они
 * меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'get'>,
): Promise<LlmProvider> {
  if (probe || !svc || !userId) return 'claude';
  return svc.get(userId);
}

/** Поля формы запроса к релею: проба — только Claude, выбор Qwen/Kimi — provider. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'claude' ? {} : { provider };
}

/** Выбор для ClaudeCliService (Маша, TG): Claude — без поля. */
export function cliProviderOption(provider: LlmProvider): { provider?: FallbackProvider } {
  return provider === 'claude' ? {} : { provider };
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  return { provider: isAnswerProvider(ev?.provider) ? ev.provider : undefined, fallback: ev?.fallback === true };
}
