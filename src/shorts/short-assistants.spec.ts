import { assistantVoice, disclaimerFor, isHealthAssistant } from './short-assistants';

describe('ассистенты в роликах', () => {
  it('голос — тот же, что у ассистента по умолчанию', () => {
    expect(assistantVoice('Алексей')).toBe('madirus');
    expect(assistantVoice('Кира')).toBe('marina');
  });

  it('незнакомый ассистент — голос по умолчанию, а не ошибка', () => {
    expect(assistantVoice('Новенький')).toBe('alena');
  });

  it('строка о специалисте — юристу, бухгалтеру, финансам и здоровью', () => {
    expect(disclaimerFor('Алексей')).toBe('Ответ ИИ, не заменяет юриста');
    expect(disclaimerFor('Анна')).toBe('Ответ ИИ, не заменяет бухгалтера');
    expect(disclaimerFor('Виталий')).toBe('Ответ ИИ, не заменяет финансового консультанта');
    expect(disclaimerFor('Полина')).toBe('Ответ ИИ, не заменяет врача');
    expect(disclaimerFor('Кира')).toBeUndefined();
  });

  it('темы здоровья — у Полины и Шанкары', () => {
    expect(isHealthAssistant('Полина')).toBe(true);
    expect(isHealthAssistant('Шанкара')).toBe(true);
    expect(isHealthAssistant('Алексей')).toBe(false);
  });
});
