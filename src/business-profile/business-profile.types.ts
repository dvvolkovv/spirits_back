/**
 * Карточка бизнеса пользователя. Живёт в profile_data->'business'.
 *
 * Каждое поле хранится тройкой, а не голым значением: source отличает то,
 * что ввёл человек, от того, что вывел ассистент из разговора. Правило
 * не-затирания (см. BusinessProfileService.merge) опирается только на него —
 * без source автосбор со временем затрёт выверенные данные, и карточка
 * станет хуже, чем была бы вообще без автосбора.
 */
export type FieldSource = 'user' | 'assistant';

export interface BusinessField {
  value: string;
  source: FieldSource;
  updated_at: string;
}

export type BusinessProfile = Partial<Record<BusinessFieldKey, BusinessField>>;

export type BusinessFieldKey =
  | 'what' | 'legal_form' | 'tax_mode' | 'stage' | 'revenue' | 'team' | 'customers' | 'focus';

export interface FieldSpec {
  key: BusinessFieldKey;
  /** Английский лейбл для промпта — как соседний блок `User profile:`. */
  promptLabel: string;
  /** Допустимые значения; отсутствует у свободных текстовых полей. */
  enum?: string[];
}

export const BUSINESS_FIELDS: FieldSpec[] = [
  { key: 'what',       promptLabel: 'What the business does' },
  { key: 'legal_form', promptLabel: 'Legal form', enum: ['self_employed', 'ip', 'ooo'] },
  { key: 'tax_mode',   promptLabel: 'Tax mode',   enum: ['npd', 'usn_d', 'usn_dr', 'patent', 'osno'] },
  { key: 'stage',      promptLabel: 'Stage',      enum: ['idea', 'year_one', 'stable', 'growth'] },
  { key: 'revenue',    promptLabel: 'Monthly revenue', enum: ['lt_300k', '300k_1m', '1m_3m', '3m_10m', 'gt_10m'] },
  { key: 'team',       promptLabel: 'Team' },
  { key: 'customers',  promptLabel: 'Customers' },
  { key: 'focus',      promptLabel: 'Current focus' },
];

/**
 * Значения хранятся кодами, а не текстом: на этом проекте локализация данных
 * уже роняла логику — includes() и регулярки по русским строкам переставали
 * срабатывать после перевода и падали молча.
 *
 * Рендерим российские термины их каноническими русскими названиями:
 * английских эквивалентов у УСН и ИП нет, а модель их знает.
 */
export const ENUM_LABELS: Partial<Record<BusinessFieldKey, Record<string, string>>> = {
  legal_form: {
    self_employed: 'самозанятый',
    ip: 'ИП',
    ooo: 'ООО',
  },
  tax_mode: {
    npd: 'НПД',
    usn_d: 'УСН Доходы',
    usn_dr: 'УСН Доходы минус расходы',
    patent: 'патент',
    osno: 'ОСНО',
  },
  stage: {
    idea: 'идея, ещё не запущен',
    year_one: 'первый год',
    stable: 'устойчивый',
    growth: 'рост',
  },
  revenue: {
    lt_300k: 'до 300 тыс ₽/мес',
    '300k_1m': '300 тыс – 1 млн ₽/мес',
    '1m_3m': '1–3 млн ₽/мес',
    '3m_10m': '3–10 млн ₽/мес',
    gt_10m: 'больше 10 млн ₽/мес',
  },
};

/** Код → человекочитаемое. Неизвестный код отдаём как есть: рендер промпта
 *  не должен падать из-за мусора, приехавшего от модели. */
export function renderEnum(key: BusinessFieldKey, value: string): string {
  return ENUM_LABELS[key]?.[value] ?? value;
}

export function isBusinessProfileEmpty(p: BusinessProfile | undefined | null): boolean {
  if (!p) return true;
  return !BUSINESS_FIELDS.some(f => (p[f.key]?.value || '').trim().length > 0);
}

/**
 * Блок карточки для системного промпта.
 *
 * Чистая функция без похода в базу: форматирование строки тестируется
 * без мока Postgres, а сервис остаётся тонким слоем персистентности.
 *
 * Лейблы английские — как соседний блок `User profile:` в chat.service.
 * Переводить их на семь локалей не нужно: русский хвост промпта уже
 * однажды заставил ассистента отвечать по-русски аккаунту с language=en,
 * и повторять эту ошибку блоком побольше незачем.
 *
 * Единственная точка рендера на все три пути сборки промпта. В
 * chat.service.ts рядом с блоком `User profile:` уже есть комментарий о
 * том, что сборка промпта продублирована трижды — это предупреждение,
 * а не наблюдение.
 */
export function renderBusinessBlock(
  p: BusinessProfile,
  category: string | null | undefined,
): string {
  if (isBusinessProfileEmpty(p)) return '';

  if (category !== 'business') {
    // Психологу и коучу полезно знать, что человек ведёт дело, но оборот
    // и налоговый режим им не нужны — только суть и размер команды.
    const what = (p.what?.value || '').trim();
    if (!what) return '';
    const team = (p.team?.value || '').trim();
    return team
      ? `Пользователь ведёт свой бизнес — ${what}; команда: ${team}.`
      : `Пользователь ведёт свой бизнес — ${what}.`;
  }

  const lines: string[] = ['Business profile:'];
  const missing: string[] = [];

  for (const f of BUSINESS_FIELDS) {
    const raw = (p[f.key]?.value || '').trim();
    if (!raw) {
      missing.push(f.promptLabel);
      continue;
    }
    lines.push(`${f.promptLabel}: ${renderEnum(f.key, raw)}`);
  }

  if (missing.length > 0) {
    lines.push(`Not filled in: ${missing.join(', ')}.`);
  }

  return lines.join('\n');
}
