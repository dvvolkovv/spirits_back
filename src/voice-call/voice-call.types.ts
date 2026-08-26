/**
 * Сообщения, которые бэкенд шлёт в LiveKit-комнату (topic 'linkeon').
 * Поле v версионирует контракт: подсистемы C (Zoom) и D (телефония)
 * будут слушать тот же канал.
 *
 * Слушают оба: воркер (реагирует на answer/failed) и фронт (рисует плашки).
 */
export const VOICE_DATA_TOPIC = 'linkeon';

export type VoiceDataMessage =
  | { v: 1; type: 'specialist_pending'; jobId: string; specialist: string }
  | { v: 1; type: 'specialist_answer'; jobId: string; specialist: string; text: string }
  | { v: 1; type: 'specialist_failed'; jobId: string; specialist: string; reason: 'timeout' | 'error' };

/** Ответ на /internal/ask. rejected — не ошибка: модель должна это озвучить. */
export type AskResult =
  | { status: 'asked'; jobId: string; specialist: string }
  | { status: 'rejected'; reason: 'too_many_pending' | 'unknown_specialist' };

export interface CompletePayload {
  transcript: { role: 'user' | 'assistant'; text: string; ts: number }[];
  usage: { audioInputTokens: number; audioOutputTokens: number; model: string };
}

/**
 * Кому Роман может задавать вопросы. Ключ — то, что произносит модель,
 * значение — id в таблице agents.
 */
export const SPECIALISTS: Record<string, number> = {
  'Алексей': 10,
  'Анна': 9,
  'Виталий': 17,
  'Андрей': 7,
  'Александра': 11,
};

/**
 * Роли для ведущего: без них он выбирает специалиста по имени наугад.
 * 26.08.2026 юридический вопрос про согласия и информирование о стоимости
 * уехал Анне (бухгалтеру), а техническая архитектура телефонии — Алексею
 * (юристу). Оба честно ответили не по своей части.
 */
export const SPECIALIST_ROLES: Record<string, string> = {
  'Алексей': 'юрист — право, договоры, оферта, согласия, риски и требования регуляторов',
  'Анна': 'бухгалтер — учёт, налоги, первичка, отчётность',
  'Виталий': 'финансовый директор — юнит-экономика, финмодель, ценообразование, окупаемость',
  'Андрей': 'бизнес-консультант — стратегия, процессы, организация работы',
  'Александра': 'маркетолог — рынок, позиционирование, каналы привлечения, конкуренты',
};

/** Роман — ведущий разговора. */
export const HOST_AGENT_ID = 12;

/** Больше трёх параллельных job на звонок не берём. */
export const MAX_PENDING_JOBS = 3;

/** Дольше этого специалиста не ждём — Роман извиняется и отвечает сам. */
export const JOB_TIMEOUT_MS = 180_000;
