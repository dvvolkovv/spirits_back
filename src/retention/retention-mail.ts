import { LanguageService } from '../common/services/language.service';
import { formatRetentionInactivity, normalizeRetentionName } from './retention-personalization';
import type { RetentionMode } from './retention.types';

interface Strings {
  generalSubject: string;
  curiousSubject: string;
  defaultAssistant: string;
  fromLinkeon: string;
  defaultGreeting: string;
  namedGreeting: string;
  lastActivity: string;
  generalBody: string;
  curiousBody: string;
  cta: string;
  footer: string;
  unsubscribe: string;
}

const STRINGS: Record<string, Strings> = {
  ru: {
    generalSubject: 'Ваш ассистент Linkeon будет рад продолжить разговор',
    curiousSubject: 'Продолжим знакомство с Linkeon?', defaultAssistant: 'Ваш ассистент', fromLinkeon: ' из LINKEON',
    defaultGreeting: 'Здравствуйте!', namedGreeting: 'Здравствуйте, {name}!', lastActivity: 'Последняя активность в Linkeon была {inactivity} назад.',
    generalBody: 'Здравствуйте! {assistant} будет рад продолжить разговор, если будет желание — можно вернуться в чат: {url} Если сейчас не до этого, это совершенно нормально, не отвлекаем.',
    curiousBody: 'Здравствуйте! Напомним, что у нас есть ассистенты под любые задачи. Если есть время и желание — приходите в {url} и повышайте свою эффективность 👍',
    cta: 'Вернуться в чат', footer: 'Вы получили это письмо возврата, потому что регистрировались в Linkeon.', unsubscribe: 'Отписаться от рассылки возврата',
  },
  en: {
    generalSubject: 'Your Linkeon assistant would be happy to continue',
    curiousSubject: 'Shall we continue getting to know Linkeon?', defaultAssistant: 'Your assistant', fromLinkeon: ' from Linkeon',
    defaultGreeting: 'Hello!', namedGreeting: 'Hello, {name}!', lastActivity: 'Your last activity in Linkeon was {inactivity} ago.',
    generalBody: 'Hello! {assistant} would be happy to continue the conversation whenever you wish: {url} If now is not the right time, that is completely fine.',
    curiousBody: 'Hello! A quick reminder that Linkeon has assistants for a wide range of tasks. Whenever you have time, visit {url} and explore how they can help 👍',
    cta: 'Return to chat', footer: 'You received this re-engagement email because you registered with Linkeon.', unsubscribe: 'Unsubscribe from re-engagement emails',
  },
  es: {
    generalSubject: 'Tu asistente de Linkeon estará encantado de continuar',
    curiousSubject: '¿Seguimos conociendo Linkeon?', defaultAssistant: 'Tu asistente', fromLinkeon: ' de Linkeon',
    defaultGreeting: '¡Hola!', namedGreeting: '¡Hola, {name}!', lastActivity: 'Tu última actividad en Linkeon fue hace {inactivity}.',
    generalBody: '¡Hola! {assistant} estará encantado de continuar la conversación cuando quieras: {url} Si ahora no es buen momento, no pasa nada.',
    curiousBody: '¡Hola! Te recordamos que Linkeon tiene asistentes para distintas tareas. Cuando tengas tiempo, visita {url} y descubre cómo pueden ayudarte 👍',
    cta: 'Volver al chat', footer: 'Recibiste este correo de reactivación porque te registraste en Linkeon.', unsubscribe: 'Cancelar la suscripción a los correos de reactivación',
  },
  de: {
    generalSubject: 'Ihr Linkeon-Assistent freut sich auf das weitere Gespräch',
    curiousSubject: 'Möchten Sie Linkeon weiter kennenlernen?', defaultAssistant: 'Ihr Assistent', fromLinkeon: ' von Linkeon',
    defaultGreeting: 'Guten Tag!', namedGreeting: 'Guten Tag, {name}!', lastActivity: 'Ihre letzte Aktivität in Linkeon war vor {inactivity}.',
    generalBody: 'Guten Tag! {assistant} freut sich darauf, das Gespräch fortzusetzen, wenn Sie möchten: {url} Wenn es gerade nicht passt, ist das völlig in Ordnung.',
    curiousBody: 'Guten Tag! Zur Erinnerung: Linkeon bietet Assistenten für viele verschiedene Aufgaben. Wenn Sie Zeit haben, besuchen Sie {url} und entdecken Sie die Möglichkeiten 👍',
    cta: 'Zum Chat zurückkehren', footer: 'Sie erhalten diese Rückgewinnungs-E-Mail, weil Sie sich bei Linkeon registriert haben.', unsubscribe: 'Rückgewinnungs-E-Mails abbestellen',
  },
  fr: {
    generalSubject: 'Votre assistant Linkeon sera ravi de poursuivre la conversation',
    curiousSubject: 'Envie de continuer à découvrir Linkeon ?', defaultAssistant: 'Votre assistant', fromLinkeon: ' de Linkeon',
    defaultGreeting: 'Bonjour !', namedGreeting: 'Bonjour, {name} !', lastActivity: 'Dernière activité sur Linkeon : il y a {inactivity}.',
    generalBody: 'Bonjour ! {assistant} sera ravi de poursuivre la conversation si vous le souhaitez : {url} Si ce n’est pas le bon moment, c’est tout à fait normal.',
    curiousBody: 'Bonjour ! Petite piqûre de rappel : Linkeon propose des assistants pour de nombreuses tâches. Quand vous avez un moment, rendez-vous sur {url} pour découvrir comment ils peuvent vous aider 👍',
    cta: 'Revenir au chat', footer: 'Vous avez reçu cet e-mail de réactivation car vous vous êtes inscrit à Linkeon.', unsubscribe: 'Se désabonner des e-mails de réactivation',
  },
  zh: {
    generalSubject: '您的 Linkeon 助手期待继续与您交流',
    curiousSubject: '要继续了解 Linkeon 吗？', defaultAssistant: '您的助手', fromLinkeon: '（来自 Linkeon）',
    defaultGreeting: '您好！', namedGreeting: '您好，{name}！', lastActivity: '您在 Linkeon 的最近活动是在{inactivity}前。',
    generalBody: '您好！如果您愿意，{assistant}很乐意继续与您交流：{url} 如果现在不方便，也完全没有关系。',
    curiousBody: '您好！提醒您，Linkeon 有适合各种任务的助手。如果您有时间，欢迎访问 {url}，了解它们如何提高您的效率 👍',
    cta: '返回聊天', footer: '您收到这封回访邮件，是因为您注册过 Linkeon。', unsubscribe: '退订回访邮件',
  },
  pt: {
    generalSubject: 'O seu assistente Linkeon terá todo o gosto em continuar',
    curiousSubject: 'Vamos continuar a conhecer o Linkeon?', defaultAssistant: 'O seu assistente', fromLinkeon: ' do Linkeon',
    defaultGreeting: 'Olá!', namedGreeting: 'Olá, {name}!', lastActivity: 'A sua última atividade no Linkeon foi há {inactivity}.',
    generalBody: 'Olá! {assistant} terá todo o gosto em continuar a conversa quando desejar: {url} Se agora não for conveniente, é perfeitamente normal.',
    curiousBody: 'Olá! Lembramos que o Linkeon tem assistentes para várias tarefas. Quando tiver tempo, visite {url} e descubra como podem ajudar 👍',
    cta: 'Voltar ao chat', footer: 'Recebeu este e-mail de reativação porque se registou no Linkeon.', unsubscribe: 'Cancelar a subscrição dos e-mails de reativação',
  },
};

export function escapeRetentionHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function retentionChatUrl(language: string): string {
  return `https://my.linkeon.io/chat?lang=${LanguageService.normalize(language)}`;
}

export function buildRetentionSmsMessage(
  mode: RetentionMode,
  assistantName?: string | null,
  name?: unknown,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string {
  const s = STRINGS.ru;
  const who = assistantName ? `${assistantName} из LINKEON` : 'Ваш ассистент в LINKEON';
  const template = mode === 'general'
    ? `Здравствуйте! ${who} будет рад продолжить разговор, если будет желание — можно вернуться в чат: {url}. Если сейчас не до этого, это совершенно нормально, не отвлекаем.`
    : fill(s.curiousBody, who);
  return personalizeBody(template, mode, 'ru', s, name, daysInactive, hoursInactive)
    .split('{url}').join('https://my.linkeon.io/chat');
}

function fill(template: string, assistant: string): string {
  return template.split('{assistant}').join(assistant);
}

function personalizeBody(
  template: string,
  mode: RetentionMode,
  language: string,
  strings: Strings,
  name: unknown,
  daysInactive?: unknown,
  hoursInactive?: unknown,
): string {
  const lang = LanguageService.normalize(language);
  const normalizedName = normalizeRetentionName(name);
  const greeting = normalizedName
    ? strings.namedGreeting.split('{name}').join(normalizedName)
    : strings.defaultGreeting;
  const inactivity = formatRetentionInactivity(lang, mode, daysInactive, hoursInactive);
  const activity = inactivity
    ? ` ${strings.lastActivity.split('{inactivity}').join(inactivity)}`
    : '';
  return `${greeting}${activity}${template.slice(strings.defaultGreeting.length)}`;
}

export function buildRetentionEmail(input: {
  mode: RetentionMode;
  language: string;
  assistantName?: string | null;
  name?: unknown;
  daysInactive?: unknown;
  hoursInactive?: unknown;
  chatUrl: string;
  unsubscribeUrl: string | null;
}): { subject: string; text: string; html: string } {
  const language = LanguageService.normalize(input.language);
  const s = STRINGS[language] || STRINGS.ru;
  const assistant = input.assistantName ? `${input.assistantName}${s.fromLinkeon}` : `${s.defaultAssistant}${s.fromLinkeon}`;
  const template = fill(input.mode === 'general' ? s.generalBody : s.curiousBody, assistant);
  const personalized = personalizeBody(template, input.mode, language, s, input.name, input.daysInactive, input.hoursInactive);
  const body = personalized.split('{url}').join(input.chatUrl);
  const subject = input.mode === 'general' ? s.generalSubject : s.curiousSubject;
  const [beforeUrl, afterUrl] = personalized.split('{url}');
  const link = `<a href="${escapeRetentionHtml(input.chatUrl)}" style="color:#4f46e5">${escapeRetentionHtml(s.cta)}</a>`;
  let html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111"><p>${escapeRetentionHtml(beforeUrl)}${link}${escapeRetentionHtml(afterUrl || '')}</p>`;
  let text = body;
  if (input.unsubscribeUrl) {
    text += `\n\n${s.footer}\n${s.unsubscribe}: ${input.unsubscribeUrl}`;
    html += `<p style="color:#777;font-size:13px">${escapeRetentionHtml(s.footer)}<br><a href="${escapeRetentionHtml(input.unsubscribeUrl)}" style="color:#4f46e5">${escapeRetentionHtml(s.unsubscribe)}</a></p>`;
  }
  return { subject, text, html: `${html}</div>` };
}
