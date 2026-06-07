/**
 * Unit-tests for shouldSkipTaskExtraction — локальный фильтр, отсекающий
 * бытовые/короткие сообщения до LLM-вызова в TasksService.extractFromTurn.
 *
 * Run: cd tests && npx jest unit/extract-prefilter
 */

// Inline copy of shouldSkipTaskExtraction from src/tasks/extract-prefilter.ts
// (тот же подход что в extractJsonObject.test.js — копия логики в тест,
// чтобы не тянуть TS-runtime для одного предиката).
const PROJECT_KEYWORDS = /(задач|план|сделат|запуст|настро|помоги|нужно|надо|кампани|пост|ролик|видео|реклам|подгот|клиент|проект|дедлайн|deadline|сроки|встреч|созвон|отчёт|отчет|отправ|написат|обсуди|договор|оплат|подпис|релиз|запуск|запушу|запушить)/i;
const PLEASANTRY = /^\s*(привет|здравств|спасибо|спасиб|пожалуйста|ок|окей|ага|да|нет|good|hi|hello|thanks|спс|ясно|понятно|круто|супер|👍|❤️)[!.\s]*$/i;
const SHORT_THRESHOLD = 25;

function shouldSkipTaskExtraction(message) {
  const trimmed = (message || '').trim();
  if (!trimmed) return true;
  if (PLEASANTRY.test(trimmed)) return true;
  if (trimmed.length < SHORT_THRESHOLD && !PROJECT_KEYWORDS.test(trimmed)) return true;
  return false;
}

describe('shouldSkipTaskExtraction', () => {
  test('skip: greetings & pleasantries', () => {
    expect(shouldSkipTaskExtraction('привет')).toBe(true);
    expect(shouldSkipTaskExtraction('спасибо!')).toBe(true);
    expect(shouldSkipTaskExtraction('Hello')).toBe(true);
    expect(shouldSkipTaskExtraction('ок')).toBe(true);
    expect(shouldSkipTaskExtraction('да')).toBe(true);
    expect(shouldSkipTaskExtraction('круто.')).toBe(true);
  });

  test('skip: empty and whitespace-only', () => {
    expect(shouldSkipTaskExtraction('')).toBe(true);
    expect(shouldSkipTaskExtraction('   ')).toBe(true);
    expect(shouldSkipTaskExtraction(null)).toBe(true);
    expect(shouldSkipTaskExtraction(undefined)).toBe(true);
  });

  test('skip: short messages without project signals', () => {
    expect(shouldSkipTaskExtraction('а что дальше?')).toBe(true);
    expect(shouldSkipTaskExtraction('не знаю')).toBe(true);
  });

  test('keep: messages with project signals', () => {
    expect(shouldSkipTaskExtraction('запусти кампанию на следующей неделе')).toBe(false);
    expect(shouldSkipTaskExtraction('нужно сделать пост к понедельнику')).toBe(false);
    expect(shouldSkipTaskExtraction('помоги настроить рекламу для нового клиента')).toBe(false);
    expect(shouldSkipTaskExtraction('у нас дедлайн в пятницу по отчёту')).toBe(false);
    expect(shouldSkipTaskExtraction('надо подготовить ролик')).toBe(false);
  });

  test('keep: длинные сообщения без явных ключей (на всякий случай не отсеиваем)', () => {
    const longMsg = 'ну вот думаю как лучше подойти к ситуации с командой, потому что они все разные и каждый со своим характером, надо как-то синхронизировать процессы';
    expect(shouldSkipTaskExtraction(longMsg)).toBe(false);
  });

  test('keep: короткое но содержит проектный ключ', () => {
    expect(shouldSkipTaskExtraction('запуск завтра')).toBe(false);
    expect(shouldSkipTaskExtraction('видео в среду')).toBe(false);
  });
});
