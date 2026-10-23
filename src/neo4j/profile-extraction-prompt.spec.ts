import { buildProfileExtractionPrompt } from './profile-extraction-prompt';

describe('buildProfileExtractionPrompt', () => {
  const prompt = buildProfileExtractionPrompt('прошлая реплика', 'реплика пользователя', 'ответ ассистента');
  // Слова проверяются в строке правила, а не во всём промпте: «вес» — подстрока «весь», «сон» — «персональный».
  const healthRule = prompt.split('\n').find((l) => l.includes('сведения о здоровье и теле пользователя')) ?? '';

  it('промпт запрещает извлекать сведения о здоровье и теле — в любую категорию', () => {
    expect(healthRule).not.toBe('');
    for (const word of ['болезни', 'симптомы', 'диагнозы', 'лекарства', 'беременность', 'вес', 'сон', 'пищеварение', 'доша', 'конституция']) {
      expect(healthRule).toContain(word);
    }
    expect(healthRule).toContain('ни в одну категорию — ни как интерес, ни как желание');
    expect(healthRule).toContain('остальное из той же реплики извлекай как обычно');
  });

  it('интерес к теме без сведений о своём здоровье извлекать можно', () => {
    expect(healthRule).toContain('Интерес к теме, который ничего не говорит о здоровье самого пользователя («интересуюсь аюрведой», «увлекаюсь бегом»), извлекать можно.');
  });

  it('правило о здоровье стоит в списке «НЕ извлекай», до правила 4', () => {
    const notBlock = prompt.indexOf('3. НЕ извлекай если:');
    const health = prompt.indexOf('сведения о здоровье и теле пользователя');
    const rule4 = prompt.indexOf('4. Лучше пропустить');
    expect(notBlock).toBeGreaterThan(-1);
    expect(health).toBeGreaterThan(notBlock);
    expect(health).toBeLessThan(rule4);
  });

  it('прежние правила, категории и формат ответа на месте', () => {
    for (const phrase of [
      'Извлеки психологический профиль ТОЛЬКО на основе того, что ЯВНО говорит сам пользователь о себе.',
      '1. Источник извлечения — ИСКЛЮЧИТЕЛЬНО реплика пользователя.',
      '(а) пользователь прямо говорит о себе',
      '(б) пользователь явно соглашается с конкретным утверждением',
      '- пользователь только задаёт вопросы или просит что-то посчитать/объяснить',
      '- реплика нейтральная, без самораскрытия и без явного согласия',
      '- пользователь выражает сомнение, частичное согласие или возражение',
      '- ассистент сделал предположение, а пользователь его не подтвердил',
      '4. Лучше пропустить, чем приписать пользователю то, чего он явно не утверждал.',
      '- interests —',
      '- values —',
      '- desires —',
      '- beliefs —',
      '- intents —',
      '- skills —',
      '{"interests":[],"values":[],"desires":[],"beliefs":[],"intents":[],"skills":[]}',
      'Если пользователь не сказал и явно не согласился ни с чем — верни все массивы пустыми.',
    ]) {
      expect(prompt).toContain(phrase);
    }
  });

  it('каждая реплика — в своём блоке, в прежнем порядке', () => {
    const p = buildProfileExtractionPrompt('<<PREV>>', '<<USER>>', '<<CUR>>');
    const at = ['Предыдущая реплика ассистента', '<<PREV>>', 'Реплика пользователя (', '<<USER>>', 'Текущая реплика ассистента', '<<CUR>>'].map((m) => p.indexOf(m));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
  });

  it('реплики режутся по прежним лимитам: 3000, 3000, 1500', () => {
    const p = buildProfileExtractionPrompt('п'.repeat(5000), 'у'.repeat(5000), 'а'.repeat(5000));
    expect(p).toContain('п'.repeat(3000));
    expect(p).not.toContain('п'.repeat(3001));
    expect(p).toContain('у'.repeat(3000));
    expect(p).not.toContain('у'.repeat(3001));
    expect(p).toContain('а'.repeat(1500));
    expect(p).not.toContain('а'.repeat(1501));
  });

  it('нет прошлой реплики (null или пустая строка — так её отдаёт сервис) — пометка начала диалога', () => {
    expect(buildProfileExtractionPrompt(null, 'u', 'a')).toContain('(пусто — начало диалога)');
    expect(buildProfileExtractionPrompt('', 'u', 'a')).toContain('(пусто — начало диалога)');
  });
});
