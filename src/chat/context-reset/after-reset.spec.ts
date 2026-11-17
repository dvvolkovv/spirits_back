import { afterReset, legacyFreshResetAt, LEGACY_FRESH_FUTURE_SLACK_MS } from './after-reset';

describe('afterReset', () => {
  const rows = [
    { id: 'old', created_at: '2026-11-16T10:00:00Z' },
    { id: 'edge', created_at: '2026-11-16T12:00:00Z' },
    { id: 'new', created_at: '2026-11-16T12:00:01Z' },
  ];

  it('без точки — всё как есть', () => {
    expect(afterReset(rows, null, (r) => r.created_at)).toBe(rows);
    expect(afterReset(rows, undefined, (r) => r.created_at)).toBe(rows);
  });

  it('с точкой — только строго позже неё', () => {
    const out = afterReset(rows, new Date('2026-11-16T12:00:00Z'), (r) => r.created_at);
    expect(out.map((r) => r.id)).toEqual(['new']);
  });

  it('строка без времени при заданной точке отбрасывается: старое не должно протечь', () => {
    const out = afterReset([{ id: 'x', created_at: null }], new Date(0), (r) => r.created_at);
    expect(out).toEqual([]);
  });

  it('принимает Date и строку', () => {
    const out = afterReset(
      [{ at: new Date('2026-11-17T00:00:00Z') }, { at: '2026-11-15T00:00:00Z' }],
      new Date('2026-11-16T00:00:00Z'),
      (r) => r.at,
    );
    expect(out).toHaveLength(1);
  });
});

describe('legacyFreshResetAt', () => {
  const now = Date.UTC(2026, 10, 17, 8, 0, 0);

  it('метка старого клиента — это и есть точка', () => {
    expect(legacyFreshResetAt(String(now - 1000), now)?.getTime()).toBe(now - 1000);
    expect(legacyFreshResetAt(now - 1000, now)?.getTime()).toBe(now - 1000);
  });

  it('мусор — не точка', () => {
    for (const v of [undefined, null, '', 'abc', '12345', '1.5e12', '-1794804919138']) {
      expect(legacyFreshResetAt(v, now)).toBeNull();
    }
  });

  it('метка из будущего дальше окна — не точка: иначе память стёрлась бы навсегда', () => {
    expect(legacyFreshResetAt(String(now + LEGACY_FRESH_FUTURE_SLACK_MS + 1), now)).toBeNull();
    expect(legacyFreshResetAt(String(now + LEGACY_FRESH_FUTURE_SLACK_MS), now)).not.toBeNull();
  });
});
