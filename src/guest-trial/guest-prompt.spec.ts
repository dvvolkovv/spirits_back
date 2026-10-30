import { LANGUAGE_REPLY_LINE } from '../common/services/language.service';
import { ANSWER_FIRST_RULE } from '../chat/answer-first-rule';
import { GUEST_MODE_BLOCK, buildGuestPrompt, buildGuestSystemPrompt, localTimeLine } from './guest-prompt';

const base = { name: 'Роман', description: 'персональный ассистент', persona: 'Ты Роман. Помогаешь с делами.', lang: 'ru' };

describe('системный промпт гостя', () => {
  it('имя, персона, правило ответа и блок пробного режима — на месте', () => {
    const sys = buildGuestSystemPrompt(base);
    expect(sys).toContain('**Роман** — персональный ассистент');
    expect(sys).toContain('Ты Роман. Помогаешь с делами.');
    expect(sys).toContain(ANSWER_FIRST_RULE);
    expect(sys).toContain(GUEST_MODE_BLOCK);
  });

  it('последняя строка — требование языка гостя', () => {
    const sys = buildGuestSystemPrompt({ ...base, lang: 'en' });
    expect(sys.trimEnd().endsWith(LANGUAGE_REPLY_LINE.en.trim())).toBe(true);
  });

  it('незнакомый язык — русский', () => {
    const sys = buildGuestSystemPrompt({ ...base, lang: 'xx' });
    expect(sys.trimEnd().endsWith(LANGUAGE_REPLY_LINE.ru.trim())).toBe(true);
  });

  it('ни профиля, ни баланса, ни адресов кабинета', () => {
    const sys = buildGuestSystemPrompt(base);
    expect(sys).not.toMatch(/Профиль пользователя|User profile|баланс|токен|my\.linkeon\.io/i);
  });

  it('время — только для правдоподобного пояса', () => {
    const now = new Date('2026-10-30T12:00:00Z');
    expect(localTimeLine('Europe/Moscow', now)).toContain('Europe/Moscow');
    expect(localTimeLine('../../etc', now)).toBeNull();
    expect(localTimeLine(undefined, now)).toBeNull();
    expect(buildGuestSystemPrompt({ ...base, tz: 'Europe/Moscow', now })).toContain('--- Время человека ---');
  });
});

describe('тело промпта', () => {
  it('без истории — одна реплика', () => {
    expect(buildGuestPrompt([], 'Привет')).toBe('USER: Привет');
  });
  it('с историей — пары по порядку, новая реплика последней', () => {
    const p = buildGuestPrompt(
      [{ sender_type: 'human', content: 'Вопрос' }, { sender_type: 'ai', content: 'Ответ' }],
      'Ещё вопрос',
    );
    expect(p).toBe('USER: Вопрос\n\nASSISTANT: Ответ\n\nUSER: Ещё вопрос');
  });
});
