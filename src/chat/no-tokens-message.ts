import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '../common/services/language.service';
import { TOP_UP_URL } from '../tokens/balance-context.service';

type Lang = (typeof SUPPORTED_LANGUAGES)[number];

/**
 * Что видит человек, когда на нулевом балансе отправил сообщение.
 *
 * Прежний текст («⚠️ Недостаточно токенов. Ваш баланс исчерпан…») был только
 * по-русски и обрывал разговор канцеляритом — в том числе посреди
 * психологической практики (находка «Затыков недели» a3da5a2b). Биллинг не
 * меняется (решение владельца 02.11.2026): ответа на нуле нет, меняется
 * только то, как об этом сказано. Разговор действительно сохранён — история в
 * базе и сессия на релее остаются.
 *
 * Ревью качества 02.11 (I4): сохранённость разговора — это про ПРОШЛЫЕ ходы,
 * а само ОТКЛОНЁННОЕ сообщение никуда не уходит (загрузка — файлы тоже
 * выбрасываются), и текст об этом молчал. Добавлена отдельная фраза `retry`
 * (`retryUpload` — для шлагбаума с вложениями), которая явно просит отправить
 * сообщение ещё раз.
 *
 * Ссылка (I5) — абсолютная TOP_UP_URL, не /chat?view=tokens: мобильный
 * Flutter-рендерер markdown (linkeon_mobile/lib/widgets/chat_markdown.dart)
 * открывает ссылку через launchUrl и без схемы падает молча, а кабинет
 * абсолютную ссылку на свой же хост и так открывает в той же вкладке.
 *
 * Магазинная сборка (opts.storeBuild) — по решению владельца баланс там не
 * упоминается вовсе (Apple 3.1.1, см. BalanceContextService.buildContextForPrompt
 * про opts.storeBuild): отдельный нейтральный текст без слов
 * «токены/баланс/пополнить» и без ссылки.
 */
const TEXTS: Record<Lang, { title: string; body: string; cta: string; retry: string; retryUpload: string }> = {
  ru: {
    title: 'Токены закончились',
    body: 'Ассистент сейчас не сможет ответить. Разговор сохранён — пополните баланс и продолжите с того же места.',
    cta: 'Пополнить баланс',
    retry: 'Это сообщение ассистент не получил — после пополнения отправьте его ещё раз.',
    retryUpload: 'Это сообщение ассистент не получил — после пополнения отправьте его ещё раз и прикрепите файлы заново.',
  },
  en: {
    title: 'Out of tokens',
    body: "The assistant can't reply right now. Your conversation is saved — top up your balance to pick up right where you left off.",
    cta: 'Top up balance',
    retry: "The assistant didn't receive this message — after topping up, send it again.",
    retryUpload: "The assistant didn't receive this message — after topping up, send it again and reattach your files.",
  },
  es: {
    title: 'Sin tokens',
    body: 'El asistente no puede responder ahora. La conversación está guardada: recarga el saldo para continuar justo donde lo dejaste.',
    cta: 'Recargar saldo',
    retry: 'El asistente no recibió este mensaje: después de recargar el saldo, envíalo de nuevo.',
    retryUpload: 'El asistente no recibió este mensaje: después de recargar el saldo, envíalo de nuevo y adjunta los archivos otra vez.',
  },
  de: {
    title: 'Keine Tokens mehr',
    body: 'Der Assistent kann gerade nicht antworten. Das Gespräch ist gespeichert – lade dein Guthaben auf, um genau dort weiterzumachen, wo du aufgehört hast.',
    cta: 'Guthaben aufladen',
    retry: 'Der Assistent hat diese Nachricht nicht erhalten – lade dein Guthaben auf und sende sie erneut.',
    retryUpload: 'Der Assistent hat diese Nachricht nicht erhalten – lade dein Guthaben auf, sende sie erneut und füge die Dateien wieder an.',
  },
  fr: {
    title: 'Plus de jetons',
    // M1 (ревью качества): «là où tu en étais» вместо «tu t'es arrêté» — без
    // указания рода, который во французском пол собеседника не знает.
    body: "L'assistant ne peut pas répondre pour le moment. La conversation est enregistrée : recharge ton solde pour reprendre là où tu en étais.",
    cta: 'Recharger le solde',
    retry: "L'assistant n'a pas reçu ce message : recharge ton solde, puis renvoie-le.",
    retryUpload: "L'assistant n'a pas reçu ce message : recharge ton solde, renvoie-le et rejoins à nouveau tes fichiers.",
  },
  pt: {
    title: 'Sem tokens',
    body: 'O assistente não consegue responder agora. A conversa ficou guardada — carregue o saldo para continuar exatamente onde parou.',
    cta: 'Carregar saldo',
    retry: 'O assistente não recebeu esta mensagem — depois de carregar o saldo, envie-a novamente.',
    retryUpload: 'O assistente não recebeu esta mensagem — depois de carregar o saldo, envie-a novamente e anexe os ficheiros outra vez.',
  },
  zh: {
    title: '代币已用完',
    body: '助手现在无法回复。对话已保存——充值后即可从中断处继续。',
    cta: '充值余额',
    retry: '助手没有收到这条消息——充值后请重新发送。',
    retryUpload: '助手没有收到这条消息——充值后请重新发送并重新添加文件。',
  },
};

/**
 * Магазинная сборка: ни слова о токенах/балансе/оплате (правило Apple 3.1.1)
 * — ни в обычном тексте, ни в этом. Поэтому своя, намеренно короткая и
 * нейтральная формулировка вместо TEXTS + retry: упомянуть «пополнение» было
 * бы тем же нарушением, что и ссылка.
 */
const STORE_BUILD_TEXTS: Record<Lang, string> = {
  ru: '⚠️ **Ответ сейчас недоступен**\n\nАссистент не может ответить на это сообщение.',
  en: "⚠️ **Reply unavailable right now**\n\nThe assistant can't reply to this message.",
  es: '⚠️ **Respuesta no disponible ahora**\n\nEl asistente no puede responder a este mensaje.',
  de: '⚠️ **Antwort momentan nicht verfügbar**\n\nDer Assistent kann auf diese Nachricht nicht antworten.',
  fr: "⚠️ **Réponse indisponible pour le moment**\n\nL'assistant ne peut pas répondre à ce message.",
  pt: '⚠️ **Resposta indisponível agora**\n\nO assistente não consegue responder a esta mensagem.',
  zh: '⚠️ **暂时无法回复**\n\n助手无法回复这条消息。',
};

export interface NoTokensOpts {
  /** Шлагбаум загрузки (upload-and-chat): файлы тоже не дошли и нужно прикрепить их заново. */
  upload?: boolean;
  /** Сборка для App Store/Google Play — нейтральный текст без слов «токены/баланс», без ссылки. */
  storeBuild?: boolean;
}

export function noTokensMessage(lang: string, opts: NoTokensOpts = {}): string {
  const key = ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang) ? lang : DEFAULT_LANGUAGE) as Lang;

  if (opts.storeBuild) return STORE_BUILD_TEXTS[key];

  const t = TEXTS[key];
  const retry = opts.upload ? t.retryUpload : t.retry;
  return `⚠️ **${t.title}**\n\n${t.body} ${retry}\n\n👉 [${t.cta}](${TOP_UP_URL})`;
}
