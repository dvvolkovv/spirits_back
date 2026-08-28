import { isPrivateConfig } from './tg-chat-kind';

describe('isPrivateConfig', () => {
  it('положительный tg_chat_id — личный чат', () => {
    expect(isPrivateConfig({ tg_chat_id: '123456789' } as any)).toBe(true);
  });

  it('отрицательный tg_chat_id — группа', () => {
    expect(isPrivateConfig({ tg_chat_id: '-5218835753' } as any)).toBe(false);
  });

  it('пустой tg_chat_id (pending-конфиг) — не личный', () => {
    expect(isPrivateConfig({ tg_chat_id: null } as any)).toBe(false);
  });
});
