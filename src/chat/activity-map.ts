/**
 * Шаг работы ассистента для клиента — из события `tool` релея.
 *
 * Релей (r.linkeon.io, server.mjs) на каждый вызов инструмента шлёт
 * `{type:'tool', tool:<имя>, input:<JSON аргументов, обрезанный до 300 символов>}`.
 * Наружу из этого уходит только код шага и, где это безопасно, короткое
 * уточнение. Команды, пути и телефон пользователя остаются на сервере.
 *
 * ВАЖНО: полей text/content/delta в событии нет и быть не должно. Flutter
 * (lib/services/chat_service.dart) берёт `content ?? text ?? delta` из любого
 * события, кроме begin/end, и вклеил бы шаг в текст ответа.
 *
 * Коды шагов — контракт с фронтом (spirits_front, components/chat/turnActivity.ts,
 * ACTIVITY_KINDS). Незнакомый код фронт показывает как `other`: расхождение
 * портит подпись, но не ломает чат.
 */

export type ActivityKind =
  | 'web_search' | 'web_fetch' | 'read_upload' | 'read_file' | 'write_file' | 'search_files'
  | 'compute' | 'image_generate' | 'image_edit' | 'video' | 'speech' | 'calendar_read'
  | 'calendar_propose' | 'routine' | 'notes' | 'messages_read' | 'message_send'
  | 'mail_read' | 'mail_send' | 'product' | 'other';

export interface ActivityEvent {
  type: 'activity';
  kind: ActivityKind;
  detail?: string;
}

export interface ActivityOwner {
  userId: string;
  /** Ключ сессии релея: с него начинается имя загруженного файла на диске релея. */
  relaySessionId?: string;
}

const BY_NAME: Record<string, ActivityKind> = {
  Glob: 'search_files',
  Grep: 'search_files',
  mcp__linkeon__generate_image: 'image_generate',
  mcp__linkeon__generate_banner: 'image_generate',
  mcp__linkeon__edit_image: 'image_edit',
  mcp__linkeon__compose_image: 'image_edit',
  mcp__linkeon__upscale_image: 'image_edit',
  mcp__linkeon__generate_video: 'video',
  mcp__linkeon__generate_speech: 'speech',
  mcp__linkeon__read_calendar: 'calendar_read',
  mcp__linkeon__propose_calendar_event: 'calendar_propose',
  mcp__linkeon__manage_routine: 'routine',
  mcp__talerid__list_notes: 'notes',
  mcp__talerid__create_note: 'notes',
  mcp__talerid__update_note: 'notes',
  mcp__talerid__delete_note: 'notes',
  mcp__talerid__list_contacts: 'messages_read',
  mcp__talerid__list_conversations: 'messages_read',
  mcp__talerid__get_messages: 'messages_read',
  mcp__talerid__search_messages: 'messages_read',
  mcp__talerid__send_message: 'message_send',
  mcp__talerid__check_mail: 'mail_read',
  mcp__talerid__read_mail: 'mail_read',
  mcp__talerid__send_mail: 'mail_send',
  mcp__products__manage_product: 'product',
};

const DETAIL_MAX = 80;
const UPLOAD_DIR = '/tmp/agent-uploads/';
const OUTPUT_DIR = '/tmp/agent-output/';

/** Поле аргументов. input обрезан релеем — целиком он часто не разбирается. */
function inputField(raw: unknown, key: string): string | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  try {
    const v = JSON.parse(raw)?.[key];
    return typeof v === 'string' ? v : undefined;
  } catch {
    // Обрезанный JSON: достаём поле регуляркой, но только если строка успела
    // закрыться кавычкой. Оборванное посередине значение не показываем.
    const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(raw);
    if (!m) return undefined;
    try {
      return JSON.parse(`"${m[1]}"`);
    } catch {
      return undefined;
    }
  }
}

function cleanDetail(s: string | undefined, userId: string): string | undefined {
  if (!s) return undefined;
  const one = s.replace(/\s+/g, ' ').trim();
  if (!one) return undefined;
  if (userId && one.includes(userId)) return undefined;
  return one.length > DETAIL_MAX ? `${one.slice(0, DETAIL_MAX - 1)}…` : one;
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.replace(/^www\./, '') || undefined;
  } catch {
    return undefined;
  }
}

/** Имя файла для показа, если его можно показать. */
function fileName(filePath: string, who: ActivityOwner): string | undefined {
  let base = filePath.slice(filePath.lastIndexOf('/') + 1);
  if (filePath.startsWith(UPLOAD_DIR)) {
    // Релей кладёт загрузку как `<ключ сессии>_<имя>` и меняет всё, кроме
    // [a-zA-Z0-9._-], на «_» (relay-agent/paths.mjs, uploadFileName).
    if (who.relaySessionId) {
      const prefix = `${who.relaySessionId.replace(/[^a-zA-Z0-9._-]/g, '_')}_`;
      if (base.startsWith(prefix)) base = base.slice(prefix.length);
    }
    // Кириллическое имя после релея — строка подчёркиваний («выписка.pdf» →
    // «_______.pdf»). Человеку оно ничего не скажет: лучше шаг без имени.
    const stem = base.replace(/\.[^.]*$/, '');
    if (!/[a-zA-Z0-9]/.test(stem) || /__/.test(stem)) return undefined;
  }
  return cleanDetail(base, who.userId);
}

export function toActivity(tool: unknown, rawInput: unknown, who: ActivityOwner): ActivityEvent | null {
  if (typeof tool !== 'string' || !tool) return null;
  const ev = (kind: ActivityKind, detail?: string): ActivityEvent =>
    detail ? { type: 'activity', kind, detail } : { type: 'activity', kind };

  switch (tool) {
    case 'WebSearch':
      return ev('web_search', cleanDetail(inputField(rawInput, 'query'), who.userId));
    case 'WebFetch':
      return ev('web_fetch', cleanDetail(hostOf(inputField(rawInput, 'url')), who.userId));
    case 'Read': {
      const p = inputField(rawInput, 'file_path');
      if (p?.startsWith(UPLOAD_DIR)) return ev('read_upload', fileName(p, who));
      if (p?.startsWith(OUTPUT_DIR)) return ev('read_file', fileName(p, who));
      return ev('read_file');
    }
    case 'Write':
    case 'Edit': {
      const p = inputField(rawInput, 'file_path');
      return ev('write_file', p?.startsWith(OUTPUT_DIR) ? fileName(p, who) : undefined);
    }
    case 'Bash': {
      // «sleep 4» — повтор подключения MCP по инструкции релея. Системный
      // промпт релея прямо запрещает показывать эту кухню пользователю.
      const cmd = inputField(rawInput, 'command');
      if (cmd && /^\s*sleep\s+\d+(\.\d+)?\s*$/.test(cmd)) return null;
      return ev('compute');
    }
    default:
      return ev(BY_NAME[tool] ?? 'other');
  }
}
