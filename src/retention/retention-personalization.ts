import { LanguageService } from '../common/services/language.service';
import type { RetentionMode } from './retention.types';

export function normalizeRetentionName(raw: unknown): string | null {
  const value = String(raw ?? '').trim();
  const length = Array.from(value).length;
  return length > 0 && length <= 80 ? value : null;
}

const FORMS: Record<string, { day: Record<string, string>; hour: Record<string, string> }> = {
  ru: {
    day: { one: 'день', few: 'дня', many: 'дней', other: 'дней' },
    hour: { one: 'час', few: 'часа', many: 'часов', other: 'часов' },
  },
  en: {
    day: { one: 'day', other: 'days' },
    hour: { one: 'hour', other: 'hours' },
  },
  es: {
    day: { one: 'día', other: 'días' },
    hour: { one: 'hora', other: 'horas' },
  },
  de: {
    day: { one: 'einem Tag', other: 'Tagen' },
    hour: { one: 'einer Stunde', other: 'Stunden' },
  },
  fr: {
    day: { one: 'jour', other: 'jours' },
    hour: { one: 'heure', other: 'heures' },
  },
  zh: {
    day: { other: '天' },
    hour: { other: '小时' },
  },
  pt: {
    day: { one: 'dia', other: 'dias' },
    hour: { one: 'hora', other: 'horas' },
  },
};

export function formatRetentionInactivity(
  language: string,
  mode: RetentionMode,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string | null {
  const raw = mode === 'general' ? daysInactive : hoursInactive;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || !Number.isInteger(raw) || raw < 0) return null;
  const lang = LanguageService.normalize(language);
  const unit = mode === 'general' ? 'day' : 'hour';
  const category = new Intl.PluralRules(lang).select(raw);
  const form = FORMS[lang][unit][category] || FORMS[lang][unit].other;
  if (lang === 'de' && raw === 1) return form;
  return `${raw}${lang === 'zh' ? '' : ' '}${form}`;
}
