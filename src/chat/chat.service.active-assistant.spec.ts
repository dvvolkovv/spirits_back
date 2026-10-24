import { ChatService } from './chat.service';

/** Конструктор ChatService тянет 26 зависимостей — для метода над activeTurns он не нужен. */
const withTurns = (turns: Array<[string, number]>) => {
  const svc = Object.create(ChatService.prototype) as ChatService;
  (svc as any).activeTurns = new Map(turns);
  return svc;
};

describe('ChatService.activeAssistantFor — чей ход сейчас идёт', () => {
  it('ассистент самого свежего хода этого пользователя', () => {
    expect(withTurns([['u1_12', 100], ['u1_22', 200], ['u2_13', 300]]).activeAssistantFor('u1')).toBe('22');
  });

  it('обычное имя ассистента — не custom, без двоеточия', () => {
    expect(withTurns([['u1_some_agent', 1]]).activeAssistantFor('u1')).toBe('some_agent');
  });

  it('кастомный ассистент — id целиком, с двоеточием', () => {
    expect(withTurns([['u1_custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc', 5]]).activeAssistantFor('u1'))
      .toBe('custom:3f2b9c1e-1111-4a2b-9c3d-123456789abc');
  });

  it('хода нет — null', () => {
    expect(withTurns([['u2_13', 300]]).activeAssistantFor('u1')).toBeNull();
  });

  it('префикс не путает пользователей: u1 и u11', () => {
    expect(withTurns([['u11_12', 500]]).activeAssistantFor('u1')).toBeNull();
  });
});
