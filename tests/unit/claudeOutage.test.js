/**
 * Unit-тест классификатора ошибок LLM-пробы (claude-health.classifyLlmError).
 * Инцидент 2026-06-07: весь AI лёг из-за «weekly limit» Claude-подписки, а
 * мониторинг молчал. Liveness-проба теперь это ловит — пинит, что главные
 * формулировки сбоев распознаются (особенно недельный лимит).
 * Inline-копия логики (как остальные unit-тесты в этом каталоге).
 */
function classifyLlmError(msg) {
  const m = String(msg || '').toLowerCase();
  if (/weekly limit|hit your .*limit|usage limit|limit .*reset|limit reached|исчерпан.*лимит|недельн/.test(m))
    return { kind: 'weekly_limit' };
  if (/rate limit|too many requests|\b429\b/.test(m)) return { kind: 'rate_limit' };
  if (/unauthorized|\b401\b|invalid api key|authentication|oauth|credential|not logged in|please run .*login/.test(m))
    return { kind: 'auth' };
  if (/overloaded|\b529\b|\b503\b|internal server|try again|temporarily/.test(m))
    return { kind: 'overloaded' };
  if (/timeout|timed out|deadline/.test(m)) return { kind: 'timeout' };
  return { kind: 'other' };
}

describe('classifyLlmError', () => {
  test('недельный лимит подписки (главный кейс инцидента)', () => {
    expect(classifyLlmError("You've hit your weekly limit · resets 12pm (UTC)").kind).toBe('weekly_limit');
    expect(classifyLlmError('Usage limit reached, resets later').kind).toBe('weekly_limit');
    expect(classifyLlmError('на сегодня исчерпан дневной лимит').kind).toBe('weekly_limit');
  });
  test('rate limit / 429', () => {
    expect(classifyLlmError('rate limit exceeded').kind).toBe('rate_limit');
    expect(classifyLlmError('HTTP 429 Too Many Requests').kind).toBe('rate_limit');
  });
  test('сбой авторизации', () => {
    expect(classifyLlmError('401 Unauthorized').kind).toBe('auth');
    expect(classifyLlmError('invalid api key').kind).toBe('auth');
    expect(classifyLlmError('OAuth token expired, please run /login').kind).toBe('auth');
  });
  test('перегрузка/временная недоступность', () => {
    expect(classifyLlmError('Overloaded (529)').kind).toBe('overloaded');
    expect(classifyLlmError('internal server error, try again').kind).toBe('overloaded');
  });
  test('таймаут', () => {
    expect(classifyLlmError('claude CLI timeout after 30000ms').kind).toBe('timeout');
  });
  test('прочее по умолчанию', () => {
    expect(classifyLlmError('weird unexpected thing').kind).toBe('other');
    expect(classifyLlmError('').kind).toBe('other');
  });
});
