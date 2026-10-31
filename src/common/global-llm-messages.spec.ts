import { mskStamp, reminderText, switchedText } from './global-llm-messages';

describe('тексты рубильника', () => {
  it('mskStamp — дд.мм чч:мм по Москве', () => {
    expect(mskStamp('2026-10-31T13:40:00Z')).toBe('31.10 16:40');
  });

  it('переключение на Qwen — с кем было и кто, подсказка как вернуть', () => {
    const t = switchedText('claude', 'qwen', 'admin-1');
    expect(t).toContain('Модель ответов для всех: Qwen');
    expect(t).toContain('было Claude');
    expect(t).toContain('Переключил: admin-1');
    expect(t).toContain('Админка → Ассистенты');
  });

  it('возврат на Claude — «все снова на Claude»', () => {
    expect(switchedText('qwen', 'claude', 'admin-1')).toContain('Все снова отвечают через Claude');
  });

  it('актор экранируется для HTML', () => {
    expect(switchedText('claude', 'qwen', '<b>x</b>')).toContain('&lt;b&gt;x&lt;/b&gt;');
  });

  it('напоминание: модель, с какого момента, дни, состояние Claude', () => {
    const t = reminderText({
      provider: 'qwen', since: '2026-10-29T07:00:00Z', now: new Date('2026-10-31T07:00:00Z'),
      claudeStatus: 'ok', claudeCheckedAt: '2026-10-31T06:45:00Z', keyMissing: false,
    });
    expect(t).toContain('Все отвечают через Qwen');
    expect(t).toContain('с 29.10 10:00');
    expect(t).toContain('(2 дн.)');
    expect(t).toContain('Claude по последней пробе: отвечает (31.10 09:45)');
    expect(t).not.toContain('ключа');
  });

  it('напоминание: Claude не отвечает; нет ключа — фактически Claude', () => {
    const t = reminderText({
      provider: 'kimi', since: null, now: new Date('2026-10-31T07:00:00Z'),
      claudeStatus: 'down', claudeCheckedAt: null, keyMissing: true,
    });
    expect(t).toContain('Claude по последней пробе: не отвечает');
    expect(t).toContain('Ключа Kimi на сервере нет — фактически отвечает Claude, гостям пробы — экран входа.');
  });

  it('напоминание: нет данных пробы', () => {
    const t = reminderText({ provider: 'qwen', since: null, now: new Date(), claudeStatus: null, claudeCheckedAt: null, keyMissing: false });
    expect(t).toContain('Claude по последней пробе: нет данных');
  });

  it('напоминание: счёт за сутки — ответов через модель рубильника и сколько раз она не ответила', () => {
    const t = reminderText({
      provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
      day: { ok: 120, other: 3 },
    });
    expect(t).toContain('За сутки через Qwen: 120 вызовов (ответы людям и фоновые задачи); не ответила, ответил другой — 3');
  });

  it('напоминание: счёта нет (сбой запроса) — строки нет', () => {
    const t = reminderText({ provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false, day: null });
    expect(t).not.toContain('За сутки');
  });
});
