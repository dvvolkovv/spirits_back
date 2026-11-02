import { DEFAULT_LANGUAGE } from '../common/services/language.service';

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
 * Ссылка относительная, как была: её рисует кабинет, и она открывает окно
 * пополнения в той же вкладке.
 */
const TEXTS: Record<string, { title: string; body: string; cta: string }> = {
  ru: {
    title: 'Токены закончились',
    body: 'Ассистент сейчас не сможет ответить. Разговор сохранён — пополните баланс и продолжите с того же места.',
    cta: 'Пополнить баланс',
  },
  en: {
    title: 'Out of tokens',
    body: "The assistant can't reply right now. Your conversation is saved — top up your balance to pick up right where you left off.",
    cta: 'Top up balance',
  },
  es: {
    title: 'Sin tokens',
    body: 'El asistente no puede responder ahora. La conversación está guardada: recarga el saldo para continuar justo donde lo dejaste.',
    cta: 'Recargar saldo',
  },
  de: {
    title: 'Keine Tokens mehr',
    body: 'Der Assistent kann gerade nicht antworten. Das Gespräch ist gespeichert – lade dein Guthaben auf, um genau dort weiterzumachen, wo du aufgehört hast.',
    cta: 'Guthaben aufladen',
  },
  fr: {
    title: 'Plus de jetons',
    body: "L'assistant ne peut pas répondre pour le moment. La conversation est enregistrée : recharge ton solde pour reprendre là où tu t'es arrêté.",
    cta: 'Recharger le solde',
  },
  pt: {
    title: 'Sem tokens',
    body: 'O assistente não consegue responder agora. A conversa ficou guardada — carregue o saldo para continuar exatamente onde parou.',
    cta: 'Carregar saldo',
  },
  zh: {
    title: '代币已用完',
    body: '助手现在无法回复。对话已保存——充值后即可从中断处继续。',
    cta: '充值余额',
  },
};

export function noTokensMessage(lang: string): string {
  const t = TEXTS[lang] || TEXTS[DEFAULT_LANGUAGE];
  return `⚠️ **${t.title}**\n\n${t.body}\n\n👉 [${t.cta}](/chat?view=tokens)`;
}
