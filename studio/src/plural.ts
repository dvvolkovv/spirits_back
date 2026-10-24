const FORMS: Record<string, string> = {
  one: 'ассистент',
  few: 'ассистента',
  many: 'ассистентов',
  other: 'ассистента',
};

const rules = new Intl.PluralRules('ru-RU');

/** «18 ассистентов», «21 ассистент» — категории из Intl.PluralRules, а не самодельные остатки от деления. */
export function assistantsLabel(n: number): string {
  return `${n} ${FORMS[rules.select(n)]}`;
}
