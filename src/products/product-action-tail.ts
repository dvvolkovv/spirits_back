import { LanguageService } from '../common/services/language.service';

const CONFIRM_IN_CABINET: Record<string, string> = {
  ru: 'Подтвердите в кабинете',
  en: 'Confirm in your account',
  es: 'Confírmalo en tu cuenta',
  de: 'Bestätige es in deinem Konto',
  fr: 'Confirmez dans votre espace',
  pt: 'Confirma na tua conta',
  zh: '请在个人中心确认',
};

/**
 * Хвост ответа ассистента с карточками, заведёнными этим ходом. Клиент с
 * карточками (ui.cards) получает блок ```product-action``` — его рисует и
 * поток, и история. Остальным (Flutter, старые сборки) — строка со ссылкой
 * на это же действие в кабинете: блок они показали бы как код.
 */
export function productActionTail(actions: ReadonlyArray<{ id: string }>, cards: boolean, lang: string | null | undefined): string {
  if (!actions.length) return '';
  if (cards) {
    return actions.map((a) => '\n\n```product-action\n' + JSON.stringify({ id: a.id }) + '\n```').join('');
  }
  const text = CONFIRM_IN_CABINET[LanguageService.normalize(lang)] ?? CONFIRM_IN_CABINET.ru;
  const base = (process.env.BACKEND_URL || 'https://my.linkeon.io').replace(/\/$/, '');
  return actions.map((a) => `\n\n${text}: ${base}/studio?tab=products&action=${a.id}`).join('');
}
