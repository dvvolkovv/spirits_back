import { PgService } from '../common/services/pg.service';
import { DEFAULT_LANGUAGE, LanguageService, SUPPORTED_LANGUAGES } from '../common/services/language.service';

/**
 * Служебные сообщения TG-бота на языке человека.
 *
 * Раньше всё, что бот пишет сам — справка, «токены закончились», «Минутку»,
 * подписи кнопок и меню команд, — уходило по-русски и на «ты», хотя кабинет
 * переведён на семь языков и говорит «вы» (решение владельца 14.10.2026).
 *
 * Язык — тот же, на котором отвечает ассистент: profile_data.language
 * владельца. Для того, кто ещё не привязан к Linkeon, — язык его клиента
 * Telegram (from.language_code). Регистр — как в кабинете на этом языке:
 * ru и fr — «вы», de/es/pt — «ты», zh — 您.
 *
 * Шаблоны с <b> уходят с parse_mode HTML: подставляемые имена экранирует
 * вызывающий (escapeHtml), в самих шаблонах — только <b>, <i>, <code>.
 * Числа в текст попадают уже отформатированными (formatTgNumber), а фразы
 * построены так, чтобы не склонять слово после числа.
 */

export type TgLang = (typeof SUPPORTED_LANGUAGES)[number];
export const TG_LANGS = SUPPORTED_LANGUAGES;

const NUMBER_LOCALE: Record<TgLang, string> = {
  ru: 'ru-RU', en: 'en-US', es: 'es-ES', de: 'de-DE', fr: 'fr-FR', zh: 'zh-CN', pt: 'pt-PT',
};

const ru = {
  // Личка: старт и привязка
  start_unlinked: 'Привет! Чтобы начать, откройте Linkeon — там можно завести аккаунт или привязать существующий.',
  start_hello: 'Привет!',
  start_hello_agent: 'Привет! Сейчас отвечает <b>{agent}</b>.',
  start_body: 'Пишите сюда — ассистент ответит. /assistants — сменить ассистента, /balance — баланс.',
  unlinked_chat: 'Чтобы я отвечал, нужен аккаунт Linkeon — откройте его кнопкой ниже.',
  unlinked_command: 'Для этой команды нужен аккаунт Linkeon — откройте его кнопкой ниже.',
  open_linkeon: 'Открыть Linkeon',
  bind_ok: 'Привет! Ваш Telegram привязан к Linkeon — можно возвращаться на сайт.',
  bind_ok_named: 'Привет, {name}! Ваш Telegram привязан к Linkeon — можно возвращаться на сайт.',
  bind_conflict: 'Этот Telegram ({who}) уже привязан к другому аккаунту Linkeon. Новая ссылка не поможет — ограничение не в ней. Откройте ссылку из того Telegram-аккаунта, который хотите привязать, или сначала отвяжите этот от старого аккаунта.',
  bind_failed: 'Не получилось привязать: {reason}. Получите в Linkeon новую ссылку — старая могла истечь (ссылка живёт 15 минут).',

  // Личка: справка и команды
  dm_help: 'Я бот Linkeon — отвечаю здесь, в личке, и в группах, куда меня добавил владелец.\n\nКоманды:\n/start — подключить Telegram к Linkeon\n/assistants — выбрать ассистента для лички\n/language — язык ответов\n/balance — баланс токенов вашего аккаунта\n/silent — замолчать во всех ваших группах\n/resume — снова отвечать в них\n/help — это сообщение\n\nВ группе /silent и /resume управляют только ботом этой группы.\n\nКабинет: https://my.linkeon.io/telegram-bots',
  balance: 'Токенов на балансе: <b>{balance}</b>\nПополнить: https://my.linkeon.io/tokens',
  silent_none: 'Активных ботов в группах нет — глушить некого.',
  resume_none: 'Молчащих ботов нет — будить некого.',
  silenced: '🤫 Замолкли:',
  resumed: '✅ Снова на связи:',
  list_private: '• <b>{name}</b> в личке',
  list_group: '• <b>{name}</b> в «{group}»',
  list_group_untitled: '• <b>{name}</b> в группе',
  unknown_command: 'Не знаю такой команды. /help — список доступных.',

  // Язык и ассистенты
  language_prompt: 'На каком языке отвечать?',
  language_unknown: 'Такого языка нет',
  language_set: 'Готово, язык ответов: <b>{language}</b>.',
  assistants_prompt: 'Кто будет отвечать?',
  assistants_current: 'Сейчас отвечает <b>{agent}</b>. Кто будет отвечать?',
  assistant_unknown: 'Такого ассистента нет',
  assistant_set: 'Теперь отвечает <b>{agent}</b>.',
  assistant_switched_note: '— Дальше отвечает {agent}. —',
  nav_back: '← Назад',
  nav_next: 'Дальше →',

  // Группа: привязка и выход
  claim_hello: 'Я {name}. Зовите меня @{bot} или ответом на это сообщение.',
  claim_failed: 'Не получилось привязать бота: {reason}',
  bot_removed: 'Бот «{name}» удалён из «{group}». Настройки сохранены в архиве — их можно восстановить в кабинете.',
  bot_removed_untitled: 'Бот «{name}» удалён из группы. Настройки сохранены в архиве — их можно восстановить в кабинете.',

  // Группа: команды
  group_help: 'Я <b>{name}</b> — {mode}.\n\nКоманды:\n/help — это сообщение\n/balance — баланс владельца (только владельцу)\n/silent — замолчать (только владельцу)\n/resume — снова отвечать (только владельцу)\n\nКабинет: https://my.linkeon.io/telegram-bots',
  mode_strict: 'отвечаю, только когда ко мне обращаются',
  mode_always: 'отвечаю на каждое сообщение',
  mode_smart: 'вмешиваюсь, когда вижу, что это к месту',
  owner_only: 'Эта команда доступна только владельцу бота.',
  group_silenced: '🤫 Замолкаю до /resume.',
  group_resumed: '✅ Снова на связи.',
  dm_only: 'Эта команда работает в личке с ботом: @{bot}',

  // Группа и личка: ход
  zero_balance_group: '⚠️ У владельца закончились токены. Бот не отвечает, пока баланс не пополнят: https://my.linkeon.io/tokens',
  busy: '⏳ Минутку — заканчиваю предыдущий запрос. Подождите или повторите через 30 секунд.',
  thinking: '🤔 Думаю...',
  tool_products: '🛠 Работаю с продуктом...',
  tool_read: '📄 Читаю файл...',
  tool_write: '✏️ Пишу файл...',
  tool_edit: '✏️ Редактирую файл...',
  tool_bash: '⚙️ Выполняю команду...',
  tool_glob: '🔍 Ищу файлы...',
  tool_grep: '🔍 Ищу в файлах...',
  tool_web_search: '🌐 Ищу в интернете...',
  tool_web_fetch: '🌐 Открываю страницу...',
  tool_image: '🎨 Готовлю картинку...',
  tool_upscale: '✨ Улучшаю картинку...',
  tool_video: '🎬 Запускаю генерацию видео...',
  turn_failed: '⚠️ Не получилось обработать запрос: {reason}',
  delivery_failed: '⚠️ Ответ готов, но не отправился из-за технического сбоя. Мы уже видим ошибку — попробуйте переспросить.',
  attach_failed: '(не удалось приложить файл: {reason})',
  video_queued: '🎬 Видео в очереди (1–3 минуты). Пришлю, как только будет готово.',
  video_failed: '⚠️ Не получилось сгенерировать видео.',
  video_expired: '⚠️ Видео сгенерировалось, но не получилось доставить — ссылка истекла.',

  // Встречи
  meeting_who: 'Ассистент зайдёт во встречу',
  meeting_who_agent: '{agent} зайдёт во встречу',
  meeting_join: 'Зайти во встречу',
  meeting_title: 'Встреча',
  meeting_title_meet: 'Встреча Google Meet',
  meeting_title_zoom: 'Встреча Zoom',
  meeting_link_expired: 'Ссылка устарела — пришлите её ещё раз.',
  meeting_pick_assistant: 'Сначала выберите ассистента: /assistants',
  meeting_joined: '{agent} во встрече.',
  meeting_busy: 'Разговор уже идёт — завершите его и попробуйте снова.',
  meeting_unavailable: 'Не получилось зайти: комната недоступна.',

  // Владельцу о балансе
  low_balance: '⚠️ Токены на исходе: на балансе {balance}. Когда они закончатся, боты перестанут отвечать. Пополнить: https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ Токены закончились — ваши боты не отвечают, пока вы не пополните баланс: https://my.linkeon.io/tokens',

  // Меню команд (кнопка «/» в Telegram)
  cmd_assistants: 'Выбрать ассистента',
  cmd_language: 'Язык ответов',
  cmd_balance: 'Баланс токенов',
  cmd_balance_owner: 'Баланс владельца',
  cmd_silent_all: 'Замолчать во всех группах',
  cmd_silent_here: 'Замолчать в этой группе',
  cmd_resume_all: 'Снова отвечать в группах',
  cmd_resume_here: 'Снова отвечать здесь',
  cmd_help: 'Что умеет бот',
};

export type TgTextKey = keyof typeof ru;
type Catalog = Record<TgTextKey, string>;

const en: Catalog = {
  start_unlinked: "Hi! To get started, open Linkeon — you can create an account there or link an existing one.",
  start_hello: "Hi!",
  start_hello_agent: "Hi! <b>{agent}</b> is replying right now.",
  start_body: "Write here and the assistant will reply. /assistants — switch assistant, /balance — balance.",
  unlinked_chat: "To get replies from me, you need a Linkeon account — open it with the button below.",
  unlinked_command: "This command needs a Linkeon account — open it with the button below.",
  open_linkeon: "Open Linkeon",
  bind_ok: "Hi! Your Telegram is now linked to Linkeon — you can go back to the site.",
  bind_ok_named: "Hi, {name}! Your Telegram is now linked to Linkeon — you can go back to the site.",
  bind_conflict: "This Telegram ({who}) is already linked to another Linkeon account. A new link won't help — the restriction isn't in the link. Open the link from the Telegram account you want to link, or first unlink this one from the old account.",
  bind_failed: "Couldn't link: {reason}. Get a new link in Linkeon — the old one may have expired (a link lasts 15 minutes).",

  dm_help: "I'm the Linkeon bot — I reply here in private chat and in groups where the owner added me.\n\nCommands:\n/start — connect Telegram to Linkeon\n/assistants — choose the assistant for this chat\n/language — reply language\n/balance — your account's token balance\n/silent — go quiet in all your groups\n/resume — reply in them again\n/help — this message\n\nIn a group, /silent and /resume control only that group's bot.\n\nYour account: https://my.linkeon.io/telegram-bots",
  balance: "Token balance: <b>{balance}</b>\nTop up: https://my.linkeon.io/tokens",
  silent_none: "No active bots in groups — nothing to silence.",
  resume_none: "No silenced bots — nothing to resume.",
  silenced: "🤫 Gone quiet:",
  resumed: "✅ Back online:",
  list_private: "• <b>{name}</b> in private chat",
  list_group: "• <b>{name}</b> in “{group}”",
  list_group_untitled: "• <b>{name}</b> in a group",
  unknown_command: "I don't know that command. /help — list of commands.",

  language_prompt: "Which language should I reply in?",
  language_unknown: "No such language",
  language_set: "Done — reply language: <b>{language}</b>.",
  assistants_prompt: "Who should reply?",
  assistants_current: "<b>{agent}</b> is replying now. Who should reply?",
  assistant_unknown: "No such assistant",
  assistant_set: "<b>{agent}</b> is replying now.",
  assistant_switched_note: "— {agent} takes over from here. —",
  nav_back: "← Back",
  nav_next: "Next →",

  claim_hello: "I'm {name}. Call me with @{bot} or reply to this message.",
  claim_failed: "Couldn't connect the bot: {reason}",
  bot_removed: "The bot “{name}” was removed from “{group}”. Its settings are archived — you can restore them in your account.",
  bot_removed_untitled: "The bot “{name}” was removed from the group. Its settings are archived — you can restore them in your account.",

  group_help: "I'm <b>{name}</b> — {mode}.\n\nCommands:\n/help — this message\n/balance — owner's balance (owner only)\n/silent — go quiet (owner only)\n/resume — reply again (owner only)\n\nYour account: https://my.linkeon.io/telegram-bots",
  mode_strict: "I reply only when addressed",
  mode_always: "I reply to every message",
  mode_smart: "I join in when I see it's worth it",
  owner_only: "Only the bot's owner can use this command.",
  group_silenced: "🤫 Going quiet until /resume.",
  group_resumed: "✅ Back online.",
  dm_only: "This command works in a private chat with the bot: @{bot}",

  zero_balance_group: "⚠️ The owner has run out of tokens. The bot won't reply until the balance is topped up: https://my.linkeon.io/tokens",
  busy: "⏳ One moment — finishing the previous request. Please wait or try again in 30 seconds.",
  thinking: "🤔 Thinking...",
  tool_products: "🛠 Working on the product...",
  tool_read: "📄 Reading a file...",
  tool_write: "✏️ Writing a file...",
  tool_edit: "✏️ Editing a file...",
  tool_bash: "⚙️ Running a command...",
  tool_glob: "🔍 Looking for files...",
  tool_grep: "🔍 Searching in files...",
  tool_web_search: "🌐 Searching the web...",
  tool_web_fetch: "🌐 Opening a page...",
  tool_image: "🎨 Preparing an image...",
  tool_upscale: "✨ Enhancing the image...",
  tool_video: "🎬 Starting video generation...",
  turn_failed: "⚠️ Couldn't process the request: {reason}",
  delivery_failed: "⚠️ The reply is ready but didn't go through because of a technical failure. We already see the error — please ask again.",
  attach_failed: "(couldn't attach the file: {reason})",
  video_queued: "🎬 The video is queued (1–3 minutes). I'll send it as soon as it's ready.",
  video_failed: "⚠️ Couldn't generate the video.",
  video_expired: "⚠️ The video was generated but couldn't be delivered — the link expired.",

  meeting_who: "The assistant will join the meeting",
  meeting_who_agent: "{agent} will join the meeting",
  meeting_join: "Join the meeting",
  meeting_title: "Meeting",
  meeting_title_meet: "Google Meet meeting",
  meeting_title_zoom: "Zoom meeting",
  meeting_link_expired: "The link has expired — send it again.",
  meeting_pick_assistant: "Choose an assistant first: /assistants",
  meeting_joined: "{agent} is in the meeting.",
  meeting_busy: "A conversation is already in progress — finish it and try again.",
  meeting_unavailable: "Couldn't join: the room is unavailable.",

  low_balance: "⚠️ Tokens are running low: {balance} left. When they run out, your bots will stop replying. Top up: https://my.linkeon.io/tokens",
  zero_balance_owner: "⛔ You're out of tokens — your bots won't reply until you top up: https://my.linkeon.io/tokens",

  cmd_assistants: "Choose an assistant",
  cmd_language: "Reply language",
  cmd_balance: "Token balance",
  cmd_balance_owner: "Owner's balance",
  cmd_silent_all: "Go quiet in all groups",
  cmd_silent_here: "Go quiet in this group",
  cmd_resume_all: "Reply in groups again",
  cmd_resume_here: "Reply here again",
  cmd_help: "What the bot can do",
};

const de: Catalog = {
  start_unlinked: 'Hallo! Öffne zuerst Linkeon — dort kannst du ein Konto anlegen oder ein bestehendes verknüpfen.',
  start_hello: 'Hallo!',
  start_hello_agent: 'Hallo! Gerade antwortet <b>{agent}</b>.',
  start_body: 'Schreib hier, und der Assistent antwortet. /assistants — Assistenten wechseln, /balance — Guthaben.',
  unlinked_chat: 'Damit ich antworte, brauchst du ein Linkeon-Konto — öffne es mit der Schaltfläche unten.',
  unlinked_command: 'Für diesen Befehl brauchst du ein Linkeon-Konto — öffne es mit der Schaltfläche unten.',
  open_linkeon: 'Linkeon öffnen',
  bind_ok: 'Hallo! Dein Telegram ist jetzt mit Linkeon verknüpft — du kannst zur Website zurückkehren.',
  bind_ok_named: 'Hallo, {name}! Dein Telegram ist jetzt mit Linkeon verknüpft — du kannst zur Website zurückkehren.',
  bind_conflict: 'Dieses Telegram ({who}) ist bereits mit einem anderen Linkeon-Konto verknüpft. Ein neuer Link hilft nicht — die Einschränkung liegt nicht am Link. Öffne den Link in dem Telegram-Konto, das du verknüpfen willst, oder trenne dieses zuerst vom alten Konto.',
  bind_failed: 'Verknüpfen hat nicht geklappt: {reason}. Hol dir in Linkeon einen neuen Link — der alte ist vielleicht abgelaufen (ein Link gilt 15 Minuten).',

  dm_help: 'Ich bin der Linkeon-Bot — ich antworte hier im privaten Chat und in Gruppen, in die mich der Besitzer aufgenommen hat.\n\nBefehle:\n/start — Telegram mit Linkeon verbinden\n/assistants — Assistenten für diesen Chat wählen\n/language — Antwortsprache\n/balance — Token-Guthaben deines Kontos\n/silent — in allen deinen Gruppen schweigen\n/resume — dort wieder antworten\n/help — diese Nachricht\n\nIn einer Gruppe steuern /silent und /resume nur den Bot dieser Gruppe.\n\nDein Konto: https://my.linkeon.io/telegram-bots',
  balance: 'Token-Guthaben: <b>{balance}</b>\nAufladen: https://my.linkeon.io/tokens',
  silent_none: 'Keine aktiven Bots in Gruppen — niemand zum Stummschalten.',
  resume_none: 'Keine stummgeschalteten Bots — niemand zum Aufwecken.',
  silenced: '🤫 Stummgeschaltet:',
  resumed: '✅ Wieder aktiv:',
  list_private: '• <b>{name}</b> im privaten Chat',
  list_group: '• <b>{name}</b> in „{group}“',
  list_group_untitled: '• <b>{name}</b> in einer Gruppe',
  unknown_command: 'Diesen Befehl kenne ich nicht. /help — Liste der Befehle.',

  language_prompt: 'In welcher Sprache soll ich antworten?',
  language_unknown: 'Diese Sprache gibt es nicht',
  language_set: 'Erledigt — Antwortsprache: <b>{language}</b>.',
  assistants_prompt: 'Wer soll antworten?',
  assistants_current: 'Gerade antwortet <b>{agent}</b>. Wer soll antworten?',
  assistant_unknown: 'Diesen Assistenten gibt es nicht',
  assistant_set: 'Jetzt antwortet <b>{agent}</b>.',
  assistant_switched_note: '— Ab hier antwortet {agent}. —',
  nav_back: '← Zurück',
  nav_next: 'Weiter →',

  claim_hello: 'Ich bin {name}. Ruf mich mit @{bot} oder antworte auf diese Nachricht.',
  claim_failed: 'Der Bot konnte nicht verbunden werden: {reason}',
  bot_removed: 'Der Bot „{name}“ wurde aus „{group}“ entfernt. Seine Einstellungen sind archiviert — du kannst sie in deinem Konto wiederherstellen.',
  bot_removed_untitled: 'Der Bot „{name}“ wurde aus der Gruppe entfernt. Seine Einstellungen sind archiviert — du kannst sie in deinem Konto wiederherstellen.',

  group_help: 'Ich bin <b>{name}</b> — {mode}.\n\nBefehle:\n/help — diese Nachricht\n/balance — Guthaben des Besitzers (nur für den Besitzer)\n/silent — schweigen (nur für den Besitzer)\n/resume — wieder antworten (nur für den Besitzer)\n\nDein Konto: https://my.linkeon.io/telegram-bots',
  mode_strict: 'ich antworte nur, wenn man mich anspricht',
  mode_always: 'ich antworte auf jede Nachricht',
  mode_smart: 'ich melde mich, wenn es passt',
  owner_only: 'Diesen Befehl kann nur der Besitzer des Bots nutzen.',
  group_silenced: '🤫 Ich schweige bis /resume.',
  group_resumed: '✅ Wieder da.',
  dm_only: 'Dieser Befehl funktioniert im privaten Chat mit dem Bot: @{bot}',

  zero_balance_group: '⚠️ Der Besitzer hat keine Tokens mehr. Der Bot antwortet erst wieder, wenn das Guthaben aufgeladen ist: https://my.linkeon.io/tokens',
  busy: '⏳ Einen Moment — ich beende noch die vorige Anfrage. Warte kurz oder versuch es in 30 Sekunden noch einmal.',
  thinking: '🤔 Ich denke nach...',
  tool_products: '🛠 Arbeite am Produkt...',
  tool_read: '📄 Lese eine Datei...',
  tool_write: '✏️ Schreibe eine Datei...',
  tool_edit: '✏️ Bearbeite eine Datei...',
  tool_bash: '⚙️ Führe einen Befehl aus...',
  tool_glob: '🔍 Suche Dateien...',
  tool_grep: '🔍 Suche in Dateien...',
  tool_web_search: '🌐 Suche im Internet...',
  tool_web_fetch: '🌐 Öffne eine Seite...',
  tool_image: '🎨 Erstelle ein Bild...',
  tool_upscale: '✨ Verbessere das Bild...',
  tool_video: '🎬 Starte die Videoerstellung...',
  turn_failed: '⚠️ Die Anfrage konnte nicht bearbeitet werden: {reason}',
  delivery_failed: '⚠️ Die Antwort ist fertig, wurde aber wegen einer technischen Störung nicht gesendet. Wir sehen den Fehler bereits — frag bitte noch einmal.',
  attach_failed: '(die Datei konnte nicht angehängt werden: {reason})',
  video_queued: '🎬 Das Video ist in der Warteschlange (1–3 Minuten). Ich schicke es, sobald es fertig ist.',
  video_failed: '⚠️ Das Video konnte nicht erstellt werden.',
  video_expired: '⚠️ Das Video wurde erstellt, konnte aber nicht zugestellt werden — der Link ist abgelaufen.',

  meeting_who: 'Der Assistent kommt ins Meeting',
  meeting_who_agent: '{agent} kommt ins Meeting',
  meeting_join: 'Am Meeting teilnehmen',
  meeting_title: 'Meeting',
  meeting_title_meet: 'Google-Meet-Meeting',
  meeting_title_zoom: 'Zoom-Meeting',
  meeting_link_expired: 'Der Link ist abgelaufen — schick ihn noch einmal.',
  meeting_pick_assistant: 'Wähle zuerst einen Assistenten: /assistants',
  meeting_joined: '{agent} ist im Meeting.',
  meeting_busy: 'Es läuft bereits ein Gespräch — beende es und versuch es erneut.',
  meeting_unavailable: 'Beitritt nicht möglich: Der Raum ist nicht verfügbar.',

  low_balance: '⚠️ Die Tokens werden knapp: noch {balance} auf dem Guthaben. Sind sie aufgebraucht, antworten deine Bots nicht mehr. Aufladen: https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ Deine Tokens sind aufgebraucht — deine Bots antworten erst wieder, wenn du dein Guthaben auflädst: https://my.linkeon.io/tokens',

  cmd_assistants: 'Assistenten wählen',
  cmd_language: 'Antwortsprache',
  cmd_balance: 'Token-Guthaben',
  cmd_balance_owner: 'Guthaben des Besitzers',
  cmd_silent_all: 'In allen Gruppen schweigen',
  cmd_silent_here: 'In dieser Gruppe schweigen',
  cmd_resume_all: 'In Gruppen wieder antworten',
  cmd_resume_here: 'Hier wieder antworten',
  cmd_help: 'Was der Bot kann',
};

const fr: Catalog = {
  start_unlinked: 'Bonjour ! Pour commencer, ouvrez Linkeon — vous pourrez y créer un compte ou lier un compte existant.',
  start_hello: 'Bonjour !',
  start_hello_agent: 'Bonjour ! C’est <b>{agent}</b> qui répond en ce moment.',
  start_body: 'Écrivez ici, l’assistant vous répondra. /assistants — changer d’assistant, /balance — solde.',
  unlinked_chat: 'Pour que je réponde, il faut un compte Linkeon — ouvrez-le avec le bouton ci-dessous.',
  unlinked_command: 'Cette commande nécessite un compte Linkeon — ouvrez-le avec le bouton ci-dessous.',
  open_linkeon: 'Ouvrir Linkeon',
  bind_ok: 'Bonjour ! Votre Telegram est maintenant lié à Linkeon — vous pouvez revenir sur le site.',
  bind_ok_named: 'Bonjour, {name} ! Votre Telegram est maintenant lié à Linkeon — vous pouvez revenir sur le site.',
  bind_conflict: 'Ce Telegram ({who}) est déjà lié à un autre compte Linkeon. Un nouveau lien n’y changera rien — la restriction ne vient pas du lien. Ouvrez le lien depuis le compte Telegram que vous voulez lier, ou déliez d’abord celui-ci de l’ancien compte.',
  bind_failed: 'La liaison a échoué : {reason}. Obtenez un nouveau lien dans Linkeon — l’ancien a peut-être expiré (un lien est valable 15 minutes).',

  dm_help: 'Je suis le bot Linkeon — je réponds ici, en message privé, et dans les groupes où le propriétaire m’a ajouté.\n\nCommandes :\n/start — connecter Telegram à Linkeon\n/assistants — choisir l’assistant de cette conversation\n/language — langue des réponses\n/balance — solde de jetons de votre compte\n/silent — me taire dans tous vos groupes\n/resume — y répondre de nouveau\n/help — ce message\n\nDans un groupe, /silent et /resume ne concernent que le bot de ce groupe.\n\nVotre compte : https://my.linkeon.io/telegram-bots',
  balance: 'Solde de jetons : <b>{balance}</b>\nRecharger : https://my.linkeon.io/tokens',
  silent_none: 'Aucun bot actif dans les groupes — rien à mettre en sourdine.',
  resume_none: 'Aucun bot en sourdine — rien à réactiver.',
  silenced: '🤫 En sourdine :',
  resumed: '✅ De nouveau actifs :',
  list_private: '• <b>{name}</b> en message privé',
  list_group: '• <b>{name}</b> dans « {group} »',
  list_group_untitled: '• <b>{name}</b> dans un groupe',
  unknown_command: 'Je ne connais pas cette commande. /help — liste des commandes.',

  language_prompt: 'Dans quelle langue dois-je répondre ?',
  language_unknown: 'Cette langue n’existe pas',
  language_set: 'C’est fait, langue des réponses : <b>{language}</b>.',
  assistants_prompt: 'Qui doit répondre ?',
  assistants_current: 'C’est <b>{agent}</b> qui répond en ce moment. Qui doit répondre ?',
  assistant_unknown: 'Cet assistant n’existe pas',
  assistant_set: 'Désormais, c’est <b>{agent}</b> qui répond.',
  assistant_switched_note: '— À partir d’ici, c’est {agent} qui répond. —',
  nav_back: '← Retour',
  nav_next: 'Suivant →',

  claim_hello: 'Je suis {name}. Appelez-moi avec @{bot} ou en répondant à ce message.',
  claim_failed: 'Impossible de connecter le bot : {reason}',
  bot_removed: 'Le bot « {name} » a été retiré de « {group} ». Ses réglages sont archivés — vous pouvez les restaurer dans votre compte.',
  bot_removed_untitled: 'Le bot « {name} » a été retiré du groupe. Ses réglages sont archivés — vous pouvez les restaurer dans votre compte.',

  group_help: 'Je suis <b>{name}</b> — {mode}.\n\nCommandes :\n/help — ce message\n/balance — solde du propriétaire (propriétaire uniquement)\n/silent — me taire (propriétaire uniquement)\n/resume — répondre de nouveau (propriétaire uniquement)\n\nVotre compte : https://my.linkeon.io/telegram-bots',
  mode_strict: 'je réponds seulement quand on s’adresse à moi',
  mode_always: 'je réponds à chaque message',
  mode_smart: 'j’interviens quand je vois que c’est utile',
  owner_only: 'Seul le propriétaire du bot peut utiliser cette commande.',
  group_silenced: '🤫 Je me tais jusqu’à /resume.',
  group_resumed: '✅ De retour.',
  dm_only: 'Cette commande fonctionne en message privé avec le bot : @{bot}',

  zero_balance_group: '⚠️ Le propriétaire n’a plus de jetons. Le bot ne répondra pas tant que le solde n’aura pas été rechargé : https://my.linkeon.io/tokens',
  busy: '⏳ Un instant — je termine la demande précédente. Patientez ou réessayez dans 30 secondes.',
  thinking: '🤔 Je réfléchis...',
  tool_products: '🛠 Je travaille sur le produit...',
  tool_read: '📄 Je lis un fichier...',
  tool_write: '✏️ J’écris un fichier...',
  tool_edit: '✏️ Je modifie un fichier...',
  tool_bash: '⚙️ J’exécute une commande...',
  tool_glob: '🔍 Je cherche des fichiers...',
  tool_grep: '🔍 Je cherche dans les fichiers...',
  tool_web_search: '🌐 Je cherche sur Internet...',
  tool_web_fetch: '🌐 J’ouvre une page...',
  tool_image: '🎨 Je prépare une image...',
  tool_upscale: '✨ J’améliore l’image...',
  tool_video: '🎬 Je lance la génération de la vidéo...',
  turn_failed: '⚠️ Impossible de traiter la demande : {reason}',
  delivery_failed: '⚠️ La réponse est prête, mais elle n’a pas pu être envoyée à cause d’une panne technique. Nous voyons déjà l’erreur — reposez votre question.',
  attach_failed: '(impossible de joindre le fichier : {reason})',
  video_queued: '🎬 La vidéo est en file d’attente (1 à 3 minutes). Je l’envoie dès qu’elle est prête.',
  video_failed: '⚠️ Impossible de générer la vidéo.',
  video_expired: '⚠️ La vidéo a été générée, mais n’a pas pu être livrée — le lien a expiré.',

  meeting_who: 'L’assistant va rejoindre la réunion',
  meeting_who_agent: '{agent} va rejoindre la réunion',
  meeting_join: 'Rejoindre la réunion',
  meeting_title: 'Réunion',
  meeting_title_meet: 'Réunion Google Meet',
  meeting_title_zoom: 'Réunion Zoom',
  meeting_link_expired: 'Le lien a expiré — renvoyez-le.',
  meeting_pick_assistant: 'Choisissez d’abord un assistant : /assistants',
  meeting_joined: '{agent} est dans la réunion.',
  meeting_busy: 'Une conversation est déjà en cours — terminez-la et réessayez.',
  meeting_unavailable: 'Impossible de rejoindre : la salle n’est pas disponible.',

  low_balance: '⚠️ Vos jetons s’épuisent : il en reste {balance}. Une fois épuisés, vos bots ne répondront plus. Recharger : https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ Vous n’avez plus de jetons — vos bots ne répondront pas tant que vous n’aurez pas rechargé votre solde : https://my.linkeon.io/tokens',

  cmd_assistants: 'Choisir un assistant',
  cmd_language: 'Langue des réponses',
  cmd_balance: 'Solde de jetons',
  cmd_balance_owner: 'Solde du propriétaire',
  cmd_silent_all: 'Me taire dans tous les groupes',
  cmd_silent_here: 'Me taire dans ce groupe',
  cmd_resume_all: 'Répondre de nouveau dans les groupes',
  cmd_resume_here: 'Répondre de nouveau ici',
  cmd_help: 'Ce que fait le bot',
};

const es: Catalog = {
  start_unlinked: '¡Hola! Para empezar, abre Linkeon: allí puedes crear una cuenta o vincular una que ya tengas.',
  start_hello: '¡Hola!',
  start_hello_agent: '¡Hola! Ahora responde <b>{agent}</b>.',
  start_body: 'Escribe aquí y el asistente te responderá. /assistants — cambiar de asistente, /balance — saldo.',
  unlinked_chat: 'Para que te responda, necesitas una cuenta de Linkeon: ábrela con el botón de abajo.',
  unlinked_command: 'Para este comando necesitas una cuenta de Linkeon: ábrela con el botón de abajo.',
  open_linkeon: 'Abrir Linkeon',
  bind_ok: '¡Hola! Tu Telegram ya está vinculado a Linkeon: puedes volver al sitio.',
  bind_ok_named: '¡Hola, {name}! Tu Telegram ya está vinculado a Linkeon: puedes volver al sitio.',
  bind_conflict: 'Este Telegram ({who}) ya está vinculado a otra cuenta de Linkeon. Un enlace nuevo no servirá: la restricción no está en el enlace. Abre el enlace desde la cuenta de Telegram que quieres vincular o desvincula primero esta de la cuenta anterior.',
  bind_failed: 'No se pudo vincular: {reason}. Consigue un enlace nuevo en Linkeon; puede que el anterior haya caducado (un enlace dura 15 minutos).',

  dm_help: 'Soy el bot de Linkeon: respondo aquí, en el chat privado, y en los grupos donde me añadió el propietario.\n\nComandos:\n/start — conectar Telegram con Linkeon\n/assistants — elegir el asistente de este chat\n/language — idioma de las respuestas\n/balance — saldo de tokens de tu cuenta\n/silent — callar en todos tus grupos\n/resume — volver a responder en ellos\n/help — este mensaje\n\nEn un grupo, /silent y /resume solo controlan el bot de ese grupo.\n\nTu cuenta: https://my.linkeon.io/telegram-bots',
  balance: 'Saldo de tokens: <b>{balance}</b>\nRecargar: https://my.linkeon.io/tokens',
  silent_none: 'No hay bots activos en grupos: nada que silenciar.',
  resume_none: 'No hay bots silenciados: nada que reactivar.',
  silenced: '🤫 Silenciados:',
  resumed: '✅ De nuevo activos:',
  list_private: '• <b>{name}</b> en el chat privado',
  list_group: '• <b>{name}</b> en «{group}»',
  list_group_untitled: '• <b>{name}</b> en un grupo',
  unknown_command: 'No conozco ese comando. /help — lista de comandos.',

  language_prompt: '¿En qué idioma respondo?',
  language_unknown: 'Ese idioma no existe',
  language_set: 'Listo, idioma de las respuestas: <b>{language}</b>.',
  assistants_prompt: '¿Quién debe responder?',
  assistants_current: 'Ahora responde <b>{agent}</b>. ¿Quién debe responder?',
  assistant_unknown: 'Ese asistente no existe',
  assistant_set: 'Ahora responde <b>{agent}</b>.',
  assistant_switched_note: '— A partir de aquí responde {agent}. —',
  nav_back: '← Atrás',
  nav_next: 'Siguiente →',

  claim_hello: 'Soy {name}. Llámame con @{bot} o respondiendo a este mensaje.',
  claim_failed: 'No se pudo conectar el bot: {reason}',
  bot_removed: 'El bot «{name}» fue eliminado de «{group}». Su configuración está archivada: puedes restaurarla en tu cuenta.',
  bot_removed_untitled: 'El bot «{name}» fue eliminado del grupo. Su configuración está archivada: puedes restaurarla en tu cuenta.',

  group_help: 'Soy <b>{name}</b> — {mode}.\n\nComandos:\n/help — este mensaje\n/balance — saldo del propietario (solo para el propietario)\n/silent — callar (solo para el propietario)\n/resume — volver a responder (solo para el propietario)\n\nTu cuenta: https://my.linkeon.io/telegram-bots',
  mode_strict: 'respondo solo cuando se dirigen a mí',
  mode_always: 'respondo a cada mensaje',
  mode_smart: 'intervengo cuando veo que conviene',
  owner_only: 'Solo el propietario del bot puede usar este comando.',
  group_silenced: '🤫 Me callo hasta /resume.',
  group_resumed: '✅ De vuelta.',
  dm_only: 'Este comando funciona en el chat privado con el bot: @{bot}',

  zero_balance_group: '⚠️ Al propietario se le han acabado los tokens. El bot no responderá hasta que se recargue el saldo: https://my.linkeon.io/tokens',
  busy: '⏳ Un momento: estoy terminando la solicitud anterior. Espera o vuelve a intentarlo en 30 segundos.',
  thinking: '🤔 Pensando...',
  tool_products: '🛠 Trabajando en el producto...',
  tool_read: '📄 Leyendo un archivo...',
  tool_write: '✏️ Escribiendo un archivo...',
  tool_edit: '✏️ Editando un archivo...',
  tool_bash: '⚙️ Ejecutando un comando...',
  tool_glob: '🔍 Buscando archivos...',
  tool_grep: '🔍 Buscando en archivos...',
  tool_web_search: '🌐 Buscando en internet...',
  tool_web_fetch: '🌐 Abriendo una página...',
  tool_image: '🎨 Preparando una imagen...',
  tool_upscale: '✨ Mejorando la imagen...',
  tool_video: '🎬 Iniciando la generación del vídeo...',
  turn_failed: '⚠️ No se pudo procesar la solicitud: {reason}',
  delivery_failed: '⚠️ La respuesta está lista, pero no se envió por un fallo técnico. Ya vemos el error: vuelve a preguntar.',
  attach_failed: '(no se pudo adjuntar el archivo: {reason})',
  video_queued: '🎬 El vídeo está en cola (1–3 minutos). Te lo envío en cuanto esté listo.',
  video_failed: '⚠️ No se pudo generar el vídeo.',
  video_expired: '⚠️ El vídeo se generó, pero no se pudo entregar: el enlace caducó.',

  meeting_who: 'El asistente entrará en la reunión',
  meeting_who_agent: '{agent} entrará en la reunión',
  meeting_join: 'Entrar en la reunión',
  meeting_title: 'Reunión',
  meeting_title_meet: 'Reunión de Google Meet',
  meeting_title_zoom: 'Reunión de Zoom',
  meeting_link_expired: 'El enlace ha caducado: envíalo otra vez.',
  meeting_pick_assistant: 'Primero elige un asistente: /assistants',
  meeting_joined: '{agent} está en la reunión.',
  meeting_busy: 'Ya hay una conversación en curso: termínala e inténtalo de nuevo.',
  meeting_unavailable: 'No se pudo entrar: la sala no está disponible.',

  low_balance: '⚠️ Te quedan pocos tokens: {balance} en el saldo. Cuando se acaben, tus bots dejarán de responder. Recargar: https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ Se te han acabado los tokens: tus bots no responderán hasta que recargues el saldo: https://my.linkeon.io/tokens',

  cmd_assistants: 'Elegir asistente',
  cmd_language: 'Idioma de las respuestas',
  cmd_balance: 'Saldo de tokens',
  cmd_balance_owner: 'Saldo del propietario',
  cmd_silent_all: 'Callar en todos los grupos',
  cmd_silent_here: 'Callar en este grupo',
  cmd_resume_all: 'Volver a responder en los grupos',
  cmd_resume_here: 'Volver a responder aquí',
  cmd_help: 'Qué sabe hacer el bot',
};

const pt: Catalog = {
  start_unlinked: 'Olá! Para começar, abre o Linkeon — lá podes criar uma conta ou associar uma que já tenhas.',
  start_hello: 'Olá!',
  start_hello_agent: 'Olá! Neste momento responde <b>{agent}</b>.',
  start_body: 'Escreve aqui e o assistente responde. /assistants — mudar de assistente, /balance — saldo.',
  unlinked_chat: 'Para eu responder, precisas de uma conta Linkeon — abre-a com o botão abaixo.',
  unlinked_command: 'Este comando precisa de uma conta Linkeon — abre-a com o botão abaixo.',
  open_linkeon: 'Abrir o Linkeon',
  bind_ok: 'Olá! O teu Telegram está associado ao Linkeon — podes voltar ao site.',
  bind_ok_named: 'Olá, {name}! O teu Telegram está associado ao Linkeon — podes voltar ao site.',
  bind_conflict: 'Este Telegram ({who}) já está associado a outra conta Linkeon. Um novo link não resolve — a restrição não está no link. Abre o link a partir da conta de Telegram que queres associar ou desassocia primeiro esta da conta antiga.',
  bind_failed: 'Não foi possível associar: {reason}. Obtém um novo link no Linkeon — o anterior pode ter expirado (cada link dura 15 minutos).',

  dm_help: 'Sou o bot do Linkeon — respondo aqui, na conversa privada, e nos grupos onde o proprietário me adicionou.\n\nComandos:\n/start — ligar o Telegram ao Linkeon\n/assistants — escolher o assistente desta conversa\n/language — idioma das respostas\n/balance — saldo de tokens da tua conta\n/silent — ficar em silêncio em todos os teus grupos\n/resume — voltar a responder neles\n/help — esta mensagem\n\nNum grupo, /silent e /resume controlam apenas o bot desse grupo.\n\nA tua área pessoal: https://my.linkeon.io/telegram-bots',
  balance: 'Saldo de tokens: <b>{balance}</b>\nCarregar: https://my.linkeon.io/tokens',
  silent_none: 'Não há bots ativos em grupos — nada para silenciar.',
  resume_none: 'Não há bots silenciados — nada para reativar.',
  silenced: '🤫 Em silêncio:',
  resumed: '✅ De novo ativos:',
  list_private: '• <b>{name}</b> na conversa privada',
  list_group: '• <b>{name}</b> em «{group}»',
  list_group_untitled: '• <b>{name}</b> num grupo',
  unknown_command: 'Não conheço esse comando. /help — lista de comandos.',

  language_prompt: 'Em que idioma devo responder?',
  language_unknown: 'Esse idioma não existe',
  language_set: 'Feito — idioma das respostas: <b>{language}</b>.',
  assistants_prompt: 'Quem deve responder?',
  assistants_current: 'Neste momento responde <b>{agent}</b>. Quem deve responder?',
  assistant_unknown: 'Esse assistente não existe',
  assistant_set: 'Agora responde <b>{agent}</b>.',
  assistant_switched_note: '— A partir daqui responde {agent}. —',
  nav_back: '← Voltar',
  nav_next: 'Seguinte →',

  claim_hello: 'Sou {name}. Chama-me com @{bot} ou responde a esta mensagem.',
  claim_failed: 'Não foi possível ligar o bot: {reason}',
  bot_removed: 'O bot «{name}» foi removido de «{group}». As definições ficaram arquivadas — podes restaurá-las na tua área pessoal.',
  bot_removed_untitled: 'O bot «{name}» foi removido do grupo. As definições ficaram arquivadas — podes restaurá-las na tua área pessoal.',

  group_help: 'Sou <b>{name}</b> — {mode}.\n\nComandos:\n/help — esta mensagem\n/balance — saldo do proprietário (só para o proprietário)\n/silent — ficar em silêncio (só para o proprietário)\n/resume — voltar a responder (só para o proprietário)\n\nA tua área pessoal: https://my.linkeon.io/telegram-bots',
  mode_strict: 'respondo só quando me chamam',
  mode_always: 'respondo a todas as mensagens',
  mode_smart: 'intervenho quando vejo que vale a pena',
  owner_only: 'Só o proprietário do bot pode usar este comando.',
  group_silenced: '🤫 Fico em silêncio até /resume.',
  group_resumed: '✅ De volta.',
  dm_only: 'Este comando funciona na conversa privada com o bot: @{bot}',

  zero_balance_group: '⚠️ O proprietário ficou sem tokens. O bot não responde até o saldo ser carregado: https://my.linkeon.io/tokens',
  busy: '⏳ Um momento — estou a terminar o pedido anterior. Espera ou tenta de novo daqui a 30 segundos.',
  thinking: '🤔 A pensar...',
  tool_products: '🛠 A trabalhar no produto...',
  tool_read: '📄 A ler um ficheiro...',
  tool_write: '✏️ A escrever um ficheiro...',
  tool_edit: '✏️ A editar um ficheiro...',
  tool_bash: '⚙️ A executar um comando...',
  tool_glob: '🔍 A procurar ficheiros...',
  tool_grep: '🔍 A procurar nos ficheiros...',
  tool_web_search: '🌐 A pesquisar na internet...',
  tool_web_fetch: '🌐 A abrir uma página...',
  tool_image: '🎨 A preparar uma imagem...',
  tool_upscale: '✨ A melhorar a imagem...',
  tool_video: '🎬 A iniciar a geração do vídeo...',
  turn_failed: '⚠️ Não foi possível processar o pedido: {reason}',
  delivery_failed: '⚠️ A resposta está pronta, mas não foi enviada por causa de uma falha técnica. Já estamos a ver o erro — pergunta outra vez.',
  attach_failed: '(não foi possível anexar o ficheiro: {reason})',
  video_queued: '🎬 O vídeo está na fila (1–3 minutos). Envio-o assim que estiver pronto.',
  video_failed: '⚠️ Não foi possível gerar o vídeo.',
  video_expired: '⚠️ O vídeo foi gerado, mas não foi possível entregá-lo — o link expirou.',

  meeting_who: 'O assistente vai entrar na reunião',
  meeting_who_agent: '{agent} vai entrar na reunião',
  meeting_join: 'Entrar na reunião',
  meeting_title: 'Reunião',
  meeting_title_meet: 'Reunião do Google Meet',
  meeting_title_zoom: 'Reunião do Zoom',
  meeting_link_expired: 'O link expirou — envia-o outra vez.',
  meeting_pick_assistant: 'Escolhe primeiro um assistente: /assistants',
  meeting_joined: '{agent} está na reunião.',
  meeting_busy: 'Já há uma conversa a decorrer — termina-a e tenta de novo.',
  meeting_unavailable: 'Não foi possível entrar: a sala não está disponível.',

  low_balance: '⚠️ Os tokens estão a acabar: restam {balance}. Quando acabarem, os teus bots deixam de responder. Carregar: https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ Ficaste sem tokens — os teus bots não respondem até carregares o saldo: https://my.linkeon.io/tokens',

  cmd_assistants: 'Escolher assistente',
  cmd_language: 'Idioma das respostas',
  cmd_balance: 'Saldo de tokens',
  cmd_balance_owner: 'Saldo do proprietário',
  cmd_silent_all: 'Silêncio em todos os grupos',
  cmd_silent_here: 'Silêncio neste grupo',
  cmd_resume_all: 'Voltar a responder nos grupos',
  cmd_resume_here: 'Voltar a responder aqui',
  cmd_help: 'O que o bot sabe fazer',
};

const zh: Catalog = {
  start_unlinked: '您好！请先打开 Linkeon——在那里可以注册账号，或绑定已有账号。',
  start_hello: '您好！',
  start_hello_agent: '您好！当前由<b>{agent}</b>回复。',
  start_body: '在这里留言，助手会回复您。/assistants — 更换助手，/balance — 余额。',
  unlinked_chat: '需要 Linkeon 账号我才能回复——请点击下方按钮打开。',
  unlinked_command: '此命令需要 Linkeon 账号——请点击下方按钮打开。',
  open_linkeon: '打开 Linkeon',
  bind_ok: '您好！您的 Telegram 已绑定 Linkeon——可以回到网站了。',
  bind_ok_named: '{name}，您好！您的 Telegram 已绑定 Linkeon——可以回到网站了。',
  bind_conflict: '此 Telegram（{who}）已绑定到另一个 Linkeon 账号。换新链接也没用——限制不在链接上。请用想要绑定的 Telegram 账号打开链接，或先将此账号与旧账号解绑。',
  bind_failed: '绑定失败：{reason}。请在 Linkeon 中获取新链接——旧链接可能已过期（链接有效期 15 分钟）。',

  dm_help: '我是 Linkeon 机器人——在这里的私聊中，以及所有者把我加入的群组中回复。\n\n命令：\n/start — 将 Telegram 连接到 Linkeon\n/assistants — 选择私聊中的助手\n/language — 回复语言\n/balance — 您账号的代币余额\n/silent — 在您的所有群组中保持安静\n/resume — 在群组中恢复回复\n/help — 本消息\n\n在群组中，/silent 和 /resume 只控制该群组的机器人。\n\n个人账户：https://my.linkeon.io/telegram-bots',
  balance: '代币余额：<b>{balance}</b>\n充值：https://my.linkeon.io/tokens',
  silent_none: '群组中没有活跃的机器人——无需静音。',
  resume_none: '没有静音中的机器人——无需恢复。',
  silenced: '🤫 已静音：',
  resumed: '✅ 已恢复：',
  list_private: '• <b>{name}</b>（私聊）',
  list_group: '• <b>{name}</b>（「{group}」）',
  list_group_untitled: '• <b>{name}</b>（群组）',
  unknown_command: '我不认识这个命令。/help — 命令列表。',

  language_prompt: '用哪种语言回复？',
  language_unknown: '没有这种语言',
  language_set: '好的，回复语言：<b>{language}</b>。',
  assistants_prompt: '请谁来回复？',
  assistants_current: '当前由<b>{agent}</b>回复。请谁来回复？',
  assistant_unknown: '没有这个助手',
  assistant_set: '现在由<b>{agent}</b>回复。',
  assistant_switched_note: '— 接下来由{agent}回复。—',
  nav_back: '← 上一页',
  nav_next: '下一页 →',

  claim_hello: '我是{name}。可以用 @{bot} 叫我，或回复这条消息。',
  claim_failed: '机器人连接失败：{reason}',
  bot_removed: '机器人「{name}」已被移出「{group}」。设置已归档——可以在个人账户中恢复。',
  bot_removed_untitled: '机器人「{name}」已被移出群组。设置已归档——可以在个人账户中恢复。',

  group_help: '我是<b>{name}</b>——{mode}。\n\n命令：\n/help — 本消息\n/balance — 所有者的余额（仅限所有者）\n/silent — 保持安静（仅限所有者）\n/resume — 恢复回复（仅限所有者）\n\n个人账户：https://my.linkeon.io/telegram-bots',
  mode_strict: '只在被叫到时回复',
  mode_always: '回复每一条消息',
  mode_smart: '觉得合适时才插话',
  owner_only: '只有机器人的所有者才能使用此命令。',
  group_silenced: '🤫 保持安静，直到 /resume。',
  group_resumed: '✅ 我回来了。',
  dm_only: '此命令只能在与机器人的私聊中使用：@{bot}',

  zero_balance_group: '⚠️ 所有者的代币已用完。充值前机器人不会回复：https://my.linkeon.io/tokens',
  busy: '⏳ 请稍等——正在完成上一个请求。请等待，或 30 秒后重试。',
  thinking: '🤔 思考中...',
  tool_products: '🛠 正在处理产品...',
  tool_read: '📄 正在读取文件...',
  tool_write: '✏️ 正在写入文件...',
  tool_edit: '✏️ 正在编辑文件...',
  tool_bash: '⚙️ 正在执行命令...',
  tool_glob: '🔍 正在查找文件...',
  tool_grep: '🔍 正在文件中搜索...',
  tool_web_search: '🌐 正在网上搜索...',
  tool_web_fetch: '🌐 正在打开网页...',
  tool_image: '🎨 正在准备图片...',
  tool_upscale: '✨ 正在优化图片...',
  tool_video: '🎬 正在开始生成视频...',
  turn_failed: '⚠️ 无法处理请求：{reason}',
  delivery_failed: '⚠️ 回复已准备好，但因技术故障未能发送。我们已发现该错误——请重新提问。',
  attach_failed: '（无法附加文件：{reason}）',
  video_queued: '🎬 视频正在排队（1–3 分钟）。完成后我会立即发送。',
  video_failed: '⚠️ 视频生成失败。',
  video_expired: '⚠️ 视频已生成，但无法送达——链接已过期。',

  meeting_who: '助手将加入会议',
  meeting_who_agent: '{agent}将加入会议',
  meeting_join: '加入会议',
  meeting_title: '会议',
  meeting_title_meet: 'Google Meet 会议',
  meeting_title_zoom: 'Zoom 会议',
  meeting_link_expired: '链接已过期——请重新发送。',
  meeting_pick_assistant: '请先选择助手：/assistants',
  meeting_joined: '{agent}已加入会议。',
  meeting_busy: '已有对话在进行中——请先结束再重试。',
  meeting_unavailable: '无法加入：会议室不可用。',

  low_balance: '⚠️ 代币即将用完：余额还剩 {balance}。用完后您的机器人将停止回复。充值：https://my.linkeon.io/tokens',
  zero_balance_owner: '⛔ 代币已用完——充值前您的机器人不会回复：https://my.linkeon.io/tokens',

  cmd_assistants: '选择助手',
  cmd_language: '回复语言',
  cmd_balance: '代币余额',
  cmd_balance_owner: '所有者的余额',
  cmd_silent_all: '在所有群组中保持安静',
  cmd_silent_here: '在此群组中保持安静',
  cmd_resume_all: '在群组中恢复回复',
  cmd_resume_here: '在此恢复回复',
  cmd_help: '机器人能做什么',
};

export const TG_TEXTS: Record<TgLang, Catalog> = { ru, en, es, de, fr, zh, pt };

/** Текст на языке lang; незнакомый язык — язык по умолчанию (как у ассистентов). */
export function tgText(
  lang: string | null | undefined,
  key: TgTextKey,
  params: Record<string, string | number> = {},
): string {
  const l = LanguageService.normalize(lang) as TgLang;
  const tpl = TG_TEXTS[l]?.[key] ?? TG_TEXTS[DEFAULT_LANGUAGE as TgLang][key];
  return tpl.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m));
}

export function formatTgNumber(lang: string | null | undefined, n: number): string {
  return n.toLocaleString(NUMBER_LOCALE[LanguageService.normalize(lang) as TgLang]);
}

/**
 * Язык для человека: язык профиля Linkeon, если он задан, иначе язык клиента
 * Telegram. Клиент на языке, которого у нас нет, — английский: русский такому
 * человеку чужой точно так же (и веб поступает так же с uk/kk/be).
 */
export function pickTgLanguage(profileLang?: string | null, tgLanguageCode?: string | null): TgLang {
  if (profileLang && String(profileLang).trim()) return LanguageService.normalize(profileLang) as TgLang;
  if (tgLanguageCode && String(tgLanguageCode).trim()) {
    const root = String(tgLanguageCode).toLowerCase().split(/[-_]/)[0];
    return (SUPPORTED_LANGUAGES as readonly string[]).includes(root) ? (root as TgLang) : 'en';
  }
  return DEFAULT_LANGUAGE as TgLang;
}

/** Язык владельца (profile_data.language) с запасным — языком клиента Telegram. Не бросает. */
export async function ownerTgLanguage(
  pg: Pick<PgService, 'query'> | null | undefined,
  ownerUserId: string | null | undefined,
  tgLanguageCode?: string | null,
): Promise<TgLang> {
  let profileLang: string | null = null;
  if (ownerUserId && pg) {
    try {
      const r = await pg.query(
        `SELECT profile_data->>'language' AS language FROM ai_profiles_consolidated WHERE user_id = $1 LIMIT 1`,
        [ownerUserId],
      );
      profileLang = r?.rows?.[0]?.language ?? null;
    } catch {
      // Язык — не повод ронять ответ: останемся на запасном.
    }
  }
  return pickTgLanguage(profileLang, tgLanguageCode);
}

/**
 * Меню команд (кнопка «/» в Telegram) — своё для личек и для групп и на
 * каждом языке. В группе ассистента и язык не меняют (это личка и кабинет),
 * поэтому /assistants и /language там не показываем. Без language_code —
 * английский: для клиентов на языках, которых у нас нет.
 */
export function tgCommandMenus(): Array<{
  scope: 'all_private_chats' | 'all_group_chats';
  language_code?: TgLang;
  commands: Array<{ command: string; description: string }>;
}> {
  const privateMenu = (l: TgLang) => [
    { command: 'assistants', description: TG_TEXTS[l].cmd_assistants },
    { command: 'language', description: TG_TEXTS[l].cmd_language },
    { command: 'balance', description: TG_TEXTS[l].cmd_balance },
    { command: 'silent', description: TG_TEXTS[l].cmd_silent_all },
    { command: 'resume', description: TG_TEXTS[l].cmd_resume_all },
    { command: 'help', description: TG_TEXTS[l].cmd_help },
  ];
  const groupMenu = (l: TgLang) => [
    { command: 'help', description: TG_TEXTS[l].cmd_help },
    { command: 'balance', description: TG_TEXTS[l].cmd_balance_owner },
    { command: 'silent', description: TG_TEXTS[l].cmd_silent_here },
    { command: 'resume', description: TG_TEXTS[l].cmd_resume_here },
  ];
  const menus: ReturnType<typeof tgCommandMenus> = [
    { scope: 'all_private_chats', commands: privateMenu('en') },
    { scope: 'all_group_chats', commands: groupMenu('en') },
  ];
  for (const l of TG_LANGS) {
    menus.push({ scope: 'all_private_chats', language_code: l, commands: privateMenu(l) });
    menus.push({ scope: 'all_group_chats', language_code: l, commands: groupMenu(l) });
  }
  return menus;
}
