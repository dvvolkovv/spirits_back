import { maskActor, mskStamp, reminderText, switchedText } from './global-llm-messages';

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

  it('переключение — актор-телефон маскируется в сообщении для группы', () => {
    const t = switchedText('claude', 'qwen', '70001112233');
    expect(t).toContain('Переключил: …2233');
    expect(t).not.toContain('70001112233');
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

  it('напоминание: счёт за сутки — три числа, без гостей — без скобки', () => {
    const t = reminderText({
      provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
      day: { answered: 120, byOther: 3, failed: 5, guests: 0 },
    });
    expect(t).toContain('За сутки через Qwen: ответила — 120; ответил другой — 3; без ответа — 5.');
    expect(t).not.toContain('из них гостям');
  });

  it('напоминание: счёт за сутки — гости в скобке', () => {
    const t = reminderText({
      provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
      day: { answered: 120, byOther: 3, failed: 5, guests: 2 },
    });
    expect(t).toContain('За сутки через Qwen: ответила — 120; ответил другой — 3; без ответа — 5 (из них гостям — 2).');
  });

  it('напоминание: счёта нет (сбой запроса) — строки нет', () => {
    const t = reminderText({ provider: 'qwen', since: null, now: new Date(), claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false, day: null });
    expect(t).not.toContain('За сутки');
  });

  it('напоминание: меньше суток — в часах, не днях', () => {
    const t = reminderText({
      provider: 'qwen', since: '2026-11-01T05:00:00Z', now: new Date('2026-11-01T10:00:00Z'),
      claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
    });
    expect(t).toContain('(5 ч)');
    expect(t).not.toContain('дн.');
  });

  it('напоминание: since в будущем (рассинхрон часов) — не уходит в минус', () => {
    const t = reminderText({
      provider: 'qwen', since: '2026-11-01T10:00:00Z', now: new Date('2026-11-01T09:00:00Z'),
      claudeStatus: 'ok', claudeCheckedAt: null, keyMissing: false,
    });
    expect(t).toContain('(0 ч)');
  });
});

describe('maskActor', () => {
  it('телефон — … и последние 4 цифры', () => {
    expect(maskActor('70001112233')).toBe('…2233');
  });

  it('UUID (вход по почте/OAuth) — первые 8 символов', () => {
    expect(maskActor('3f2b9c1e-8a4d-4e6f-9b0a-1c2d3e4f5a6b')).toBe('3f2b9c1e');
  });

  it('не похоже ни на телефон, ни на UUID (служебный id) — без изменений', () => {
    expect(maskActor('admin-1')).toBe('admin-1');
    expect(maskActor('unknown')).toBe('unknown');
  });
});
