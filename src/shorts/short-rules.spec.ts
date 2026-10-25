import { RulesInput, checkScriptRules, estimateSpeechSec, numbersIn } from './short-rules';
import { ShortScript } from './shorts.types';

const paragraphs = [
  { n: 1, text: 'Залог возвращается в течение 7 дней после выезда.' },
  { n: 2, text: 'Опасная фраза: «залог не возвращается при досрочном выезде».' },
  { n: 3, text: 'Нормальный износ не является повреждением — впишите это в договор.' },
];

function script(over: Partial<ShortScript> = {}): ShortScript {
  return {
    hook: 'Хозяин может оставить залог себе?',
    hookBox: 2,
    voice: 'madirus',
    speed: 1.1,
    lines: [
      { id: 'h', scene: 'hook', text: 'Хозяин может оставить залог себе?' },
      { id: 'q', scene: 'question', text: 'Я Алексей, юрист. Меня спросили, как снять квартиру и не потерять залог при выезде.' },
      { id: 'a1', scene: 'answer', box: 2, text: 'Ищите в договоре опасную фразу: «залог не возвращается при досрочном выезде». Увидели — просите переписать этот пункт.' },
      { id: 'a2', scene: 'answer', box: 3, text: 'Впишите прямо: нормальный износ не является повреждением. Тогда за потёртый пол и выцветшие обои удержать деньги не получится.' },
      { id: 'a3', scene: 'answer', box: 1, text: 'И договоритесь о сроке: залог возвращается в течение 7 дней после выезда — так и запишите в договоре аренды.' },
      { id: 'f', scene: 'final', voice: 'alena', text: 'Линкеон — восемнадцать ассистентов. Ссылка — в описании и в профиле.' },
    ],
    final: { assistantsCount: 18, disclaimer: 'Ответ ИИ, не заменяет юриста' },
    ...over,
  };
}

const captions = {
  telegram: 'Юрист разобрал, как не потерять залог при аренде.',
  vk: 'Юрист разобрал, как не потерять залог при аренде.',
  youtube: { title: 'Как не потерять залог при аренде', description: 'Три пункта договора, которые сберегут залог.', tags: ['аренда', 'залог', 'юрист'] },
};

const input = (over: Partial<RulesInput> = {}): RulesInput => ({
  angle: 'uncomfortable',
  assistantName: 'Алексей',
  script: script(),
  captions,
  paragraphs,
  answerText: paragraphs.map((p) => p.text).join('\n'),
  assistantsCount: 18,
  ...over,
});

const withLine = (id: string, text: string): ShortScript => {
  const s = script();
  s.lines = s.lines.map((l) => (l.id === id ? { ...l, text } : l));
  if (id === 'h') s.hook = text;
  return s;
};

describe('checkScriptRules', () => {
  it('честный сценарий проходит без замечаний', () => {
    expect(checkScriptRules(input())).toEqual([]);
  });

  it('правило 1: числа, которого нет в ответе', () => {
    const s = withLine('a1', `${script().lines[2].text} Так делают 90 процентов хозяев.`);
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/правило 1: числа 90 нет в ответе/);
  });

  it('правило 1: число ассистентов и подарок новичку называть можно', () => {
    const c = { ...captions, telegram: 'Тут 18 ассистентов, новичку — 25 000 токенов.' };
    expect(checkScriptRules(input({ captions: c }))).toEqual([]);
  });

  it.each([
    ['правила 2 и 7', 'Лучше, чем ChatGPT.'],
    ['правило 3', 'Всё анонимно.'],
    ['правило 4', 'Найдите вторую половинку.'],
    ['правило 5', 'Наши агенты помогут.'],
    ['правило 6', 'Попробуйте бесплатно.'],
    ['правило 7', 'Юля тоже так советовала.'],
    ['правило 11', 'Как санкции влияют на аренду.'],
    ['правило 12', 'Иначе вы умрёте от стресса.'],
    ['правило 13', 'Квартиры на Авито.'],
    ['правило 14', 'Только идиот подпишет такое.'],
    ['правило 14', 'Смешно смотреть на тех, кто до сих пор не пользуется ассистентами.'],
    ['правило 15', 'Как не платить налоги с аренды.'],
  ])('%s: «%s»', (rule, phrase) => {
    const c = { ...captions, telegram: `${captions.telegram} ${phrase}` };
    expect(checkScriptRules(input({ captions: c })).join('\n')).toContain(rule);
  });

  it('стоп-слова не цепляют похожие слова: агентство, сбережения, трамплин, богатый', () => {
    const c = { ...captions, telegram: `${captions.telegram} Без агентства, сбережения целы, трамплин для богатых.` };
    expect(checkScriptRules(input({ captions: c }))).toEqual([]);
  });

  it('правило 8: реплика ответа без опоры на снятый абзац', () => {
    const s = script();
    s.lines = s.lines.map((l) => (l.id === 'a1' ? { ...l, box: 9 } : l));
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/правило 8: реплика a1/);
  });

  it('правило 9: зацепка утверждает чувство зрителя', () => {
    expect(checkScriptRules(input({ script: withLine('h', 'Вы боитесь потерять залог') })).join('\n')).toMatch(/правило 9/);
  });

  it('правило 9: тот же страх вопросом — можно', () => {
    expect(checkScriptRules(input({ script: withLine('h', 'Боитесь потерять залог?') }))).toEqual([]);
  });

  it('правило 10: у провокационной зацепки обязательна опора', () => {
    expect(checkScriptRules(input({ script: script({ hookBox: undefined }) })).join('\n')).toMatch(/правило 10: .*hookBox/);
    expect(checkScriptRules(input({ angle: 'calm', script: script({ hookBox: undefined }) }))).toEqual([]);
    expect(checkScriptRules(input({ script: script({ hookBox: 7 }) })).join('\n')).toMatch(/hookBox 7/);
  });

  it('правило 12: здоровье — только спокойной подачей', () => {
    expect(checkScriptRules(input({ assistantName: 'Полина' })).join('\n')).toMatch(/правило 12: темы здоровья/);
    expect(checkScriptRules(input({ assistantName: 'Полина', angle: 'calm' }))).toEqual([]);
  });

  it('зацепка длиннее восьми слов', () => {
    const s = withLine('h', 'раз два три четыре пять шесть семь восемь девять');
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/длиннее 8 слов/);
  });

  it('название сервиса в репликах — только в финале', () => {
    const s = withLine('q', `${script().lines[1].text} Это Линкеон.`);
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/только в финале/);
  });

  it('длина: короче 32 с и длиннее 55 с', () => {
    const short = script();
    short.lines = short.lines
      .filter((l) => l.id !== 'a3')
      .map((l) => (l.scene === 'answer' ? { ...l, text: 'Коротко.' } : l));
    expect(checkScriptRules(input({ script: short })).join('\n')).toMatch(/добавь реплику/);
    const long = script();
    long.lines = long.lines.map((l) => (l.scene === 'answer' ? { ...l, text: l.text.repeat(3) } : l));
    expect(checkScriptRules(input({ script: long })).join('\n')).toMatch(/сократи реплики/);
  });

  it('реплик ответа — от двух до четырёх', () => {
    const s = script();
    s.lines = s.lines.filter((l) => l.id !== 'a2' && l.id !== 'a3');
    expect(checkScriptRules(input({ script: s })).join('\n')).toMatch(/реплик ответа 1/);
  });
});

describe('numbersIn и estimateSpeechSec', () => {
  it('числа с пробелами тысяч и десятичные — одной записью', () => {
    expect(numbersIn('залог 25 000 ₽ за 1,5 месяца и 7 дней')).toEqual(['25000', '1.5', '7']);
  });

  it('образец укладывается в коридор оценки', () => {
    const sec = estimateSpeechSec(script());
    expect(sec).toBeGreaterThan(32);
    expect(sec).toBeLessThan(55);
  });
});
