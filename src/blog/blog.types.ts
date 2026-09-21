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
