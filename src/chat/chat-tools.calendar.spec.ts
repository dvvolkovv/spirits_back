import { validateProposedEvent } from './chat-tools';

describe('validateProposedEvent', () => {
  it('kind=task: always ok, even with nothing set', () => {
    expect(validateProposedEvent({ kind: 'task' })).toEqual({ ok: true });
  });

  it('kind=task: ok even with datetime/recurrence/dates all set (ignored)', () => {
    expect(
      validateProposedEvent({
        kind: 'task',
        datetime: '2026-08-17T09:00:00',
        recurrence: { freq: 'daily', count: 5 },
        dates: ['2026-08-17T09:00:00', '2026-08-18T09:00:00'],
      }),
    ).toEqual({ ok: true });
  });

  it('kind=event: rejects 0 time-specs', () => {
    const r = validateProposedEvent({ kind: 'event' });
    expect(r.ok).toBe(false);
  });

  it('kind=event: accepts a single plain datetime', () => {
    expect(validateProposedEvent({ kind: 'event', datetime: '2026-08-17T09:45:00' })).toEqual({ ok: true });
  });

  it('kind=event: rejects 2 time-specs (datetime + dates together)', () => {
    const r = validateProposedEvent({
      kind: 'event',
      datetime: '2026-08-17T09:45:00',
      dates: ['2026-08-19T09:00:00'],
    });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects 2 time-specs (recurrence + dates together)', () => {
    const r = validateProposedEvent({
      kind: 'event',
      datetime: '2026-08-17T09:45:00',
      recurrence: { freq: 'weekly', count: 10 },
      dates: ['2026-08-19T09:00:00'],
    });
    expect(r.ok).toBe(false);
  });

  it('kind=event: accepts recurrence+count paired with datetime (does not double-count as 2 specs)', () => {
    expect(
      validateProposedEvent({
        kind: 'event',
        datetime: '2026-08-17T09:45:00',
        recurrence: { freq: 'weekly', byDay: ['MO', 'TU', 'WE', 'TH', 'FR'], count: 10 },
      }),
    ).toEqual({ ok: true });
  });

  it('kind=event: accepts recurrence+until paired with datetime', () => {
    expect(
      validateProposedEvent({
        kind: 'event',
        datetime: '2026-08-17T09:45:00',
        recurrence: { freq: 'weekly', until: '2026-08-21' },
      }),
    ).toEqual({ ok: true });
  });

  it('kind=event: rejects recurrence without datetime', () => {
    const r = validateProposedEvent({ kind: 'event', recurrence: { freq: 'daily', count: 3 } });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects recurrence with neither count nor until', () => {
    const r = validateProposedEvent({ kind: 'event', datetime: '2026-08-17T09:45:00', recurrence: { freq: 'daily' } });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects recurrence with both count and until', () => {
    const r = validateProposedEvent({
      kind: 'event',
      datetime: '2026-08-17T09:45:00',
      recurrence: { freq: 'daily', count: 3, until: '2026-08-21' },
    });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects count=0', () => {
    const r = validateProposedEvent({ kind: 'event', datetime: '2026-08-17T09:45:00', recurrence: { freq: 'daily', count: 0 } });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects count=101', () => {
    const r = validateProposedEvent({ kind: 'event', datetime: '2026-08-17T09:45:00', recurrence: { freq: 'daily', count: 101 } });
    expect(r.ok).toBe(false);
  });

  it('kind=event: accepts count=100 (boundary)', () => {
    expect(
      validateProposedEvent({ kind: 'event', datetime: '2026-08-17T09:45:00', recurrence: { freq: 'daily', count: 100 } }),
    ).toEqual({ ok: true });
  });

  it('kind=event: accepts dates with <=100 entries', () => {
    const dates = Array.from({ length: 100 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00`);
    expect(validateProposedEvent({ kind: 'event', dates })).toEqual({ ok: true });
  });

  it('kind=event: rejects dates with >100 entries', () => {
    const dates = Array.from({ length: 101 }, (_, i) => `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00`);
    const r = validateProposedEvent({ kind: 'event', dates });
    expect(r.ok).toBe(false);
  });

  it('kind=event: rejects empty dates array', () => {
    const r = validateProposedEvent({ kind: 'event', dates: [] });
    expect(r.ok).toBe(false);
  });
});
