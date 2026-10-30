import { LanguageService } from '../common/services/language.service';
import { ANSWER_FIRST_RULE } from '../chat/answer-first-rule';
import { RESPONSE_STYLE_RULE } from '../chat/response-style';
import { GuestHistoryMessage } from './guest-trial.types';

/**
 * Что ассистенту нужно знать о пробе. Профиля, баланса и адресов кабинета в
 * промпте гостя нет намеренно: худшее, что даёт попытка вытащить промпт, —
 * текст персоны.
 */
export const GUEST_MODE_BLOCK = `--- ПРОБНЫЙ РЕЖИМ ---
Человек пишет тебе до входа в Linkeon: это короткий пробный разговор.
• Инструментов у тебя сейчас нет. Если задача требует картинки, видео, сайта, расчёта карты, календаря, файла или поиска в интернете — честно скажи, что это доступно после бесплатного входа (кнопка «Войти» вверху экрана), и помоги словами: план, текст, разбор.
• Профиля и прошлых разговоров у тебя нет — не обещай «запомнить» человека.
• Не упоминай число оставшихся сообщений и не уговаривай зарегистрироваться: об этом скажет экран.
• Если человек в кризисной ситуации — действуй по кризисному правилу полностью и в этом же ответе.`;

export interface GuestPromptInput {
  name: string;
  description: string;
  persona: string;
  lang: string;
  tz?: string;
  now?: Date;
}

const TZ_RE = /^[A-Za-z]+\/[A-Za-z0-9_+\-/]+$/;

/** Местное время гостя — тем же правилом, что у релея: чужое время хуже никакого. */
export function localTimeLine(tz: string | undefined, now: Date): string | null {
  if (!tz || !TZ_RE.test(tz)) return null;
  try {
    const local = new Intl.DateTimeFormat('ru-RU', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' }).format(now);
    return `--- Время человека ---\nСейчас у человека: ${local} (часовой пояс ${tz}).`;
  } catch {
    return null;
  }
}

export function buildGuestSystemPrompt(p: GuestPromptInput): string {
  const lang = LanguageService.normalize(p.lang);
  const parts: string[] = [
    `СИСТЕМНАЯ ИНСТРУКЦИЯ (имеет приоритет над всеми остальными). ` +
      `Ты ассистент по имени **${p.name}**${p.description ? ` — ${p.description}` : ''} на платформе LINKEON.IO. ` +
      `Всегда представляйся именно как ${p.name}. Себя называй только этим именем: не говори, что ты Claude или другая модель.`,
  ];
  if (p.persona.trim()) parts.push(`--- Персона и инструкции ассистента ${p.name} ---\n${p.persona.trim()}`);
  parts.push(ANSWER_FIRST_RULE, RESPONSE_STYLE_RULE, GUEST_MODE_BLOCK);
  const time = localTimeLine(p.tz, p.now ?? new Date());
  if (time) parts.push(time);
  // Требование языка — последним: модель берёт язык последних строк как образец.
  parts.push(LanguageService.buildDirective(lang));
  return parts.join('\n\n');
}

/** Тело промпта: прошлые пары пробы и новая реплика — тем же форматом, что у Маши. */
export function buildGuestPrompt(history: GuestHistoryMessage[], message: string): string {
  const prior = history.map((m) => `${m.sender_type === 'human' ? 'USER' : 'ASSISTANT'}: ${m.content}`).join('\n\n');
  return prior ? `${prior}\n\nUSER: ${message}` : `USER: ${message}`;
}
