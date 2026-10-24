/**
 * Типы бота «Затыки недели». Спека: docs/superpowers/specs/2026-10-24-conversation-insights-design.md.
 *
 * userId живёт только в памяти прогона: в таблицы insights_* он не попадает,
 * в модель — тоже (вместо него «человек N»).
 */

export const FRICTION_TYPES = ['missing', 'confused', 'assistant', 'failure', 'money', 'silent'] as const;
export type FrictionType = (typeof FRICTION_TYPES)[number];

export const FRICTION_LABELS: Record<FrictionType, string> = {
  missing: 'Нет нужного',
  confused: 'Не нашёл или запутался',
  assistant: 'Ассистент не справился',
  failure: 'Сбой',
  money: 'Деньги',
  silent: 'Ушёл молча',
};

export type Source = 'web' | 'tg' | 'support' | 'call';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

/** Разговор недели — пара «человек + ассистент». */
export interface Conversation {
  key: string;
  source: Source;
  userId: string;
  /** Имя ассистента для модели и сводки. Свой ассистент — «свой ассистент», не его имя. */
  assistant: string;
  turns: Turn[];
}

/** Сигналы без модели — считаются из данных, текст никуда не уходит. */
export interface Signals {
  unansweredRuns: number;
  silentQuestionMarks: number;
  emptyOrFailedTurns: number;
  meetingsTotal: number;
  meetingsFailed: number;
  crisisConversations: number;
  thirdPartyGroupsSkipped: number;
}

export function emptySignals(): Signals {
  return {
    unansweredRuns: 0,
    silentQuestionMarks: 0,
    emptyOrFailedTurns: 0,
    meetingsTotal: 0,
    meetingsFailed: 0,
    crisisConversations: 0,
    thirdPartyGroupsSkipped: 0,
  };
}

export interface Collected {
  conversations: Conversation[];
  signals: Signals;
  /** Имена человека для обезличивания: userId → строки из профиля и Telegram. */
  names: Map<string, string[]>;
}

/** Один затык в одном разговоре — выход разметки. */
export interface Label {
  person: number;
  assistant: string;
  type: FrictionType;
  about: string;
  severity: 1 | 2 | 3;
}

export type FindingStatus = 'open' | 'backlog' | 'rejected';

/** Находка прошлых недель — вход сводки. */
export interface PriorFinding {
  id: string;
  type: FrictionType;
  title: string;
  status: FindingStatus;
  weeks: number;
  lastPeople: number;
  rejectedPeople: number | null;
}

/** Находка недели — выход сводки после проверки. */
export interface SynthFinding {
  priorId: string | null;
  type: FrictionType;
  title: string;
  description: string;
  proposal: string;
  people: number;
  conversations: number;
  assistants: string[];
  severity: 1 | 2 | 3;
}
