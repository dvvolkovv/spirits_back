import { LanguageService } from '../common/services/language.service';
import { escapeRetentionHtml } from './retention-mail';

const TEXT: Record<string, { title: string; intro: string; confirm: string; done: string; already: string; invalid: string }> = {
  ru: { title: 'Отписка от рассылки возврата', intro: 'Подтвердите отписку адреса', confirm: 'Отписаться', done: 'Вы отписаны', already: 'Этот адрес уже отписан', invalid: 'Ссылка недействительна или устарела.' },
  en: { title: 'Unsubscribe from re-engagement emails', intro: 'Confirm unsubscribing', confirm: 'Unsubscribe', done: 'Unsubscribed', already: 'This address is already unsubscribed', invalid: 'This link is invalid or has expired.' },
  es: { title: 'Cancelar los correos de reactivación', intro: 'Confirma la cancelación de', confirm: 'Cancelar suscripción', done: 'Suscripción cancelada', already: 'Esta dirección ya está dada de baja', invalid: 'El enlace no es válido o ha caducado.' },
  de: { title: 'Rückgewinnungs-E-Mails abbestellen', intro: 'Bestätigen Sie die Abmeldung von', confirm: 'Abbestellen', done: 'Abmeldung bestätigt', already: 'Diese Adresse ist bereits abgemeldet', invalid: 'Dieser Link ist ungültig oder abgelaufen.' },
  fr: { title: 'Désabonnement des e-mails de réactivation', intro: 'Confirmez le désabonnement de', confirm: 'Se désabonner', done: 'Vous êtes désabonné', already: 'Cette adresse est déjà désabonnée', invalid: 'Ce lien est invalide ou a expiré.' },
  zh: { title: '退订回访邮件', intro: '确认退订地址', confirm: '确认退订', done: '已退订', already: '此地址已退订', invalid: '链接无效或已过期。' },
  pt: { title: 'Cancelar os e-mails de reativação', intro: 'Confirme o cancelamento de', confirm: 'Cancelar subscrição', done: 'Subscrição cancelada', already: 'Este endereço já está removido', invalid: 'A ligação é inválida ou expirou.' },
};

export function retentionUnsubscribePage(input: {
  language: string; status: 'confirm' | 'done' | 'already' | 'invalid';
  email?: string; token?: string;
}): string {
  const language = LanguageService.normalize(input.language);
  const s = TEXT[language] || TEXT.ru;
  const heading = input.status === 'done' ? s.done : input.status === 'already' ? s.already : s.title;
  const body = input.status === 'invalid' ? `<p>${escapeRetentionHtml(s.invalid)}</p>` :
    input.status === 'confirm'
      ? `<p>${escapeRetentionHtml(s.intro)} <strong>${escapeRetentionHtml(input.email || '')}</strong></p><form method="post" action="/webhook/retention/unsubscribe"><input type="hidden" name="token" value="${escapeRetentionHtml(input.token || '')}"><input type="hidden" name="lang" value="${language}"><button style="padding:12px 18px" type="submit">${escapeRetentionHtml(s.confirm)}</button></form>`
      : `<p>${escapeRetentionHtml(input.email || '')}</p>`;
  return `<!doctype html><html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex"><title>${escapeRetentionHtml(heading)}</title></head><body style="font-family:system-ui;padding:40px;text-align:center"><main style="max-width:480px;margin:auto"><h1 style="font-size:22px">${escapeRetentionHtml(heading)}</h1>${body}</main></body></html>`;
}
