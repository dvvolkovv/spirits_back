import type { KbArticle } from '../kb.types';
import { V } from '../values';

// источник: файлы — spirits_front src/components/chat/ChatInterface.tsx:2171-2337; src/chat/upload-limits.ts; src/chat/chat.controller.ts (upload, 413)
// источник: Маша и PDF — src/chat/chat.controller.ts:555-633
// источник: голосовой ввод — spirits_front src/services/voiceDictation.ts; src/voice/voice-ws.ts (язык профиля, lang_unsupported); src/voice/speechkit-stt.service.ts (SPEECHKIT_LANGUAGE_CODES: без zh; speechkitLanguageCodes: к нерусскому — ru-RU)
// источник: «Чистый лист» — src/chat/chat.controller.ts:131-136; src/chat/chat.service.ts (fresh)
// источник: «Медиа и файлы» — spirits_front src/components/chat/files/chatFiles.ts, ChatFilesPanel.tsx (загрузки, пометка, удаление); src/chat/chat-files/chat-files.service.ts (listForSession: загрузки из chat_uploads)
// источник: комментарии к загрузкам — src/chat/chat-files/note-file.tool.ts (note_file); find_files ищет по комментарию — src/chat/chat-files/find-files.ts (scoreUpload)
// источник: удаление загрузки — src/chat/chat-uploads/chat-uploads.controller.ts (DELETE :id, только владелец)
// источник: карточки вопросов — src/chat/ask-rule.ts; spirits_front src/components/chat/AskCard.tsx
// источник: что умеют ассистенты — relay-agent/server.mjs (SYSTEM_PROMPT); src/chat/chat.service.ts (YouTube)
// источник: find_files у Маши — src/chat/chat.service.ts (allowedTools: FIND_FILES_CLI_TOOL_NAME)
// источник: оборванный ответ — spirits_front src/components/chat/streamFailure.ts, remoteTurn.ts:66; relay-agent/server.mjs (тексты сбоя); списание оборванного хода — src/chat/partial-billing.ts
export const chat: KbArticle = {
  id: 'chat',
  title: 'Чат с ассистентом',
  summary: 'чат: файлы, голосовой ввод, озвучка ответа, чистый лист, медиа и файлы, карточки вопросов, оборванный ответ',
  related: ['speech', 'images', 'support'],
  render: ({ q, paid, url }) => `
## Что это
Разговор с выбранным ассистентом. Ассистент видит профиль человека и карточку ${q('business')}, помнит историю этого чата.

## Где
${q('chat')}: список ассистентов (на телефоне — отдельный экран) и чат. В шапке чата — смена ассистента, ${q('call')}, ${q('fresh')} и ${q('files')}; на узком экране часть кнопок — в меню «⋯».
Ссылка: ${url('chat')}

## Как
- Файлы — кнопкой «+», окно ${q('uploadTitle')}: до ${V.uploadMaxFiles} файлов за раз, вместе до ${V.uploadMaxMb} МБ, формат любой. Отправляются вместе с текстом задания.
- Маше — только PDF, один файл: из него она берёт сведения о человеке. Разобрать документ по существу — к другому ассистенту.
- ${q('voiceInput')} — микрофон в поле сообщения: речь превращается в текст. Понимает язык профиля (${q('language')}) и русский; китайский профиль — пока нет.
- ${q('listen')} под ответом — ответ голосом (тема speech).
- ${q('fresh')} — разговор без прошлой истории и задач; профиль и ${q('business')} ассистент видит. Режим живёт в этой вкладке браузера.
- ${q('files')} — файлы чата: созданные ассистентом и загруженные человеком; ${q('filesMedia')} — картинки и видео, ${q('filesDocs')} — остальное. К загрузке ассистент оставляет комментарий и по нему находит файл в любом чате. Свою загрузку человек удаляет там же — ассистенты её больше не откроют.
- Уточнение ассистент иногда задаёт карточкой с вариантами: выбрать вариант или ${q('askCustom')} и ${q('askSubmit')}.
- Ассистенты, кроме Маши, создают документы, презентации и PDF файлами, ищут в интернете и берут расшифровку видео YouTube по ссылке. Файлы из прошлых разговоров находят все, и Маша тоже.

## Чего нельзя
- Приложить файл, пока ассистент отвечает.
- Маша не рисует, не делает видео и не ищет в интернете — для этого другие ассистенты или ${q('imageGen')} и ${q('video')}.

## Если не получается
- Ответ ещё идёт — новые сообщения встают в очередь и уйдут после него. После перезагрузки страницы видно, что ассистент работает: ответ придёт сам; через пару минут появится ${q('sendAnyway')} — отправит сразу, обычно прервав прошлую работу ассистента (у Маши — нет).
- Ответ оборвался или пришло сообщение о временном сбое — написать «продолжай»${paid('; оборванный ход оплачивается по сделанной работе')}.
- Файл не отправляется — проверить размер и число файлов, добавить текст задания.
- Голосовой ввод пишет не то — проверить язык профиля (${q('language')}).
- Ничего не помогло — ${q('support')} в разделе ${q('help')}.

## Как устроено
Разговоры ведут модели Claude (Anthropic) с инструментами Linkeon: картинки, видео, озвучка, календарь, файлы.
`,
};
