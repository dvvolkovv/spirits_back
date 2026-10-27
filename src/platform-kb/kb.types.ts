import { SUPPORTED_LANGUAGES } from '../common/services/language.service';
import type { KbLabelKey } from './labels.generated';
import type { SectionKey } from './section-links';

export type KbLang = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Кто задаёт вопрос. От этого зависит, куда направить и о чём молчать:
 *   web      — веб и Capacitor-приложение (тот же React, те же подписи);
 *   app      — Flutter-приложение: меню своё;
 *   store    — сборки из App Store и Google Play: ни токенов, ни баланса, ни оплаты
 *              (balance-context.service.ts — Apple отклоняла четырежды по 3.1.1);
 *   telegram — ходы ботов в Telegram: всё делается в кабинете my.linkeon.io.
 */
export const KB_CLIENTS = ['web', 'app', 'store', 'telegram'] as const;
export type KbClient = (typeof KB_CLIENTS)[number];

/** Части статьи — в этом порядке. Тема how-it-works устроена по-своему. */
// «Лимиты» — тот же раздел «Лимиты и цены», но заголовок без цен: так он
// выходит в сборке для стора (client 'store'), см. render.ts.
export const KB_PARTS = ['Что это', 'Где', 'Как', 'Лимиты и цены', 'Лимиты', 'Чего нельзя', 'Если не получается', 'Как устроено'] as const;

/** Что получает render статьи. Имена q, paid, nonStore и url — договорённость: на них опирается тест исходников. */
export interface KbContext {
  lang: KbLang;
  client: KbClient;
  /** Подпись на языке пользователя в ёлочках: q('studio') → «Студия». */
  q: (key: KbLabelKey) => string;
  /** Строка о токенах и деньгах — цены, стартовый подарок, расход, баланс. В сборке из стора — пустая. */
  paid: (text: string) => string;
  /**
   * Строка про установку приложения файлом (APK) — решение владельца 25.10.2026:
   * сборки из App Store/Google Play ставятся самим стором, упоминать обход
   * через файл им нельзя. В сборке из стора — пустая.
   */
  nonStore: (text: string) => string;
  /**
   * Полный адрес раздела кабинета для строки «Ссылка…» в разделе «Где»:
   * url('zoom') → https://my.linkeon.io/profile?open=zoom (section-links.ts).
   * Адрес не зависит ни от языка, ни от клиента: работает он везде.
   */
  url: (key: SectionKey) => string;
}

export interface KbArticle {
  /** Он же имя модуля в articles/ и значение enum инструмента. */
  id: string;
  title: string;
  /** Одна строка: попадает в описание инструмента и в перечень тем. */
  summary: string;
  /** Соседние темы — их id. */
  related: string[];
  /** Тема о деньгах: в сборке из стора её нет вовсе. */
  paidOnly?: boolean;
  render: (c: KbContext) => string;
}
