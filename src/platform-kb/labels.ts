import { LanguageService } from '../common/services/language.service';
import { KB_LABELS, KbLabelKey } from './labels.generated';

export type KbLabels = Record<KbLabelKey, string>;

/**
 * Подписи на языке пользователя. Тег схлопывается до корня (en-US → en);
 * незнакомый язык — русские подписи, как было у карты в platform-guide.ts.
 */
export function labelsFor(lang: string): KbLabels {
  return KB_LABELS[LanguageService.normalize(lang)] ?? KB_LABELS.ru;
}
