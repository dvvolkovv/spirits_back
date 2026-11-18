/**
 * Списание за оборванный ход — за то, что успело прийти (решение владельца
 * 16–17.11.2026, спек docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md).
 *
 * До 17.11 ход без финального ответа (`done.failed` от релея) не
 * тарифицировался вовсе, а релей писал человеку «Токены за этот ход не
 * списаны». Теперь частичный ответ, оборванный сбоем, списывается по
 * фактическому расходу хода — той же формулой, что у обычного
 * (ChatService.computeSdkCharge).
 *
 * Правило одно на индикатор «N токенов» в `end` и на точку списания — у
 * веб-хода (streamUniversalAgent) и у хода с файлом (uploadAndChat →
 * persistUploadTurn). Разойдись они, человек увидел бы одно, а списалось бы
 * другое. Отказ CLI, долетевший текстом, добавляет ChatService.turnBilling.
 */

/**
 * Обрывы, после которых человек мог что-то получить (решение владельца 17.11.2026):
 * - transient_after_partial — связь с моделью оборвалась посреди ответа;
 * - max_turns — задача не уложилась в три захода, большая часть работы сделана;
 * - preempted — человек сам отправил новое сообщение, ответ прерван;
 * - transient_after_write — связь оборвалась после действия (картинка, запись в календарь).
 *
 * Не входят — сбой до ответа: cli_fatal и transient (релей), cli_fatal_text
 * (отказ CLI, долетевший текстом), relay_draining и relay_superseded
 * (шлагбаум выката).
 */
export const PARTIAL_BILLED_REASONS: ReadonlySet<string> = new Set([
  'transient_after_partial',
  'max_turns',
  'preempted',
  'transient_after_write',
]);

export interface TurnDelivery {
  /** done.failed от релея — или сбой, выставленный бэком (шлагбаум, отказ CLI текстом). */
  failed: boolean;
  failReason: string;
  /** Символы текста МОДЕЛИ, ушедшие человеку (delta/text/result), — без служебных реплик релея. */
  modelChars: number;
  /** Файлы хода, ушедшие человеку (outputFiles релея). */
  files: number;
}

export interface BillingDecision {
  billable: boolean;
  /** Списано за оборванный ход — причина обрыва, иначе undefined. */
  partial?: string;
}

/**
 * Служебная реплика релея («ответ оборван…») «пришедшим» не считается: она
 * приходит и тогда, когда модель не успела сказать ни слова. Поэтому
 * modelChars считается без неё.
 */
export function billingDecision(d: TurnDelivery): BillingDecision {
  if (!d.failed) return { billable: true };
  if (PARTIAL_BILLED_REASONS.has(d.failReason) && (d.modelChars > 0 || d.files > 0)) {
    return { billable: true, partial: d.failReason };
  }
  return { billable: false };
}
