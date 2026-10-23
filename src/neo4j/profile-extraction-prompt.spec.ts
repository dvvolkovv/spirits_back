import { buildProfileExtractionPrompt } from './profile-extraction-prompt';

describe('buildProfileExtractionPrompt', () => {
  const prompt = buildProfileExtractionPrompt('прошлая реплика', 'реплика пользователя', 'ответ ассистента');

  it('не переносит в профиль сведения о здоровье и теле', () => {
    expect(prompt).toContain('сведения о здоровье и теле пользователя');
    for (const word of ['болезни', 'симптомы', 'диагнозы', 'лекарства', 'беременность', 'вес', 'сон', 'пищеварение', 'доша', 'конституция']) {
      expect(prompt).toContain(word);
    }
  });

  it('интерес к теме извлекать можно', () => {
    expect(prompt).toContain('Интерес к теме («интересуюсь аюрведой») извлекать можно.');
  });

  it('правило о здоровье стоит в списке «НЕ извлекай», до правила 4', () => {
    const notBlock = prompt.indexOf('3. НЕ извлекай если:');
    const health = prompt.indexOf('сведения о здоровье и теле пользователя');
    const rule4 = prompt.indexOf('4. Лучше пропустить');
    expect(notBlock).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(notBlock);
    expect(health).toBeLessThan(rule4);
  });

  it('прежние правила и формат ответа на месте', () => {
    expect(prompt).toContain('Извлеки психологический профиль ТОЛЬКО на основе того, что ЯВНО говорит сам пользователь о себе.');
    expect(prompt).toContain('1. Источник извлечения — ИСКЛЮЧИТЕЛЬНО реплика пользователя.');
    expect(prompt).toContain('{"interests":[],"values":[],"desires":[],"beliefs":[],"intents":[],"skills":[]}');
    expect(prompt).toContain('Если пользователь не сказал и явно не согласился ни с чем — верни все массивы пустыми.');
  });

  it('реплики подставляются и режутся по прежним лимитам: 3000, 3000, 1500', () => {
    const p = buildProfileExtractionPrompt('п'.repeat(5000), 'у'.repeat(5000), 'а'.repeat(5000));
    expect(p).toContain('п'.repeat(3000));
    expect(p).not.toContain('п'.repeat(3001));
    expect(p).toContain('у'.repeat(3000));
    expect(p).not.toContain('у'.repeat(3001));
    expect(p).toContain('а'.repeat(1500));
    expect(p).not.toContain('а'.repeat(1501));
  });

  it('нет прошлой реплики — пометка начала диалога', () => {
    expect(buildProfileExtractionPrompt(null, 'u', 'a')).toContain('(пусто — начало диалога)');
  });
});
