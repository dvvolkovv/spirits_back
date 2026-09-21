export type BlogCallbackAction = 'ok' | 'redo' | 'no';

export interface BlogCallback {
  action: BlogCallbackAction;
  postId: string;
}

const ACTIONS: BlogCallbackAction[] = ['ok', 'redo', 'no'];

export function parseBlogCallback(data: string): BlogCallback | null {
  const parts = String(data || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'blog') return null;
  const action = parts[1] as BlogCallbackAction;
  if (!ACTIONS.includes(action) || !parts[2]) return null;
  return { action, postId: parts[2] };
}

export function buildBlogKeyboard(postId: string): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: [[
      { text: '✅ Опубликовать', callback_data: `blog:ok:${postId}` },
      { text: '🔄 Переписать',  callback_data: `blog:redo:${postId}` },
      { text: '🗑 В мусор',      callback_data: `blog:no:${postId}` },
    ]],
  };
}
