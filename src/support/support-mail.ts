import { LanguageService, DEFAULT_LANGUAGE } from '../common/services/language.service';

/**
 * Сколько символов ответа несём в письме. Реплика владельца может быть до
 * LIMITS.MESSAGE_MAX (4000) — столько в письме не нужно: длинный хвост читается
 * по ссылке, а почтовые клиенты режут письма своим «показать полностью».
 */
export const MAIL_TEXT_MAX = 1200;

interface Strings {
  subject: string;
  intro: string;
  cta: string;
  footer: string;
}

const STRINGS: Record<string, Strings> = {
  ru: {
    subject: 'Ответ службы поддержки Linkeon',
    intro: 'Вам ответили в поддержке Linkeon:',
    cta: 'Открыть переписку и ответить',
    footer: 'Письмо отправлено автоматически — отвечать на него не нужно.',
  },
  en: {
    subject: 'Linkeon support replied',
    intro: 'You have a reply from Linkeon support:',
    cta: 'Open the conversation and reply',
    footer: 'This is an automated message — no need to reply to this email.',
  },
  es: {
    subject: 'Respuesta del soporte de Linkeon',
    intro: 'Tienes una respuesta del soporte de Linkeon:',
    cta: 'Abrir la conversación y responder',
    footer: 'Este es un mensaje automático: no hace falta responder a este correo.',
  },
  de: {
    subject: 'Antwort vom Linkeon-Support',
    intro: 'Sie haben eine Antwort vom Linkeon-Support:',
    cta: 'Unterhaltung öffnen und antworten',
    footer: 'Diese Nachricht wurde automatisch versendet — eine Antwort per E-Mail ist nicht nötig.',
  },
  fr: {
    subject: 'Réponse du support Linkeon',
    intro: 'Vous avez une réponse du support Linkeon :',
    cta: 'Ouvrir la conversation et répondre',
    footer: 'Message automatique — inutile de répondre à cet e-mail.',
  },
  zh: {
    subject: 'Linkeon 客服已回复',
    intro: 'Linkeon 客服回复了您：',
    cta: '打开对话并回复',
    footer: '此邮件为系统自动发送，无需回复。',
  },
  pt: {
    subject: 'Resposta do apoio ao cliente da Linkeon',
    intro: 'Tem uma resposta do apoio ao cliente da Linkeon:',
    cta: 'Abrir a conversa e responder',
    footer: 'Mensagem automática — não é necessário responder a este e-mail.',
  },
};

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Письмо о ручном ответе поддержки. Текст ответа несём целиком (в пределах
 * MAIL_TEXT_MAX) — уведомление «вам ответили» без ответа заставляет ходить в
 * приложение ради одной строки, и его просто перестают открывать.
 */
export function buildOwnerReplyEmail(
  lang: string,
  params: { text: string; url: string },
): { subject: string; html: string } {
  const s = STRINGS[LanguageService.normalize(lang)] || STRINGS[DEFAULT_LANGUAGE];

  const raw = params.text.length > MAIL_TEXT_MAX
    ? `${params.text.slice(0, MAIL_TEXT_MAX)}…`
    : params.text;
  const body = escapeHtml(raw).replace(/\r?\n/g, '<br>');
  const url = escapeHtml(params.url);

  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111">` +
    `<p>${escapeHtml(s.intro)}</p>` +
    `<blockquote style="margin:16px 0;padding:12px 16px;border-left:3px solid #6366f1;background:#f5f5fb">${body}</blockquote>` +
    `<p><a href="${url}" style="color:#4f46e5">${escapeHtml(s.cta)}</a></p>` +
    `<p style="color:#888;font-size:13px">${escapeHtml(s.footer)}</p>` +
    `</div>`;

  return { subject: s.subject, html };
}
