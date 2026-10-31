import { isAnswerProvider } from '../common/services/llm-fallback';
import type { AnswerProvider } from '../common/services/llm-fallback';
import type { AnswerRoute, LlmProvider, UserLlmProviderService } from '../common/services/user-llm-provider.service';

/**
 * Через какую модель отвечать человеку (spec 2026-10-30-llm-provider-switch,
 * 2026-10-31-global-llm-switch): личный выбор в карточке, иначе общий
 * рубильник. Пробы мониторинга — всегда Claude: они меряют его, а не настройку.
 */
export async function resolveAnswerProvider(
  probe: boolean,
  userId: string | null | undefined,
  svc?: Pick<UserLlmProviderService, 'route'>,
): Promise<AnswerRoute> {
  if (probe || !svc) return { provider: 'claude', choice: null };
  return svc.route(userId ?? '');
}

/** Поля формы запроса к релею: проба — только Claude, выбор Qwen/Kimi — provider.
 *  У релея своего рубильника нет — модель приходит в каждом запросе. */
export function relayProviderFields(probe: boolean, provider: LlmProvider): Record<string, string> {
  if (probe) return { noFallback: '1' };
  return provider === 'claude' ? {} : { provider };
}

/** Выбор для ClaudeCliService (Маша, TG): личный — явно, в том числе Claude
 *  (рубильник к нему не применяется); рубильник и проба — без поля: рубильник
 *  ClaudeCliService применит сам, а проба идёт с noFallback. */
export function cliProviderOption(route: AnswerRoute): { provider?: AnswerProvider } {
  return route.choice === 'user' ? { provider: route.provider } : {};
}

/** Чем ответил релей — из события done (старый релей полей не шлёт). */
export function readDoneProvider(ev: any): { provider?: LlmProvider; fallback: boolean } {
  return { provider: isAnswerProvider(ev?.provider) ? ev.provider : undefined, fallback: ev?.fallback === true };
}
