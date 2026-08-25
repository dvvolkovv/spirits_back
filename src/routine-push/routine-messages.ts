/**
 * Тексты проактивных пушей. Паттерн тот же, что у searchMsg в misc.service.ts:
 * плоская карта по языку с откатом на ru.
 *
 * Языки — из SUPPORTED_LANGUAGES (common/services/language.service.ts).
 * Тест routine-push.i18n.spec.ts падает, если там появится язык без строк здесь.
 *
 * Локализуется только то, что видит пользователь. Операционные алерты
 * (sendTelegramAlert в runDue) остаются русскими — их читаем мы, не пользователь.
 */
export interface RoutineMessages {
  energyTitle: string;
  reminder: string;
  assistant: string;
}

const MESSAGES: Record<string, RoutineMessages> = {
  ru: { energyTitle: 'Энергия дня от Райи 🌅', reminder: 'Напоминание', assistant: 'ассистент' },
  en: { energyTitle: 'Energy of the day from Raya 🌅', reminder: 'Reminder', assistant: 'assistant' },
  es: { energyTitle: 'Energía del día de Raya 🌅', reminder: 'Recordatorio', assistant: 'asistente' },
  pt: { energyTitle: 'Energia do dia da Raya 🌅', reminder: 'Lembrete', assistant: 'assistente' },
  de: { energyTitle: 'Tagesenergie von Raya 🌅', reminder: 'Erinnerung', assistant: 'Assistent' },
  fr: { energyTitle: 'Énergie du jour de Raya 🌅', reminder: 'Rappel', assistant: 'assistant' },
  zh: { energyTitle: '来自 Raya 的每日能量 🌅', reminder: '提醒', assistant: '助手' },
};

export const routineMsg = (lang: string): RoutineMessages => MESSAGES[lang] || MESSAGES.ru;
