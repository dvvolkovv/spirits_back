/**
 * Человеческая причина, по которой встреча Meet не состоялась.
 *
 * Эту строку видит человек: она уезжает в `voice_calls.fail_reason` через
 * `backend.failed()` и показывается в чате как «Звонок не состоялся: …».
 * Поэтому она обязана называть ПРИЧИНУ, а не состояние бота.
 *
 * До 09.09.2026 здесь было `бот Attendee: ${state}`, и оба живых прогона
 * закончились строкой «бот Attendee: fatal_error» — одинаковой и для «никто
 * не нажал Впустить», и для «Chrome упал». Настоящая причина лежала в логах
 * контейнера: `event_sub_type: request_to_join_denied`.
 *
 * Коды — из `bots/models.py`, `BotEventSubTypes` у Attendee. Здесь только те,
 * что случаются в Google Meet: Zoom-специфичные (`zoom_*`, `obf token`) стали
 * бы мёртвым кодом до задачи про Zoom, а незнакомый код и так отдаётся как
 * есть — потерять его нельзя.
 */

const REASONS: Record<string, string> = {
  // Самый частый и самый безобидный случай: хозяин встречи не заметил стук.
  request_to_join_denied: 'во встречу так и не впустили',
  waiting_room_timeout_exceeded: 'из комнаты ожидания так и не впустили',
  meeting_not_started_waiting_for_host: 'встреча ещё не началась',
  meeting_not_found: 'встреча не найдена — проверьте ссылку',
  unable_to_connect_to_meeting: 'не удалось подключиться к встрече',
  // Meet иногда требует вход в аккаунт Google — для анонимного бота это стоп.
  login_required: 'встреча только для участников с аккаунтом Google',
  bot_login_attempt_failed: 'не удалось войти в аккаунт Google',
  blocked_by_captcha: 'Google показал проверку и не пустил бота',
  // Наши же предохранители, выставленные в automatic_leave_settings.
  auto_leave_max_uptime_exceeded: 'достигнут потолок длительности встречи',
  // Поломки на стороне моста. Человеку важно отличать их от «не впустили»:
  // здесь виноваты мы, и повтор имеет смысл.
  process_terminated: 'мост встреч перезапустился',
  bot_not_launched: 'бот встречи не запустился',
  heartbeat_timeout: 'бот встречи перестал отвечать',
  ui_element_not_found: 'Meet изменил вёрстку — бот не нашёл кнопку',
  attendee_internal_error: 'внутренняя ошибка моста встреч',
  out_of_credits: 'у моста встреч закончились лимиты',
  global_runtime_timeout: 'бот встречи работал слишком долго и был остановлен',
};

/**
 * Собрать причину для `backend.failed()`.
 *
 * Код всегда остаётся в строке в скобках: перевод — для человека, код — для
 * того, кто будет разбираться по логам. Незнакомый код отдаётся как есть,
 * потому что молча превратить его в «что-то пошло не так» значит потерять
 * единственную зацепку.
 */
export function botFailureReason(state: string, sub?: string): string {
  const known = sub ? REASONS[sub] : undefined;
  if (known) return `${known} (${sub})`;
  if (sub) return `бот Attendee: ${state} (${sub})`;
  return `бот Attendee: ${state}`;
}
