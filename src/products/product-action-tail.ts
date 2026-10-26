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

/**
 * Блок ```product-action``` — не то, что модель вправе писать сама: она видит
 * старые блоки в истории разговора и знает actionId из результата своего же
 * инструмента (manage_product), так что может скопировать чужой/просроченный
 * блок или повторить свежий второй раз. Приписывать его разрешено только
 * серверу — здесь же, после takeForTurn. Эта функция чистит ЛЮБОЙ такой блок
 * из текста модели перед тем, как сервер допишет свой (или не допишет вовсе).
 *
 * Съедаем и пустые строки ПЕРЕД блоком — ровно тот разделитель, что сам же
 * productActionTail ставит перед своим блоком ("\n\n```product-action..."), —
 * чтобы на месте вырезанного не осталась пустая дыра из одних \n. Пустые
 * строки ПОСЛЕ блока не трогаем: они принадлежат следующему абзацу, который
 * мы не вырезаем.
 *
 * Незакрытый блок (стрим обрезался до закрывающей ```` ``` ````, что обычным
 * чанкам r.linkeon не редкость) режется ДО КОНЦА текста, а не оставляется как
 * есть: фронт увидел бы открывающую fence без закрывающей и попытался бы
 * распарсить весь остаток ответа как код-блок — это хуже, чем потерять
 * случайный хвост самодельного блока, который и так не должен был появиться.
 *
 * Обычные code fences (```js и т.п.) не трогаем — литерал в регулярке именно
 * ```product-action, а не произвольный язык после ```.
 */
export function stripProductActionBlocks(text: string): string {
  if (!text) return text;
  return text.replace(/(?:[ \t]*\r?\n)*```product-action[ \t]*\r?\n[\s\S]*?(?:\r?\n```|$)/g, '');
}
