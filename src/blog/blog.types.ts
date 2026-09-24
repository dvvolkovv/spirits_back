export type BlogRubric = 'news' | 'case';
export type BlogSource = 'backlog' | 'git' | 'stats' | 'manual';
export type BlogStatus =
  | 'idea' | 'drafting' | 'pending_review' | 'approved'
  | 'publishing' | 'published' | 'rejected' | 'failed';

export interface BlogPost {
  id: string;
  rubric: BlogRubric;
  source: BlogSource;
  sourceRef: string | null;
  topicKey: string;
  topicHint: string | null;
  lang: string;
  title: string | null;
  body: string | null;
  imagePrompt: string | null;
  imageUrl: string | null;
  status: BlogStatus;
  /**
   * Замечания владельца к черновику, от самого раннего к самому свежему.
   * Пустой список — нормальное состояние: пост, к которому претензий не было.
   */
  editorNotes: string[];
  /**
   * id сообщений-приглашений «Что поправить?» (кнопка «✍️ Замечание»), от
   * старых к новым. Ответ владельца ссылается на ПРИГЛАШЕНИЕ, а не на
   * черновик, — по этому списку `handleReplyEdit` и узнаёт его своим.
   */
  notePromptIds: number[];
  /**
   * Когда черновик взяли в работу. Пусто — «готов к работе прямо сейчас»,
   * именно по этому признаку `takeNextIdea` отбирает посты, а `prepareDrafts`
   * их захватывает.
   */
  draftingStartedAt: string | null;
  slotAt: string | null;
  publishedAt: string | null;
  reviewChatId: number | null;
  reviewMessageId: number | null;
  tgMessageId: number | null;
  tgUrl: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Допустимые переходы. Главное, что здесь закрыто: пост не может попасть
 * в канал минуя pending_review — автопостинг без человека не предусмотрен
 * ни одним путём, а не «просто не вызывается».
 */
export const ALLOWED_TRANSITIONS: Record<BlogStatus, BlogStatus[]> = {
  idea:           ['drafting', 'rejected'],
  // Петля `drafting → drafting` — это перезапуск черновика, а не новый
  // переход: сюда приходят и кнопка «Переписать» (пост уже в `drafting`), и
  // крон, подобравший черновик, осиротевший после падения процесса. Без неё
  // такой пост не пропускает собственная охрана `prepareDrafts`, и обещание
  // «перепишу к следующему тику» не наступает никогда. Апрув петля не
  // обходит: она никуда не продвигает, а `drafting → approved` по-прежнему
  // запрещён.
  drafting:       ['drafting', 'pending_review', 'failed'],
  pending_review: ['approved', 'drafting', 'rejected'],
  approved:       ['publishing', 'drafting', 'rejected'],
  // `approved` здесь — это возврат на повторную попытку отправки, а не
  // повторный апрув: Telegram отвалился по таймауту, пост ждёт следующего
  // тика крона. Переход безопасен именно потому, что в `publishing` нельзя
  // попасть ниоткуда, кроме `approved`, — то есть человек этот пост уже
  // одобрил. Разрешать возврат из `failed` нельзя: туда попадают и
  // черновики со стадии `drafting`, и такой переход открыл бы дорогу
  // «черновик → approved → в канал» мимо человека.
  publishing:     ['published', 'approved', 'failed'],
  published:      [],
  rejected:       [],
  failed:         ['drafting', 'rejected'],
};

export function canTransition(from: BlogStatus, to: BlogStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] || []).includes(to);
}

/**
 * Сколько замечаний держим на посту.
 *
 * Каждое уходит в сообщение редактору целиком, рядом с правилами рубрики и
 * списком прошлых заголовков. Бесконечный список утопил бы в себе и то, и
 * другое — а пост, к которому шестой раз есть претензия, лечится не шестым
 * замечанием, а кнопкой «В мусор».
 *
 * Пять — это пять кругов переработки, каждый из которых стоит тика крона,
 * похода к релею и генерации картинки. Живой владелец даёт два-три.
 */
export const MAX_EDITOR_NOTES = 5;

/**
 * Длина одного замечания. Сам пост — не длиннее 900 символов (подпись к
 * картинке в Telegram), так что замечание на 600 — это уже подробный разбор.
 * Всё, что длиннее, — не замечание, а переписанный пост, присланный реплаем;
 * ровно от этого способа правки мы и уходим.
 *
 * Обрезаем с конца: суть замечания владелец пишет в первой фразе.
 */
export const MAX_EDITOR_NOTE_LEN = 600;

/**
 * Сколько приглашений к замечанию помним на посте.
 *
 * Предел нужен только против бесконечного роста: кнопку можно жать, ничего
 * не отвечая. Сверх него выпадает САМОЕ СТАРОЕ приглашение, и ответ на него
 * уже не узнаётся — уйдёт ассистенту. Это ровно та беда, ради которой список
 * заведён, поэтому предел взят с большим запасом. Живой пост — одно-два
 * нажатия на круг переработки и до пяти кругов (`MAX_EDITOR_NOTES`), то есть
 * до десяти приглашений; двадцать — вдвое больше и этого. Стоит это 160 байт
 * на строку.
 */
export const MAX_NOTE_PROMPTS = 20;

/**
 * Замечание в конец списка. Накопление — смысл всей конструкции: второе
 * замечание владелец пишет, глядя на второй черновик, но первое от этого не
 * перестаёт действовать, и затирать его значит чинить одно и ломать другое
 * по кругу.
 *
 * Сверх предела уходит САМОЕ СТАРОЕ. Выбросить пришедшее сейчас значило бы
 * молча проигнорировать владельца в ответ на его же сообщение; старое
 * замечание, если оно всё ещё не выполнено, вернётся следующим реплаем.
 */
export function appendEditorNote(notes: string[] | null | undefined, note: string): string[] {
  const text = String(note ?? '').trim().slice(0, MAX_EDITOR_NOTE_LEN);
  const kept = Array.isArray(notes) ? notes : [];
  if (!text) return kept;
  return [...kept, text].slice(-MAX_EDITOR_NOTES);
}

const num = (v: any): number | null => (v === null || v === undefined ? null : Number(v));

export function rowToPost(row: any): BlogPost {
  return {
    id: row.id,
    rubric: row.rubric,
    source: row.source,
    sourceRef: row.source_ref ?? null,
    topicKey: row.topic_key,
    topicHint: row.topic_hint ?? null,
    lang: row.lang,
    title: row.title ?? null,
    body: row.body ?? null,
    imagePrompt: row.image_prompt ?? null,
    imageUrl: row.image_url ?? null,
    status: row.status,
    // Пост, заведённый до миграции 002, колонки не имеет вовсе. Пустой список
    // здесь — не «на всякий случай»: без него редактор получил бы
    // `undefined.length` и черновик падал бы в failed на ровном месте.
    editorNotes: Array.isArray(row.editor_notes) ? row.editor_notes : [],
    // bigint[] node-pg отдаёт строками поэлементно; сравнение `'13' === 13`
    // молча ложно, поэтому — числами, как и reviewMessageId.
    notePromptIds: Array.isArray(row.note_prompt_ids) ? row.note_prompt_ids.map(Number) : [],
    draftingStartedAt: row.drafting_started_at ?? null,
    slotAt: row.slot_at ?? null,
    publishedAt: row.published_at ?? null,
    reviewChatId: num(row.review_chat_id),
    reviewMessageId: num(row.review_message_id),
    tgMessageId: num(row.tg_message_id),
    tgUrl: row.tg_url ?? null,
    attempts: Number(row.attempts || 0),
    lastError: row.last_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
