/**
 * Unit-tests for the JSON parser used in profile consolidation.
 * The model occasionally wraps JSON in markdown or prose — these tests
 * pin the tolerance contract so it doesn't regress.
 *
 * Run: cd tests && npx jest unit/
 */

// Inline copy of extractJsonObject from neo4j.service.ts (intentional —
// extracting it into a separate module just for testing would require
// production code changes; copying keeps the unit test purely additive).
function extractJsonObject(text) {
  if (!text) return null;
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  try { return JSON.parse(s); } catch {}
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { if (inStr) esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

describe('extractJsonObject', () => {
  test('parses clean JSON', () => {
    expect(extractJsonObject('{"a":1,"b":[2,3]}')).toEqual({ a: 1, b: [2, 3] });
  });

  test('strips ```json fences', () => {
    expect(extractJsonObject('```json\n{"x":42}\n```')).toEqual({ x: 42 });
  });

  test('strips bare ``` fences', () => {
    expect(extractJsonObject('```\n{"x":1}\n```')).toEqual({ x: 1 });
  });

  test('tolerates prose before JSON', () => {
    const input = 'Вот извлечённый профиль из диалога:\n\n{"interests":["музыка"],"values":[]}';
    expect(extractJsonObject(input)).toEqual({ interests: ['музыка'], values: [] });
  });

  test('tolerates prose after JSON', () => {
    const input = '{"a":1}\n\nНа основе диалога я также заметил что...';
    expect(extractJsonObject(input)).toEqual({ a: 1 });
  });

  test('handles nested objects', () => {
    expect(extractJsonObject('{"a":{"b":{"c":1}}}')).toEqual({ a: { b: { c: 1 } } });
  });

  test('handles strings containing braces (no false depth)', () => {
    const input = '{"text":"hello {world} } embedded"}';
    expect(extractJsonObject(input)).toEqual({ text: 'hello {world} } embedded' });
  });

  test('handles escaped quotes in strings', () => {
    const input = '{"text":"she said \\"hi\\""}';
    expect(extractJsonObject(input)).toEqual({ text: 'she said "hi"' });
  });

  test('returns null for empty input', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject(null)).toBeNull();
    expect(extractJsonObject(undefined)).toBeNull();
  });

  test('returns null when no { found', () => {
    expect(extractJsonObject('просто текст без JSON')).toBeNull();
  });

  test('returns null on broken JSON inside braces', () => {
    expect(extractJsonObject('{this is not valid json}')).toBeNull();
  });

  test('regression: "Unexpected non-whitespace character after JSON at position 105"', () => {
    // Real case from logs — model emitted JSON followed by prose
    const input = '{"interests":["спорт"],"values":["честность"],"desires":[],"beliefs":[],"intents":[],"skills":[]}\n\nЭто на основе того, что пользователь сказал.';
    expect(extractJsonObject(input)).toEqual({
      interests: ['спорт'],
      values: ['честность'],
      desires: [],
      beliefs: [],
      intents: [],
      skills: [],
    });
  });
});
