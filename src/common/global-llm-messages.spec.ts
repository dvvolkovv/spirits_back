import { cliOutageAffectedText, cliRecoveredText, maskActor, mskStamp, reminderText, switchedText } from './global-llm-messages';

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

/**
 * Строка «Затронуто» в алерте «Локальный Claude CLI недоступен» (повторное
 * ревью 01.11, I1). Три состояния модели рубильника: на Claude или без ключа —
 * прежний список и проба без входа; с ключом и отвечает — через неё идут Маша,
 * TG-боты и фоновые; с ключом, но «не отвечает» — выбор рубильника её
 * пропускает (planProviders с respectDown), и они идут обычным путём (Claude,
 * затем запасные).
 */
describe('cliOutageAffectedText', () => {
  const ON_CLAUDE =
    'Затронуто: <b>Маша, TG-боты, Виртуальный PM, Виртуальный маркетолог, фоновые задачи</b> (CLI-путь на OAuth-подписке) ' +
    'и <b>проба без входа</b> (новым гостям — стена «войдите»).';

  it('рубильник на Claude — прежний список и проба без входа', () => {
    expect(cliOutageAffectedText({ switchProvider: 'claude', enabled: false, down: false })).toBe(ON_CLAUDE);
  });

  it('модель рубильника без ключа — тот же текст (вошедшие фактически на Claude, гостям пробы — стена), даже с пометкой «не отвечает»', () => {
    expect(cliOutageAffectedText({ switchProvider: 'kimi', enabled: false, down: false })).toBe(ON_CLAUDE);
    expect(cliOutageAffectedText({ switchProvider: 'kimi', enabled: false, down: true })).toBe(ON_CLAUDE);
  });

  it('модель рубильника с ключом и отвечает — затронуты пробы, личный выбор Claude и запасной путь', () => {
    expect(cliOutageAffectedText({ switchProvider: 'qwen', enabled: true, down: false })).toBe(
      'Затронуто: пробы мониторинга, личный выбор Claude и запасной путь — рубильник сейчас на <b>Qwen</b>: ' +
        'Маша, TG-боты и фоновые задачи отвечают через эту модель.',
    );
  });

  it('модель рубильника с ключом, но «не отвечает» — Маша и остальные идут обычным путём (Claude, затем запасные)', () => {
    expect(cliOutageAffectedText({ switchProvider: 'qwen', enabled: true, down: true })).toBe(
      'Затронуто: <b>Маша, TG-боты, Виртуальный PM, Виртуальный маркетолог, фоновые задачи</b> (CLI-путь на OAuth-подписке) — ' +
        'рубильник на <b>Qwen</b>, но Qwen сейчас «не отвечает», поэтому они идут обычным путём (Claude, затем запасные).',
    );
  });

  it('подпись — по модели рубильника', () => {
    expect(cliOutageAffectedText({ switchProvider: 'kimi', enabled: true, down: false })).toContain('рубильник сейчас на <b>Kimi</b>');
    expect(cliOutageAffectedText({ switchProvider: 'kimi', enabled: true, down: true })).toContain('но Kimi сейчас «не отвечает»');
  });

  it('probeFailed — не утверждает реальный breaker или fallback', () => {
    const text = cliOutageAffectedText({ switchProvider: 'kimi', enabled: true, down: false, probeFailed: true });
    expect(text).toContain('контрольная проба Kimi не удалась');
    expect(text).not.toContain('поэтому они идут обычным путём');
  });

  it('providerUnverified — новый провайдер не объявляется проверенным', () => {
    const text = cliOutageAffectedText({ switchProvider: 'qwen', enabled: true, down: false, providerUnverified: true });
    expect(text).toContain('активная проба Qwen в этом тике не выполнялась');
    expect(text).not.toContain('отвечают через эту модель');
  });
});

/**
 * Отбой «Локальный Claude CLI восстановлен» (повторное ревью 01.11, M4): при
 * рубильнике на живой модели с ключом Маша, TG-боты и фоновые всё время
 * работали через неё — «снова работают» было бы неправдой.
 */
describe('cliRecoveredText', () => {
  const at = '2026-11-01T07:15:00.000Z';
  const OLD = `<b>🟢 Локальный Claude CLI восстановлен</b>\nМаша/VPM/маркетолог снова работают (проверка: ${at}, 812мс).`;

  it('рубильник на живой модели с ключом — Claude снова отвечает, Маша и остальные сейчас через рубильник, как вернуть', () => {
    expect(cliRecoveredText({ switchProvider: 'qwen', enabled: true, down: false, checkedAt: at, latencyMs: 812 })).toBe(
      '<b>🟢 Локальный Claude CLI восстановлен</b>\n' +
        `Claude снова отвечает (проверка: ${at}, 812мс): пробы мониторинга, личный выбор Claude, запасной путь. ` +
        'Маша, TG-боты и фоновые задачи сейчас идут через Qwen (рубильник).\n' +
        'Вернуть рубильник на Claude: Админка → Ассистенты.',
    );
  });

  it('рубильник на Claude — прежний текст', () => {
    expect(cliRecoveredText({ switchProvider: 'claude', enabled: false, down: false, checkedAt: at, latencyMs: 812 })).toBe(OLD);
  });

  it('модель рубильника без ключа — прежний текст', () => {
    expect(cliRecoveredText({ switchProvider: 'kimi', enabled: false, down: false, checkedAt: at, latencyMs: 812 })).toBe(OLD);
  });

  it('модель рубильника «не отвечает» — прежний текст: Маша и остальные шли через Claude и были задеты', () => {
    expect(cliRecoveredText({ switchProvider: 'qwen', enabled: true, down: true, checkedAt: at, latencyMs: 812 })).toBe(OLD);
  });

  it('нет данных проверки — прочерки, как раньше', () => {
    expect(cliRecoveredText({ switchProvider: 'claude', enabled: false, down: false, checkedAt: null, latencyMs: null })).toBe(
      '<b>🟢 Локальный Claude CLI восстановлен</b>\nМаша/VPM/маркетолог снова работают (проверка: —, —мс).',
    );
  });

  it('probeFailed при recovery — Claude восстановлен, проба Kimi не удалась', () => {
    const text = cliRecoveredText({
      switchProvider: 'kimi', enabled: true, down: false, probeFailed: true,
      checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
    });
    expect(text).toContain('Claude снова отвечает');
    expect(text).toContain('контрольная проба Kimi не удалась');
    expect(text).not.toContain('Маша/VPM/маркетолог снова работают');
  });

  it('providerUnverified при recovery — без healthy-текста нового провайдера', () => {
    const text = cliRecoveredText({
      switchProvider: 'qwen', enabled: true, down: false, providerUnverified: true,
      checkedAt: '2026-11-11T07:15:00.000Z', latencyMs: 812,
    });
    expect(text).toContain('Claude снова отвечает');
    expect(text).toContain('активная проба Qwen в этом тике не выполнялась');
    expect(text).not.toContain('Маша/VPM/маркетолог снова работают');
  });
});
