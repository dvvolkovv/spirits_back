import { ASSISTANT_DEFAULTS, GENDER_DEFAULT } from '../speech/voices';

/**
 * Кому в финале нужна строка «Ответ ИИ, не заменяет …» (спека: юристы,
 * психологи, медицина и деньги). Ключ — agents.name. Психолога среди
 * активных ассистентов на 25.10.2026 нет; появится — дописать сюда.
 */
const SPECIALIST: Record<string, string> = {
  'Алексей': 'юриста',
  'Анна': 'бухгалтера',
  'Виталий': 'финансового консультанта',
  'Полина': 'врача',
  'Шанкара': 'врача',
};

/** Ассистенты, чьи темы касаются здоровья: им — только спокойная подача (правило 12). */
const HEALTH = new Set(['Полина', 'Шанкара']);

export function disclaimerFor(assistantName: string): string | undefined {
  const who = SPECIALIST[assistantName];
  return who ? `Ответ ИИ, не заменяет ${who}` : undefined;
}

export function isHealthAssistant(assistantName: string): boolean {
  return HEALTH.has(assistantName);
}

/**
 * Голос ассистента в SpeechKit — тот, что у него по умолчанию в кабинете.
 * Незнакомому — женский по умолчанию, как resolveVoice; владелец услышит это
 * на проверке и, если что, ассистента допишут в ASSISTANT_DEFAULTS.
 */
export function assistantVoice(assistantName: string): string {
  return ASSISTANT_DEFAULTS[assistantName]?.yandex ?? GENDER_DEFAULT.f.yandex;
}
