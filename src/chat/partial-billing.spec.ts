import { billingDecision, PARTIAL_BILLED_REASONS, TurnDelivery } from './partial-billing';

/**
 * Списание за оборванный ход (решение владельца 16–17.11.2026, спек
 * docs/superpowers/specs/2026-11-17-partial-turn-billing-design.md, §1).
 * Таблица: успех; четыре причины из списка — с текстом модели, с файлом, без
 * того и другого; причины вне списка — даже с текстом и файлами.
 */

const LISTED = ['transient_after_partial', 'max_turns', 'preempted', 'transient_after_write'];
// cli_fatal и transient — сбой до ответа на релее; cli_fatal_text — отказ CLI,
// долетевший текстом; relay_draining и relay_superseded — шлагбаум выката;
// unknown — done.failed без причины (релей старой сборки).
const NOT_LISTED = ['cli_fatal', 'transient', 'cli_fatal_text', 'relay_draining', 'relay_superseded', 'unknown'];

const failed = (failReason: string, o: Partial<TurnDelivery> = {}): TurnDelivery =>
  ({ failed: true, failReason, modelChars: 0, files: 0, ...o });

describe('billingDecision', () => {
  it('успешный ход списывается как раньше — с текстом и без', () => {
    expect(billingDecision({ failed: false, failReason: '', modelChars: 120, files: 0 })).toEqual({ billable: true });
    expect(billingDecision({ failed: false, failReason: '', modelChars: 0, files: 0 })).toEqual({ billable: true });
  });

  it('в списке ровно четыре причины решения владельца', () => {
    expect([...PARTIAL_BILLED_REASONS].sort()).toEqual([...LISTED].sort());
  });

  it.each(LISTED)('%s с текстом модели — списание с пометкой причины', (reason) => {
    expect(billingDecision(failed(reason, { modelChars: 15 }))).toEqual({ billable: true, partial: reason });
  });

  it.each(LISTED)('%s с файлом без текста — тоже списание', (reason) => {
    expect(billingDecision(failed(reason, { files: 1 }))).toEqual({ billable: true, partial: reason });
  });

  it.each(LISTED)('%s без текста и файлов (одна служебная реплика) — не списывается', (reason) => {
    expect(billingDecision(failed(reason))).toEqual({ billable: false });
  });

  it.each(NOT_LISTED)('%s вне списка — не списывается и с текстом, и с файлами', (reason) => {
    expect(billingDecision(failed(reason, { modelChars: 500, files: 2 }))).toEqual({ billable: false });
  });
});
