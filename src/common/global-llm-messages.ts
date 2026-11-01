import { AnswerProvider, FallbackProvider, PROVIDER_LABELS } from './services/llm-fallback';

/**
 * дд.мм чч:мм по Москве.
 *
 * Собирается вручную по частям Intl.DateTimeFormat (day/month/hour/minute),
 * а не через toLocaleString('ru-RU', …) + replace(','): CLDR для ru-RU в
 * разных версиях ICU (мак у разработчика vs full-icu на тестовой ноде)
 * вставляет между датой и временем то запятую, то неразрывный пробел (U+00A0)
 * — replace(',', '') снимает только запятую и не трогает такой пробел, и
 * строгое toBe в тесте падает не из-за логики, а из-за пунктуации хоста.
 * formatToParts отдаёт голые числовые значения частей независимо от
 * локального пунктуатора — собираем формат сами, фиксированными '.' и ':'.
 */
const MSK_STAMP_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Moscow',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function mskStamp(at: string | Date): string {
  const d = typeof at === 'string' ? new Date(at) : at;
  const parts = MSK_STAMP_PARTS.formatToParts(d);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}.${part('month')} ${part('hour')}:${part('minute')}`;
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PHONE_RE = /^\+?\d{7,15}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * userId в сообщении для группы алертов — не светить целиком (ревью 01.11):
 * телефон — только последние 4 цифры («…2233»), UUID (вход по почте/OAuth —
 * userId для таких аккаунтов это UUID) — только первые 8 символов. Что не
 * похоже ни на одно (служебные/тестовые id вида 'admin-1', 'unknown') — без
 * изменений: это не пользовательский идентификатор, скрывать нечего.
 */
export function maskActor(actor: string): string {
  if (PHONE_RE.test(actor)) return `…${actor.replace(/\D/g, '').slice(-4)}`;
  if (UUID_RE.test(actor)) return actor.slice(0, 8);
  return actor;
}

/** Сообщение в группу алертов при переключении рубильника (spec 2026-10-31-global-llm-switch, раздел 8). */
export function switchedText(previous: AnswerProvider, next: AnswerProvider, actor: string): string {
  const head = `🔀 <b>Модель ответов для всех: ${PROVIDER_LABELS[next]}</b> (было ${PROVIDER_LABELS[previous]}).`;
  const tail = next === 'claude' ? 'Все снова отвечают через Claude.' : 'Вернуть — Админка → Ассистенты.';
  return `${head}\nПереключил: ${escapeHtml(maskActor(actor))}. ${tail}`;
}

/**
 * Состояние модели общего рубильника для алерта о падении Claude CLI и его
 * отбоя (повторное ревью 01.11). enabled — у модели есть ключ на сервере
 * (fallbackStats().providers[x].enabled — тот же признак, что
 * configs[x] !== null); down — она «не отвечает», и выбор рубильника её
 * пропускает (planProviders с respectDown). У Claude оба поля не значат ничего.
 */
export interface CliSwitchState {
  switchProvider: AnswerProvider;
  enabled: boolean;
  down: boolean;
}

/** Маша, TG-боты и фоновые задачи сейчас отвечают через модель рубильника, а не через Claude CLI. */
const switchCarriesCliPath = (s: CliSwitchState): boolean => s.switchProvider !== 'claude' && s.enabled && !s.down;

const CLI_PATH_USERS = 'Маша, TG-боты, Виртуальный PM, Виртуальный маркетолог, фоновые задачи';

/**
 * Строка «Затронуто» алерта «Локальный Claude CLI недоступен». Рубильник на
 * Claude или у его модели нет ключа (вошедшие фактически на Claude, гостям
 * пробы — стена) — прежний список и проба без входа. Модель с ключом
 * отвечает — через неё идут Маша, TG-боты и фоновые, а падение Claude
 * задевает пробы мониторинга (они всегда Claude), личный выбор Claude и
 * запасной путь. Модель с ключом, но «не отвечает» — они идут обычным путём
 * (Claude, затем запасные): ровно сценарий «Claude упёрся в недельный лимит →
 * рубильник на Qwen → у Qwen кончились кредиты».
 */
export function cliOutageAffectedText(s: CliSwitchState): string {
  const label = PROVIDER_LABELS[s.switchProvider];
  if (switchCarriesCliPath(s)) {
    return `Затронуто: пробы мониторинга, личный выбор Claude и запасной путь — рубильник сейчас на <b>${label}</b>: Маша, TG-боты и фоновые задачи отвечают через эту модель.`;
  }
  if (s.switchProvider !== 'claude' && s.enabled) {
    return `Затронуто: <b>${CLI_PATH_USERS}</b> (CLI-путь на OAuth-подписке) — рубильник на <b>${label}</b>, но ${label} сейчас «не отвечает», поэтому они идут обычным путём (Claude, затем запасные).`;
  }
  return `Затронуто: <b>${CLI_PATH_USERS}</b> (CLI-путь на OAuth-подписке) и <b>проба без входа</b> (новым гостям — стена «войдите»).`;
}

/**
 * Отбой «Локальный Claude CLI восстановлен». Пока модель рубильника с ключом
 * отвечает, Маша, TG-боты и фоновые всё время шли через неё — «снова
 * работают» было бы неправдой: ожил Claude для проб мониторинга, личного
 * выбора Claude и запасного пути; последняя строка — как вернуть рубильник
 * (как хвост switchedText). Иначе (рубильник на Claude, без ключа или его
 * модель «не отвечает» — они шли через Claude и были задеты) — прежний текст.
 */
export function cliRecoveredText(a: CliSwitchState & { checkedAt: string | null; latencyMs: number | null }): string {
  const head = '<b>🟢 Локальный Claude CLI восстановлен</b>\n';
  const check = `проверка: ${a.checkedAt || '—'}, ${a.latencyMs ?? '—'}мс`;
  if (switchCarriesCliPath(a)) {
    const label = PROVIDER_LABELS[a.switchProvider];
    return `${head}Claude снова отвечает (${check}): пробы мониторинга, личный выбор Claude, запасной путь. Маша, TG-боты и фоновые задачи сейчас идут через ${label} (рубильник).\nВернуть рубильник на Claude: Админка → Ассистенты.`;
  }
  return `${head}Маша/VPM/маркетолог снова работают (${check}).`;
}

/**
 * Суточный счёт по вызовам рубильника (choice='global', selected=эта
 * модель): answered — она ответила; byOther — ответил другой (аварийная
 * цепочка); failed — ВСЕГО без ответа (неудачные ходы веб-чата + ошибки
 * гостей о модели); guests — подмножество failed, сколько из них гостям (для
 * строки «из них гостям»).
 */
export interface GlobalLlmDayCounts {
  answered: number;
  byOther: number;
  failed: number;
  guests: number;
}

/** Суточное напоминание, пока рубильник не на Claude. */
export function reminderText(a: {
  provider: FallbackProvider;
  since: string | null;
  now: Date;
  claudeStatus: 'ok' | 'down' | null;
  claudeCheckedAt: string | null;
  keyMissing: boolean;
  day?: GlobalLlmDayCounts | null;
}): string {
  const label = PROVIDER_LABELS[a.provider];
  let since = '';
  if (a.since) {
    // Math.max(0, …): рассинхрон часов (или вызов до фактической записи в
    // тесте) не должен уйти в отрицательные дни/часы (ревью 01.11).
    const diffMs = Math.max(0, a.now.getTime() - new Date(a.since).getTime());
    const days = Math.floor(diffMs / 86_400_000);
    // Меньше суток — в часах («5 ч»), а не «0 дн.»: «0 дн.» ничего не
    // говорит о том, сколько именно времени прошло в первые сутки после
    // переключения.
    const period = days > 0 ? `${days} дн.` : `${Math.floor(diffMs / 3_600_000)} ч`;
    since = ` с ${mskStamp(a.since)} (${period})`;
  }
  const claude = a.claudeStatus === 'ok' ? 'отвечает' : a.claudeStatus === 'down' ? 'не отвечает' : 'нет данных';
  const checked = a.claudeCheckedAt ? ` (${mskStamp(a.claudeCheckedAt)})` : '';
  const lines = [
    `⏰ <b>Все отвечают через ${label}</b>${since}.`,
    `Claude по последней пробе: ${claude}${checked}.`,
  ];
  if (a.day) {
    const guestsNote = a.day.guests > 0 ? ` (из них гостям — ${a.day.guests})` : '';
    lines.push(
      `За сутки через ${label}: ответила — ${a.day.answered}; ответил другой — ${a.day.byOther}; без ответа — ${a.day.failed}${guestsNote}.`,
    );
  }
  if (a.keyMissing) lines.push(`Ключа ${label} на сервере нет — фактически отвечает Claude, гостям пробы — экран входа.`);
  lines.push('Вернуть — Админка → Ассистенты.');
  return lines.join('\n');
}
