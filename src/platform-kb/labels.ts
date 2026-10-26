import { LanguageService } from '../common/services/language.service';
import type { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { KB_LABELS, KbLabelKey } from './labels.generated';

export type KbLabels = Record<KbLabelKey, string>;

/**
 * Подписи на языке пользователя. Тег схлопывается до корня (en-US → en);
 * незнакомый язык — русские подписи, как было у карты в platform-guide.ts.
 * normalize() возвращает string: приводим типом к ключу KB_LABELS, который
 * теперь Record по SUPPORTED_LANGUAGES, а не по string, — пропущенный язык
 * в таблице роняет tsc, а не всплывает подменой на русский в проде.
 */
export function labelsFor(lang: string): KbLabels {
  return KB_LABELS[LanguageService.normalize(lang) as (typeof SUPPORTED_LANGUAGES)[number]] ?? KB_LABELS.ru;
}
