import express from "express";
import multer from "multer";
import cors from "cors";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { spawn, execSync } from "child_process";
import { sessionFsKey, uploadFileName, fallbackFileName } from "./paths.mjs";

const app = express();
const PORT = 3033;
const UPLOAD_DIR = "/tmp/agent-uploads";
const OUTPUT_DIR = "/tmp/agent-output";

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use("/files", express.static(OUTPUT_DIR));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
});

const SYSTEM_PROMPT = `You are a universal agent on an Ubuntu 24.04 server. You can do ANYTHING.
Full sudo access (no password). Install anything you need.

IMPORTANT: You are in WEB MODE. NEVER use telegram or ToolSearch. The ONLY MCP tools you may use are the linkeon ones listed below (mcp__linkeon__*). All other MCP/plugin tools are forbidden. Otherwise use: Bash, Read, Write, Edit, Glob, Grep, WebSearch, WebFetch.

ВНУТРЕННЯЯ КУХНЯ НЕВИДИМА: подключение/переподключение инструментов, повторные попытки, служебные ошибки — пользователь НЕ должен их видеть. Никогда не пиши «инструмент не подключился / подключаю / переподключаю / пересоздаю». Если mcp__linkeon__* инструмент не готов на первом шаге — молча «sleep 4» и повтори тот же вызов один раз; пользователю показывай только конечный результат.

УТОЧНЯЮЩИЕ ВОПРОСЫ: если нужно что-то уточнить у пользователя — задай вопрос и НЕМЕДЛЕННО заверши ход: не вызывай инструменты, не продолжай работу и не отвечай на свой вопрос сам. Пользователь физически может ответить только ПОСЛЕ завершения твоего хода — вопрос посреди работы он видит, но ответить не может. Либо спроси в самом начале и остановись, либо прими разумное допущение, доделай работу и в конце явно назови принятое допущение, предложив поправить.

ЯЗЫК (ВАЖНО): Всегда отвечай на языке пользователя и держи ОДИН язык на весь ответ — от первого слова до последнего. Если пользователь пишет по-русски, ВЕСЬ твой ответ на русском, включая самые первые фразы; НЕ вставляй английские слова или фразы, не начинай по-английски. Это касается и ВСЕХ промежуточных реплик, статусов и комментариев МЕЖДУ вызовами инструментов — каждая такая реплика тоже строго на языке пользователя, ни одной английской фразы вроде «I'll…», «Let me…», «Now I…». Смешение языков в одном ответе недопустимо (пользователи на это жалуются).

PRE-INSTALLED: ffmpeg, ImageMagick, LibreOffice, Inkscape, poppler-utils
Python 3.12 venv: source /home/dv/agent-env/bin/activate
  (rembg, Pillow, python-pptx, python-docx, reportlab, cairosvg)

INSTALL ANYTHING MISSING: apt, pip, npm, wget — whatever it takes.

IMAGE GENERATION (ABSOLUTE RULE):
When user asks to generate/create/draw/make an image, picture, illustration, logo, banner, poster, photo:
1. PREFER the MCP tool: mcp__linkeon__generate_image with arguments { userId: "<the user phone provided in the system context>", prompt: "english prompt", quality: "hd" or "std" }. quality="hd" gives Nano Banana Pro (best for text/cyrillic, costs 10000 tokens); "std" is Nano Banana 2 (5000 tokens). Result.imageUrl is an https URL — you MUST embed it on its own line as ![](THE_URL) so the user actually sees the image. This is the ONLY way an MCP-generated image reaches the user, so NEVER just write "файл прикреплён ниже" for an MCP image — always output the ![](url).
1b. For BANNERS/POSTERS/COVERS WITH READABLE TEXT (заголовок, слоган, призыв, надпись на картинке): PREFER mcp__linkeon__generate_banner with { userId, prompt: "english description of the BACKGROUND scene only, NO text", title, subtitle, cta, aspect_ratio: "1:1"|"9:16"|"16:9", position: "top"|"center"|"bottom", theme: "dark"|"light", quality: "hd"|"std" }. Text is overlaid programmatically so Cyrillic is always perfect — use this instead of baking text into generate_image.
2. For EDITING an existing generated image (изменить, заменить, поправить, "сделай небо закатным") use mcp__linkeon__edit_image with sourceImageUrl from the previous tool result.
3. To COMBINE multiple images into one ("посади меня на трон", "соедини X и Y") use mcp__linkeon__compose_image with 2-3 sourceImageUrls.
4. To enhance/sharpen an image ("улучши качество", "сделай чётче") use mcp__linkeon__upscale_image.
5. The linkeon MCP tools connect a few seconds AFTER startup, so on an image-first request the mcp__linkeon__* tools may not be available on your very first step. If a mcp__linkeon__* tool is not available yet, run the Bash command "sleep 4" ONCE and then try the SAME mcp tool again. Use the local fallback ONLY if it is STILL unavailable after that retry: /home/dv/agent-env/bin/generate_image.sh "english prompt" /path/to/output.png (Pollinations). The fallback is much lower quality (no Imagen / Nano Banana, no perfect-text banners) and does not bill tokens — treat it as a true last resort, not a first choice.
6. NEVER use Pillow, matplotlib, cairo, or any code-based drawing for image GENERATION. Pillow is ONLY for editing pixels (crop, resize, rembg, text overlay, filters).
7. Translate the user request to English before passing to image-gen tools.

VIDEO GENERATION:
When the user asks for a video / animation / "оживи" image / "сделай видео":
1. Use mcp__linkeon__generate_video. For text→video pass { userId, mode: "text2video", prompt: "english", model: "kling-v1-6", duration: 5 }. For image→video pass { userId, mode: "image2video", prompt, sourceImageUrl, duration: 5 }.
2. The result contains a jobId — tell the user the job is queued and the video will appear in their chat shortly. Do NOT try to poll the job from here.

VOICE / SPEECH (озвучка текста):
When the user asks to voice something / "озвучь" / "прочитай вслух" / "наговори голосом" / "сделай аудио":
1. ALWAYS use mcp__linkeon__generate_speech with { userId, text: "<exact text to speak>", voice?: "<voice id>" }. NEVER generate audio locally (no Bash, no edge-tts, no ffmpeg) and NEVER save an mp3 to the output directory for speech — the platform attaches the player itself.
2. NEVER print a link to the audio and NEVER write "[Скачать ...](...)" for speech. The player appears in the user's chat automatically. Just say in one short sentence what you voiced.
3. The voice is free to choose and does NOT have to match your persona. For a dialogue or a scene with several characters, call the tool once per line with a different voice.
4. Russian voices: alena, jane, omazh, marina (female), zahar, filipp, ermil, madirus (male). Other languages: alloy, nova, shimmer (female), echo, onyx, fable (male). Never invent voice ids.
5. Limits: 2000 characters per call for Russian, 4000 for other languages. On text_too_long shorten the text or split it into several calls. If the tool returns an error, tell the user that error in plain words and do NOT claim the audio is being prepared.

RULES:
1. Do whatever the user asks. Be resourceful.
2. If creating files, save them to the output directory specified.
3. ALWAYS verify output files are valid and can be opened.
4. For pptx: use python-pptx, keep simple, validate with soffice --headless --convert-to pdf.
5. If something fails, try a different approach.
6. LANGUAGE: ALWAYS respond in Russian (русский) by default — это русскоязычные пользователи. Even when tool outputs, file paths, English prompts, or system messages contain English — твой ответ пользователю всегда на русском. Switch to another language ТОЛЬКО если пользователь явно пишет тебе на нём целиком. Никогда не давай ответ на английском, если юзер написал по-русски — даже частично. NEVER mention any specific platform/product name (Linkeon, Taler, etc.) — be neutral, ты универсальный ассистент.
7. When you create output files, briefly describe WHAT you created (filename + content + size). DO NOT print absolute paths or URLs (no /tmp/..., /files/..., http://..., etc.) — the platform automatically attaches the files as clickable download links right after your message. Saying "here are the files: /tmp/..." just confuses the user.
8. FILENAMES: ASCII ONLY. Use only [a-z0-9_-] for file and directory names. NEVER use Cyrillic, spaces, or non-ASCII characters in filenames. Translate Russian to English transliteration before saving ("барнхаус" → "barnhouse"). Reason: filenames flow through HTTP without escaping.
9. NEVER print URLs or filesystem paths in your response. The platform handles file delivery — just save files to the provided output directory and describe them in plain language. If the user asks "where are the files?", answer "файлы прикреплены ниже" (or English equivalent). EXCEPTION: image URLs returned by mcp__linkeon__* image/banner tools MUST be embedded as ![](url) — that markdown is how the user sees generated images, so it is required, not a forbidden "path".

RECURRING / ROUTINE REQUESTS: Если пользователь просит присылать или напоминать что-то РЕГУЛЯРНО (каждый день, по утрам, каждое утро, ежедневно) — ты РЕАЛЬНО можешь это настроить: вызови mcp__linkeon__manage_routine с { userId, action: "enable", assistant: "<твоё имя, напр. Райя>", hour: <локальный час 0..23, утро=8>, prompt: "<что именно генерировать и присылать каждый день, от первого лица>" }. Чтобы выключить — action: "disable". ВАЖНО: НЕ говори "буду присылать / настроил", пока не вызвал инструмент и не получил ok:true. Если ответ содержит delivered_hint:true — тактично попроси пользователя включить уведомления в Настройках (тумблер «Уведомления на этом устройстве»), иначе рутина не дойдёт.

ДЕЛА И СОБЫТИЯ В КАЛЕНДАРЬ: Если в разговоре появляется что-то, что стоит запланировать, ПРЕДЛОЖИ карточкой: mcp__linkeon__propose_calendar_event с { userId, title, kind, note и ОДНИМ способом времени (datetime / recurrence+datetime / dates) }. ⚠️ ВЫБОР kind КРИТИЧЕН: kind="task" — для ДЕЛ/НАПОМИНАНИЙ/ЧЕКЛИСТОВ/ПРИВЫЧЕК (уход за кожей, приём средств/лекарств, зарядка, «позвонить»), даже если у них есть время и повтор — они отмечаются галочкой и НЕ занимают блок времени; для повтора передавай recurrence+datetime, длительность НЕ указывай. kind="event" — ТОЛЬКО настоящая встреча/приём/звонок с временем И длительностью (durationMin). Регулярные дела «утром и вечером каждый день» (например уход) — это ЗАДАЧИ с recurrence, ОДНОЙ карточкой на серию, а НЕ куча событий. Никогда не превращай чеклист-по-расписанию в события.
ПРОЧИТАТЬ КАЛЕНДАРЬ: Если пользователь спрашивает про своё расписание/занятость, что запланировано, когда была встреча или СКОЛЬКО ВРЕМЕНИ он потратил на что-то — вызови mcp__linkeon__read_calendar с { userId, from, to } (from/to — ISO-даты локально, напр. "2026-08-04".."2026-08-11"; период вычисли сам из текущей даты). Вернётся список событий с durationMin — по нему считай суммарные часы. Не выдумывай события — бери только из результата инструмента.

kind: 'task' — ДЕЛО/задача, которую можно «выполнить» и отметить галочкой (собрать вещи, купить подарок, подготовить документы) → раздел «Мои дела». 'event' — ВСТРЕЧА/звонок/приём/занятие/дедлайн с конкретным временем (по умолчанию).

ВРЕМЯ для kind='event' — задай РОВНО ОДНИМ способом:
• datetime — одно событие. Локальное ISO без зоны, напр. "2026-08-17T09:45:00". durationMin — длительность, мин (по умолч. 60).
• recurrence — РЕГУЛЯРНО повторяющаяся серия (каждый будний день, каждый понедельник, ежедневно N раз). Передай datetime = старт ПЕРВОГО занятия + recurrence:{ freq:"weekly"|"daily", byDay:["MO","TU","WE","TH","FR"] (для weekly), interval (по умолч.1), и РОВНО ОДНО из count (сколько раз) или until ("2026-08-28", по эту дату включительно) }.
• dates — НЕрегулярные конкретные даты: массив локальных ISO, напр. ["2026-08-05T15:00:00","2026-08-12T15:00:00"].

КРИТИЧЕСКИ ВАЖНО:
1. На повторяющийся/множественный запрос ВЫЗОВИ ИНСТРУМЕНТ ОДИН РАЗ с recurrence или dates — НЕ создавай по карточке на каждую дату. Одна карточка = вся серия, пользователь подтверждает одним нажатием.
2. Инструмент только ПРЕДЛАГАЕТ. ok:true значит «карточка-предложение готова», НЕ «добавлено». Событие попадёт в календарь ТОЛЬКО когда пользователь сам нажмёт «Добавить» на карточке. Поэтому:
   — НИКОГДА не пиши «готово / добавил / поставил / запланировал / создал / внёс».
   — НЕ начинай ответ со слова «Готово» (даже «Готово! Подготовил…») — это читается как «уже в календаре».
   — ПРАВИЛЬНО: начни с «Подготовил карточку…» / «Держи карточку…» и заверши «— нажми Добавить, и <событие/серия> встанет в календарь». Пример: «Подготовил две карточки-серии — по одной на каждый блок. Нажми «Добавить» на каждой, и занятия встанут в календарь.»
3. Если инструмент ещё не подключился (ответ вроде «tool not available / not connected») — это нормально, он поднимается через пару секунд после старта. МОЛЧА выполни Bash «sleep 4» и повтори ТОТ ЖЕ вызов ОДИН раз. НИКОГДА не пиши пользователю «инструмент не подключился / подключаю / переподключаю / пересоздаю карточки» — это внутренняя кухня, пользователь её видеть не должен. Сообщай только про РЕАЛЬНУЮ ошибку (если и после повтора не ok:true), и без технических деталей.
4. Если connected:false — календарь не подключён: тактично предложи подключить его, чтобы планировать через Линкеон.
`;

const sessionMap = new Map();

// ── Персист карты сессий ─────────────────────────────────────────────────────
// sessionMap живёт в памяти, и до этой правки ЛЮБОЙ рестарт релея обнулял её
// целиком: все пользователи разом теряли --resume и начинали claude-сессию с
// нуля. 11.08.2026 один плановый выкат сбросил 91 сессию — в том числе
// многодневную работу юриста над 144-страничной апелляционной жалобой.
// Потери не видно ни в одном логе: ассистент просто перестаёт помнить, о чём
// шла речь, а пользователь думает, что он «поглупел».
//
// Файл рядом с кодом, а не в /tmp: tmpfs чистится при перезагрузке, и смысл
// персиста пропал бы ровно там, где он нужнее всего.
const SESSION_STORE_PATH = "/home/dv/file-agent/sessions.json";

function loadSessionMap() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SESSION_STORE_PATH, "utf8"));
  } catch {
    return; // файла нет (первый запуск) или он битый — начинаем с чистой карты
  }
  if (!raw || typeof raw !== "object") return;
  let restored = 0;
  let dropped = 0;
  for (const [sid, claudeSid] of Object.entries(raw)) {
    if (typeof claudeSid !== "string" || !claudeSid) continue;
    // Транскрипт мог быть удалён (ротация, чистка диска) — тогда --resume
    // упадёт «No conversation found» на ПЕРВОМ же сообщении пользователя.
    // Дешевле отбросить запись сейчас, чем ронять ход потом.
    if (!fs.existsSync(sessionJsonlPath(claudeSid))) { dropped++; continue; }
    sessionMap.set(sid, claudeSid);
    restored++;
  }
  console.log("sessions restored: " + restored + (dropped ? ", dropped (нет транскрипта): " + dropped : ""));
}

// Запись пачкой: ev.session_id приходит в КАЖДОМ событии стрима, и писать файл
// на каждое означало бы сотни записей в секунду на ровном месте.
let persistTimer = null;
function scheduleSessionPersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try {
      // Через временный файл + rename: rename атомарен, поэтому падение посреди
      // записи не оставит обрезанный JSON, из которого не поднимется ни одна
      // сессия.
      const tmp = SESSION_STORE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(sessionMap)));
      fs.renameSync(tmp, SESSION_STORE_PATH);
    } catch (e) {
      console.log("sessions persist failed: " + e.message);
    }
  }, 2000);
  // unref: незаконченный таймер не должен держать процесс при остановке.
  if (persistTimer.unref) persistTimer.unref();
}

/** Запомнить claude-сессию. Пишем на диск только когда значение реально сменилось. */
function rememberSession(sid, claudeSid) {
  if (sessionMap.get(sid) === claudeSid) return;
  sessionMap.set(sid, claudeSid);
  scheduleSessionPersist();
}

/** Забыть сессию (ротация по размеру, сброс из-за перегруза картинками). */
function forgetSession(sid) {
  if (!sessionMap.has(sid)) return;
  sessionMap.delete(sid);
  scheduleSessionPersist();
}

// Сохранить немедленно, не дожидаясь таймера: pm2 restart шлёт SIGINT/SIGTERM,
// и без этого последние 2 секунды изменений терялись бы при каждом выкате.
function persistNow() {
  try {
    fs.writeFileSync(SESSION_STORE_PATH, JSON.stringify(Object.fromEntries(sessionMap)));
  } catch { /* остановке помешать не можем */ }
}
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => { persistNow(); process.exit(0); });
}

// Ротация раздутых сессий: бесконечный --resume копит мегабайты английского
// тул-вывода (JSONL до 20+ МБ) → постоянная авто-компакция, падение качества
// и языковые утечки. При превышении порога начинаем свежую Claude-сессию,
// передав хвост диалога в промпт для непрерывности.
const SESSION_ROTATE_BYTES = 4 * 1024 * 1024;
const sessionJsonlPath = (claudeSid) => "/home/dv/.claude/projects/-tmp/" + claudeSid + ".jsonl";

// Поднимаем карту сессий с диска. Строго ЗДЕСЬ, а не выше: loadSessionMap
// проверяет наличие транскриптов через sessionJsonlPath, а он объявлен const —
// не поднимается, и вызов раньше упал бы в temporal dead zone.
loadSessionMap();

function extractTailDialogue(claudeSid, maxMsgs = 30, maxCharsPerMsg = 1500) {
  try {
    const lines = fs.readFileSync(sessionJsonlPath(claudeSid), "utf8").split("\n");
    const msgs = [];
    for (let i = lines.length - 1; i >= 0 && msgs.length < maxMsgs; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type !== "user" && ev.type !== "assistant") continue;
      const m = ev.message;
      if (!m) continue;
      let text = "";
      if (typeof m.content === "string") text = m.content;
      else if (Array.isArray(m.content)) {
        text = m.content
          .filter((b) => b && b.type === "text" && typeof b.text === "string")
          .map((b) => b.text)
          .join(" ");
      }
      text = (text || "").trim();
      if (!text) continue; // tool_result / tool_use-only строки
      msgs.push((ev.type === "user" ? "Пользователь: " : "Ассистент: ") + text.slice(0, maxCharsPerMsg));
    }
    return msgs.reverse().join("\n");
  } catch {
    return "";
  }
}

// Tracks the live `claude` child process per sessionId. When a new /chat
// request arrives for an already-active sessionId, the old child is killed
// before spawning the new one — otherwise multiple `claude --resume <same>`
// processes race on the same JSONL session lock and none make progress.
// Common case: backend hits its 15-min hard-timeout, user retries from the
// app, backend dispatches again — without dedup we'd get N parallel claudes.
const activeChildren = new Map();

// ── Agent-direct TalerID (notes + messages) ──────────────────────────────────
// Enabled per-request only when the backend passes a per-user TalerID access
// token (the user connected the ecosystem). Calendar is intentionally EXCLUDED
// (it stays on the backend-mediated propose_calendar_event card flow); mail is a
// later slice. These are the exact tool names from the TalerID contract.
const BASE_MCP_PATH = "/home/dv/file-agent/empty-mcp.json";
const TALERID_TOOLS = [
  "mcp__talerid__list_notes", "mcp__talerid__create_note", "mcp__talerid__update_note", "mcp__talerid__delete_note",
  "mcp__talerid__list_contacts", "mcp__talerid__list_conversations", "mcp__talerid__get_messages", "mcp__talerid__search_messages", "mcp__talerid__send_message",
  "mcp__talerid__check_mail", "mcp__talerid__read_mail", "mcp__talerid__send_mail",
].join(",");

const TALERID_PROMPT = `

ЭКОСИСТЕМА TALERID (заметки, сообщения и почта) — ДОСТУПНА В ЭТОМ РАЗГОВОРЕ:
Пользователь подключил TalerID, и тебе доступны инструменты mcp__talerid__* для его ЗАМЕТОК, СООБЩЕНИЙ и ПОЧТЫ.
Это ЯВНОЕ исключение к правилу «только mcp__linkeon__*»: mcp__talerid__* тоже разрешены — но ТОЛЬКО перечисленные ниже.
В отличие от linkeon-инструментов, talerid-инструменты работают от лица уже авторизованного пользователя —
НЕ передавай в них userId/phone, только их собственные аргументы.

ЗАМЕТКИ:
- mcp__talerid__list_notes { limit?, offset? } — список заметок.
- mcp__talerid__create_note { title, content } — создать заметку (поле source НЕ передавай — оно
  проставляется само).
- mcp__talerid__update_note { id, title?, content? } — изменить (id из list_notes).
- mcp__talerid__delete_note { id } — удалить (только по явной просьбе).

СООБЩЕНИЯ:
- mcp__talerid__list_contacts {} — контакты пользователя (даёт contact_id для отправки).
- mcp__talerid__list_conversations {} — список диалогов.
- mcp__talerid__get_messages { conversation_id, cursor?, limit? } — прочитать переписку.
- mcp__talerid__search_messages { query } — поиск по сообщениям (query ≥ 2 символов).
- mcp__talerid__send_message { contact_id, text } — отправить сообщение. Только существующему контакту
  (сервер это проверяет и откажет чужим). Перед отправкой КОРОТКО подтверди у пользователя, кому и что шлём.

ПОЧТА (адрес @talerid.io пользователя):
- mcp__talerid__check_mail { limit? } — последние письма (превью; limit 1..20, по умолч. 5).
- mcp__talerid__read_mail { uid } — прочитать письмо целиком (uid берётся из check_mail).
- mcp__talerid__send_mail { to, subject, text } — отправить письмо с адреса @talerid.io пользователя.
  ⚠️ Письмо уходит СРАЗУ. Перед вызовом ОБЯЗАТЕЛЬНО покажи пользователю кому (to), тему и текст и получи
  явное «да». Не отправляй без подтверждения. Ошибки объясняй по-человечески: no_mailbox_yet — ящик ещё
  заводится, попробовать чуть позже; daily_send_limit_reached — исчерпан дневной лимит писем; mail_unavailable
  — временный сбой почты.

ГРАНИЦЫ:
- КАЛЕНДАРЬ через talerid НЕ трогай. События планируй ТОЛЬКО карточкой mcp__linkeon__propose_calendar_event.
- Честность: «сделал / создал / отправил» — ТОЛЬКО после того как инструмент вернул успех. Ошибку
  инструмента не выдавай за успех и не показывай пользователю служебный текст ошибки — объясни по-человечески.
`;

app.post("/chat", upload.array("files", 10), (req, res) => {
  const { message, sessionId: reqSessionId } = req.body;
  // Модель хода. По умолчанию "default" (рекомендуемая CLI — сейчас Opus 5).
  // Бэкенд просит "haiku" для пингов мониторинга: smoke и synthetic-runner
  // проверяют живость пути, а не качество ответа, а обвязка Claude Code
  // (системный промпт + определения MCP-тулов, ~47k токенов) грузится на
  // каждый вызов независимо от содержания хода. Один «ответь ок» на Opus
  // стоил ~$0.20 против ~$0.02 на haiku, а таких пингов ~150 в сутки.
  // Белый список обязателен: значение уезжает в argv, телу запроса веры нет.
  const MODELS = ["default", "haiku", "sonnet", "opus"];
  const reqModel = MODELS.includes(String(req.body.model || "")) ? String(req.body.model) : "default";
  if (!message) return res.status(400).json({ error: "message is required" });

  const sessionId = reqSessionId || randomUUID();
  // sessionId остаётся логическим ключом сессии (sessionMap, activeChildren,
  // --resume), а на диск и в /files-ссылки уходит его санитизированная копия.
  // Для обычного "<телефон>_<n>" это та же строка, так что имена папок и
  // ссылок у живых сессий не меняются. См. relay-agent/paths.mjs.
  const fsKey = sessionFsKey(sessionId, randomUUID());
  const outDir = path.join(OUTPUT_DIR, fsKey);
  fs.mkdirSync(outDir, { recursive: true });

  const renamedFiles = [];
  if (req.files && req.files.length > 0) {
    for (const f of req.files) {
      const newPath = path.join(UPLOAD_DIR, uploadFileName(f.originalname, fsKey));
      try {
        fs.renameSync(f.path, newPath);
        renamedFiles.push({ path: newPath, name: f.originalname, size: f.size });
      } catch (e) {
        const fallback = path.join(UPLOAD_DIR, fallbackFileName(f.originalname, fsKey, randomUUID()));
        try {
          fs.renameSync(f.path, fallback);
          renamedFiles.push({ path: fallback, name: f.originalname, size: f.size });
        } catch (e2) {
          try { fs.unlinkSync(f.path); } catch {}
        }
      }
    }
  }

  let prompt = "";
  if (renamedFiles.length > 0) {
    prompt += "User uploaded files:\n";
    for (const f of renamedFiles) prompt += "- " + f.path + " (name: " + f.name + ", " + f.size + " bytes)\n";
    prompt += "\n";
  }
  prompt += "Output directory for created files: " + outDir + "\n\n";

  // Backend sends sessionId like "<phone>_<n>" (e.g. "79030169187_12").
  // Surface the phone to the agent so linkeon MCP tools can pass it as userId.
  const _sidStr = String(sessionId);
  const _phonePart = _sidStr.split("_")[0];
  if (/^\d{10,15}$/.test(_phonePart)) {
    prompt += "Current user phone (use as the `userId` argument for any mcp__linkeon__* tool call): " + _phonePart + "\n\n";
  }

  prompt += message;

  // Пер-ходовое напоминание языка: system prompt разбавляется огромным контекстом
  // resumed-сессий (мегабайты английского тул-вывода), и модель съезжает на
  // английский в промежуточных репликах. Напоминание в каждом ходе держит язык.
  if (/[А-Яа-яЁё]/.test(String(message))) {
    prompt += "\n\n[Служебное напоминание: отвечай ТОЛЬКО по-русски. Все промежуточные реплики и статусы между вызовами инструментов — тоже строго по-русски, без единой английской фразы.]";
  }

  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  res.write("data: " + JSON.stringify({ type: "session", sessionId }) + "\n\n");

  // Heartbeat every 30s while the request is in flight. Keeps the upstream
  // backend's idle-timer armed during long quiet phases (claude --resume on a
  // fat JSONL, Pollinations image gen, soffice convert). Cleared on res close
  // and on res.end below.
  let _hbDone = false;
  const _hb = setInterval(() => {
    if (_hbDone) return;
    try { res.write("data: " + JSON.stringify({ type: "heartbeat" }) + "\n\n"); } catch {}
  }, 30000);
  const stopHeartbeat = () => { _hbDone = true; clearInterval(_hb); };
  res.on("close", stopHeartbeat);

  // Track file mtimes before processing to detect new/changed files
  const filesBefore = new Map();
  if (fs.existsSync(outDir)) {
    const walkBefore = (dir, prefix) => {
      for (const item of fs.readdirSync(dir)) {
        const full = path.join(dir, item);
        const rel = prefix ? prefix + "/" + item : item;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) walkBefore(full, rel);
          else filesBefore.set(rel, stat.mtimeMs);
        } catch {}
      }
    };
    walkBefore(outDir, "");
  }

  // Per-request TalerID injection: default to linkeon-only; if the backend passed
  // a per-user token + MCP url, write a per-session MCP config (linkeon + talerid)
  // and widen allowedTools + system prompt to the notes/messages tools. Cleaned up
  // when the request finishes (see finally below). Falls back safely on any error.
  let mcpConfigPath = BASE_MCP_PATH;
  let allowedTools = "Bash(*),Read(*),Write(*),Edit(*),Glob(*),Grep(*),WebSearch(*),WebFetch(*),mcp__linkeon__generate_image,mcp__linkeon__edit_image,mcp__linkeon__compose_image,mcp__linkeon__upscale_image,mcp__linkeon__generate_video,mcp__linkeon__generate_banner,mcp__linkeon__manage_routine,mcp__linkeon__propose_calendar_event,mcp__linkeon__generate_speech,mcp__linkeon__read_calendar";
  let systemPrompt = SYSTEM_PROMPT;
  let taleridMcpPath = null;
  // Set when the agent uses a TalerID *write* tool this request. The transient
  // whole-turn retry below re-runs the turn, which would double-execute a write —
  // create_note dedups by title server-side, but send_message does NOT, so a retry
  // could double-send a message. When a write happened, we do NOT retry.
  let taleridWriteUsed = false;
  const TALERID_WRITE_RE = /mcp__talerid__(create_note|update_note|delete_note|send_message|send_mail)/;
  const _taleridToken = req.body.talerid_token;
  const _taleridMcpUrl = req.body.talerid_mcp_url;
  if (_taleridToken && _taleridMcpUrl && /^https:\/\//.test(_taleridMcpUrl)) {
    try {
      const base = JSON.parse(fs.readFileSync(BASE_MCP_PATH, "utf8"));
      base.mcpServers.talerid = { type: "http", url: _taleridMcpUrl, headers: { Authorization: "Bearer " + _taleridToken } };
      taleridMcpPath = path.join(UPLOAD_DIR, fsKey + "-talerid-mcp.json");
      fs.writeFileSync(taleridMcpPath, JSON.stringify(base), { mode: 0o600 });
      mcpConfigPath = taleridMcpPath;
      allowedTools += "," + TALERID_TOOLS;
      systemPrompt = SYSTEM_PROMPT + TALERID_PROMPT;
    } catch (e) {
      taleridMcpPath = null;
      mcpConfigPath = BASE_MCP_PATH;
      allowedTools = allowedTools.split("," + TALERID_TOOLS)[0];
      systemPrompt = SYSTEM_PROMPT;
    }
  }

  const args = [
    "--print",
    "--model", reqModel,
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--max-turns", "40",
    "--allowedTools", allowedTools,
    "--disallowedTools", "mcp__plugin_telegram_telegram__reply,mcp__plugin_telegram_telegram__react,mcp__plugin_telegram_telegram__edit_message,mcp__plugin_telegram_telegram__download_attachment,ToolSearch",
    "--mcp-config", mcpConfigPath,
    "--strict-mcp-config",
    "--system-prompt", systemPrompt,
  ];

  let clientDisconnected = false;
  // Уже отдали клиенту хоть один кусок текста в этом ходе? Тогда переигрывать
  // ход нельзя — ответ склеится со вторым и юзер прочитает одно и то же дважды.
  let streamedAny = false;
  // Ход закончился, не выдав финального ответа. Бэкенд по этому флагу не спишет
  // за него токены: пользователь не должен платить за пустоту.
  //
  // До этой правки три РАЗНЫЕ поломки выглядели для пользователя одинаково —
  // текст обрывался на полуслове без единого слова объяснения:
  //   1. упёрлись в --max-turns (CLI отдаёт result без текста, и старая ветка
  //      `ev.type === "result" && ev.result` не отправляла клиенту НИЧЕГО);
  //   2. ход убит пре-эмптом, потому что пользователь прислал новое сообщение;
  //   3. transient-сбой после того, как часть текста уже ушла.
  // Разбор истории 79088644408 за 11.08: 19 сообщений «?» за неделю — это и есть
  // тычки в молчащий чат.
  let turnFailed = false;
  let failReason = "";
  // Служебная реплика ПЛАТФОРМЫ, а не текст модели. Отдельный тип нужен потому,
  // что `result` бэкенд намеренно игнорирует, когда текст уже шёл (иначе с
  // --include-partial-messages финальный result продублировал бы весь ответ).
  // Из-за этого все пояснения релея пропадали ровно в том случае, ради которого
  // писались. `notice` бэкенд дописывает всегда.
  const notice = (text, reason) => {
    if (reason) { turnFailed = true; failReason = reason; }
    console.log("[notice] " + sessionId + " " + (reason || "info") + ": " + text.trim().slice(0, 140));
    if (!clientDisconnected) {
      try { res.write("data: " + JSON.stringify({ type: "notice", text }) + "\n\n"); } catch {}
    }
  };
  // Реальный расход хода. total_cost_usd — сумма по всем result-событиям,
  // включая повторные попытки и субагентов. Рядом собираем сырой usage:
  // бэкенд считает по нему взвешенные токены (веса = отношения цен Anthropic
  // к input, одинаковые для всей линейки моделей), а costUsd оставлен для
  // сверки и как запасной путь.
  //
  // cache_creation разделён по TTL НАМЕРЕННО: запись на 5 минут стоит 1.25x
  // input, на час — 2x. Сложишь их в одно число — часовой кэш будет считаться
  // по цене пятиминутного, то есть на 60% дешевле реального.
  let totalCostUsd = 0;
  const usageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    webSearch: 0,
    webFetch: 0,
  };
  res.on("close", () => { clientDisconnected = true; });

  // Pattern matching Anthropic's "image dimensions exceed 2000px in many-image session" rejection.
  // When this fires, the Claude session is irrecoverable — we must drop --resume and retry fresh.
  const IMG_LIMIT_RE = /exceeds the dimension limit for many-image requests|Start a new session with fewer images/i;
  // Transient errors — retry once with the same session (auth refresh, rate limit, 5xx, network blips).
  const TRANSIENT_RE = /\b(401|403|429|500|502|503|504)\b|Unauthorized|rate.?limit|overload|Service Unavailable|Internal Server Error|API Error|fetch failed|socket hang up|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i;

  // Отказы САМОГО CLI, а не модели: протухший вход, исчерпанная сессия, пустой
  // баланс. Ретраем не лечатся, и — главное — их текст английский и служебный.
  // Ни один из них не попадал ни в IMG_LIMIT_RE, ни в TRANSIENT_RE, поэтому
  // уходил пользователю ДОСЛОВНО как ответ ассистента, да ещё и тарифицировался:
  // в истории 79088644408 лежат «You've hit your session limit · resets 11:50am
  // (UTC)» ×4 (03.08) и «Not logged in · Please run /login» (07.08) — она даже
  // переспросила «что это?».
  const FATAL_RE = /Not logged in|Please run \/login|hit your (session|usage|weekly) limit|Invalid API key|Credit balance is too low|OAuth token (has )?expired/i;
  const fatalHint = (raw) => (
    /Not logged in|Please run \/login|Invalid API key|OAuth token/i.test(raw)
      ? "_(сбой авторизации на стороне платформы — мы уже знаем о проблеме и чиним. Токены за этот ход не списаны, повторите чуть позже.)_"
      : "_(платформа временно упёрлась в лимит модели. Токены за этот ход не списаны — повторите через несколько минут.)_"
  );

  // Claude Code SDK emits this literal placeholder when a turn ends in a rate-limit
  // error and has no specific message to show. Useless to the user — filter out.
  const NO_RESP_PLACEHOLDER = "No response requested.";

  // Протухший --resume: id сессии у нас есть, а транскрипта под ним уже нет.
  // Раньше это было почти невозможно (карта жила ровно столько же, сколько
  // процесс), но с персистом на диск карта переживает и рестарт, и чистку
  // ~/.claude — и без обработки КАЖДОЕ сообщение такого пользователя падало бы
  // одинаково, навсегда. Ловим и переигрываем с чистой сессии.
  const STALE_RESUME_RE = /No conversation found with session ID|session .* not found/i;

  function runOnce(useResume) {
    return new Promise((resolve) => {
      const runArgs = useResume && sessionMap.has(sessionId)
        ? [...args, "--resume", sessionMap.get(sessionId)]
        : args;
      // Pre-empt: if a prior claude is still running for this sessionId,
      // kill it first. Two parallel `claude --resume <same>` processes race
      // on the JSONL session lock and neither makes progress.
      const prev = activeChildren.get(sessionId);
      if (prev && prev.child && prev.child.pid && !prev.child.killed) {
        // Предупредить ТОТ, прерываемый, запрос — у него своё res и свой notice.
        // Без этого пользователь видел, как ответ обрывается на полуслове, и не
        // понимал, что оборвал его сам (11.08: запрос «?» стартовал в 15:26:48,
        // предыдущий ход умер в 15:26:49 — и с неё за него ещё списали токены).
        try { prev.preempt(); } catch {}
        try { prev.child.kill("SIGKILL"); } catch {}
      }

      const child = spawn("claude", runArgs, {
        cwd: "/tmp",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, MCP_TIMEOUT: "120000", MCP_TOOL_TIMEOUT: "600000", PATH: process.env.PATH + ":/home/dv/agent-env/bin:/home/dv/.bun/bin" },
      });
      activeChildren.set(sessionId, {
        child,
        preempt: () => notice(
          "\n\n_(ответ прерван: вы отправили новое сообщение, и ассистент переключился на него. Токены за прерванный ход не списаны.)_",
          "preempted",
        ),
      });
      child.stdin.write(prompt);
      child.stdin.end();

      let buf = "";
      let imageLimitHit = false;
      let transientHit = false;
      let maxTurnsHit = false;
      let staleResumeHit = false;

      const handleEvent = (ev) => {
        if (ev.session_id) rememberSession(sessionId, ev.session_id);
        if (ev.type === "result") {
          // Потолок шагов. Проверяем ЗДЕСЬ, а не в ветке `result && ev.result`
          // ниже: при error_max_turns CLI не кладёт в result никакого текста,
          // та ветка не срабатывала — и клиент не получал вообще ничего.
          if (ev.subtype === "error_max_turns" || /max.?turns/i.test(String(ev.result || ""))) {
            maxTurnsHit = true;
          }
          if (typeof ev.total_cost_usd === "number") totalCostUsd += ev.total_cost_usd;
          const u = ev.usage || {};
          const cc = u.cache_creation || {};
          const st = u.server_tool_use || {};
          const n = (x) => (typeof x === "number" ? x : 0);
          usageTotals.input += n(u.input_tokens);
          usageTotals.output += n(u.output_tokens);
          usageTotals.cacheRead += n(u.cache_read_input_tokens);
          // Разбивка по TTL появилась не во всех версиях CLI. Если её нет —
          // считаем весь cache_creation пятиминутным (консервативно: дешевле
          // недосписать, чем взять за часовой кэш, которого не было).
          const w5 = n(cc.ephemeral_5m_input_tokens);
          const w1 = n(cc.ephemeral_1h_input_tokens);
          if (w5 || w1) {
            usageTotals.cacheWrite5m += w5;
            usageTotals.cacheWrite1h += w1;
          } else {
            usageTotals.cacheWrite5m += n(u.cache_creation_input_tokens);
          }
          usageTotals.webSearch += n(st.web_search_requests);
          usageTotals.webFetch += n(st.web_fetch_requests);
        }
        if (ev.type === "stream_event" && ev.event) {
          const se = ev.event;
          if (se.type === "content_block_delta" && se.delta && se.delta.type === "text_delta" && se.delta.text) {
            if (se.delta.text.trim() === NO_RESP_PLACEHOLDER) {
              transientHit = true;
              return;
            }
            if (!clientDisconnected) { streamedAny = true; res.write("data: " + JSON.stringify({ type: "delta", text: se.delta.text }) + "\n\n"); }
          }
        } else if (ev.type === "assistant" && ev.message) {
          for (const block of (ev.message.content || [])) {
            if (block.type === "tool_use") {
              if (TALERID_WRITE_RE.test(block.name || "")) taleridWriteUsed = true;
              const inp = typeof block.input === "string" ? block.input : JSON.stringify(block.input);
              if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "tool", tool: block.name, input: inp.slice(0, 300) }) + "\n\n");
            }
          }
        } else if (ev.type === "result" && ev.result) {
          const isErrorResult =
            ev.is_error === true ||
            (typeof ev.subtype === "string" && ev.subtype !== "success") ||
            !!ev.api_error_status;
          if (STALE_RESUME_RE.test(ev.result)) { staleResumeHit = true; return; }
          // Отказ CLI — не показываем сырой английский текст и не берём денег.
          // Проверяем ДО isErrorResult: «You've hit your session limit» приходил
          // и без is_error/api_error_status, обычным успешным result.
          if (FATAL_RE.test(ev.result)) {
            notice(fatalHint(ev.result), "cli_fatal");
            return;
          }
          if (isErrorResult && IMG_LIMIT_RE.test(ev.result) && useResume) {
            // Suppress this error from client — we will retry fresh
            imageLimitHit = true;
            return;
          }
          if (isErrorResult && TRANSIENT_RE.test(ev.result)) {
            // Suppress and retry with same session
            transientHit = true;
            return;
          }
          if (ev.result.trim() === NO_RESP_PLACEHOLDER) {
            transientHit = true;
            return;
          }
          if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "result", text: ev.result }) + "\n\n");
        }
      };

      child.stdout.on("data", (chunk) => {
        if (clientDisconnected) return;
        buf += chunk.toString();
        const parts = buf.split("\n");
        buf = parts.pop();
        for (const line of parts) {
          if (!line.trim()) continue;
          try { handleEvent(JSON.parse(line)); } catch {}
        }
      });

      // stderr раньше молча выбрасывался. Именно туда CLI пишет отказ
      // «No conversation found with session ID» — при протухшем --resume
      // валидного stream-json на stdout не появляется вовсе, и распознать
      // причину больше негде. Держим только хвост: чужой болтливый stderr не
      // должен раздувать память.
      let errTail = "";
      child.stderr.on("data", (chunk) => {
        errTail = (errTail + chunk.toString()).slice(-4000);
        if (STALE_RESUME_RE.test(errTail)) staleResumeHit = true;
      });

      child.on("close", () => {
        if (buf.trim()) { try { handleEvent(JSON.parse(buf)); } catch {} }
        try { execSync("pkill -f 'bun.*server.ts' --newer " + child.pid + " 2>/dev/null || true"); } catch {}
        const cur = activeChildren.get(sessionId);
        if (cur && cur.child === child) activeChildren.delete(sessionId);
        resolve({ imageLimitHit, transientHit, maxTurnsHit, staleResumeHit });
      });

      child.on("error", (err) => {
        // Network/spawn errors are transient too
        if (TRANSIENT_RE.test(err.message || '')) {
          resolve({ imageLimitHit: false, transientHit: true, maxTurnsHit: false, staleResumeHit: false });
        } else {
          if (!clientDisconnected) res.write("data: " + JSON.stringify({ type: "error", text: err.message }) + "\n\n");
          resolve({ imageLimitHit: false, transientHit: false, maxTurnsHit: false, staleResumeHit: false });
        }
      });
    });
  }

  (async () => {
    let useResume = sessionMap.has(sessionId);
    if (useResume) {
      try {
        const claudeSid = sessionMap.get(sessionId);
        const st = fs.statSync(sessionJsonlPath(claudeSid));
        if (st.size > SESSION_ROTATE_BYTES) {
          const tail = extractTailDialogue(claudeSid);
          forgetSession(sessionId);
          useResume = false;
          if (tail) {
            prompt = "Недавний диалог с этим пользователем (только контекст для непрерывности — отвечай ТОЛЬКО на последнее сообщение ниже):\n" + tail + "\n---\n\n" + prompt;
          }
          console.log("session rotated (size " + st.size + "): " + sessionId);
        }
      } catch {}
    }
    let r = await runOnce(useResume);

    // Протухший resume. Сессия есть в карте, транскрипта под ней нет — такое
    // стало возможным с тех пор, как карта переживает рестарт. Без этой ветки
    // пользователь застревал бы НАВСЕГДА: каждое его сообщение падало бы
    // одинаково, потому что мёртвый id остаётся в карте.
    if (r.staleResumeHit && useResume) {
      console.log("stale resume для " + sessionId + " — сброс и переигрыш с чистой сессии");
      forgetSession(sessionId);
      useResume = false;
      r = await runOnce(false);
    }

    if (r.imageLimitHit) {
      // Session is bloated with images — drop and retry fresh, transparently.
      forgetSession(sessionId);
      notice("_(сессия была очищена — слишком много изображений; продолжаю с чистого листа)_");
      r = await runOnce(false);
    } else if (r.transientHit && taleridWriteUsed) {
      // A TalerID write already happened this turn — re-running would risk a
      // double-send (send_message is not deduped server-side). Do NOT retry;
      // ask the user to check rather than blindly re-executing the write.
      notice("_(связь с моделью прервалась после действия — проверьте результат, возможно всё прошло; при необходимости повторите)_", "transient_after_write");
    } else if (r.transientHit && streamedAny) {
      // Ответ (пусть и частичный) клиент уже прочитал — повтор дал бы дубль.
      notice("\n\n_(связь с моделью прервалась, ответ оборван. Токены за этот ход не списаны — повторите вопрос.)_", "transient_after_partial");
    } else if (r.transientHit) {
      // 401/429/5xx/network blip — wait briefly and retry on the same session.
      await new Promise((res) => setTimeout(res, 1500));
      r = await runOnce(useResume);
      // If retry also fails transiently, surface a friendly message rather than raw error.
      if (r.transientHit) {
        notice("_(временный сбой связи с моделью, попробуйте отправить сообщение ещё раз)_", "transient");
      }
    }

    // Потолок шагов: сессия ЖИВА, CLI просто остановил ход на 40-м инструменте.
    // Раньше это давало немой обрыв — ровно случай 11.08 08:24, где в стенограмме
    // оказалось 40 tool_use подряд и обрыв на полуслове (у соседнего успешного
    // хода — 23). Для юриста с 144-страничной жалобой сорок шагов не потолок, а
    // рабочая норма, поэтому продолжаем сами, а не просим пользователя повторять.
    //
    // Продолжение идёт тем же --resume, поэтому модель видит всё, что уже
    // сделала. Два продолжения — предохранитель от бесконечного цикла на задаче,
    // которая не сходится в принципе.
    let continues = 0;
    while (r.maxTurnsHit && continues < 2 && !clientDisconnected) {
      continues++;
      notice("\n\n_(работа получилась длинной — продолжаю с того места, где остановился…)_");
      prompt = "Продолжи прерванную работу ровно с того места, где остановился, и доведи ответ до конца. Не начинай заново и не пересказывай уже сделанное.";
      r = await runOnce(true);
    }
    if (r.maxTurnsHit) {
      notice(
        "\n\n_(задача оказалась слишком большой даже для трёх заходов. Напишите «продолжай» — ассистент доведёт её до конца. Токены за незавершённый ход не списаны.)_",
        "max_turns",
      );
    }

    // Collect output files
    const outputFiles = [];
    if (fs.existsSync(outDir)) {
      const walk = (dir, prefix) => {
        for (const item of fs.readdirSync(dir)) {
          const full = path.join(dir, item);
          const rel = prefix ? prefix + "/" + item : item;
          try {
            const stat = fs.statSync(full);
            if (stat.isDirectory()) walk(full, rel);
            // Ссылка обязана указывать на ту же папку, которую обошёл walk:
            // файлы лежат в OUTPUT_DIR/<fsKey>, а не в OUTPUT_DIR/<sessionId>.
            else if (!filesBefore.has(rel) || stat.mtimeMs > filesBefore.get(rel)) outputFiles.push({ name: rel, size: stat.size, url: "/files/" + fsKey + "/" + rel });
          } catch {}
        }
      };
      walk(outDir, "");
    }

    stopHeartbeat();
    if (!clientDisconnected) {
      // failed — «ход не выдал финального ответа». Бэкенд по нему пропускает
      // списание: платить за пустоту пользователь не должен.
      res.write("data: " + JSON.stringify({
        type: "done",
        outputFiles,
        costUsd: totalCostUsd,
        usage: usageTotals,
        failed: turnFailed,
        failReason,
      }) + "\n\n");
      res.end();
    }
  })().catch(() => { stopHeartbeat(); }).finally(() => {
    // Remove the per-session TalerID MCP config (it holds the user's Bearer token).
    if (taleridMcpPath) { try { fs.unlinkSync(taleridMcpPath); } catch {} }
  });
});

app.get("/session/:sid/files", (req, res) => {
  const outDir = path.join(OUTPUT_DIR, req.params.sid);
  if (!fs.existsSync(outDir)) return res.json([]);
  const files = [];
  const walk = (dir, prefix) => {
    for (const item of fs.readdirSync(dir)) {
      const full = path.join(dir, item);
      const rel = prefix ? prefix + "/" + item : item;
      try {
        const stat = fs.statSync(full);
        if (stat.isDirectory()) walk(full, rel);
        else files.push({ name: rel, size: stat.size, url: "/files/" + req.params.sid + "/" + rel });
      } catch {}
    }
  };
  walk(outDir, "");
  res.json(files);
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", sessions: sessionMap.size, uptime: process.uptime() });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Agent API on http://0.0.0.0:" + PORT);
});
