import { fileExt, lastPathSegment, relayFileName, safeFileName } from './file-meta';

/**
 * Что из текста ответа ассистента — файл. Нужно панели «Медиа и файлы» и
 * инструменту find_files.
 *
 * Правила повторяют то, что чат и так показывает картинкой, плеером или
 * ссылкой на скачивание (spirits_front: src/utils/customMarkdown.tsx): панель
 * обязана совпадать с лентой. Ссылки на чужие сайты — не файлы, даже с
 * расширением в адресе: их создавал не ассистент.
 */

export type ChatFileKind = 'image' | 'video' | 'document' | 'audio';

export interface ExtractedFile {
  kind: ChatFileKind;
  source: 'url' | 'video_job' | 'audio_clip';
  /** Есть у source 'url'. */
  url?: string;
  /** Есть у video_job и audio_clip: uuid из маркера. */
  refId?: string;
  name: string;
  ext: string;
  /** false — файл лежит на релее и пропадает: скачивать его панель не предлагает. */
  stored: boolean;
}

export interface ExtractEnv {
  /** MINIO_PUBLIC_URL без хвостового слэша. */
  publicBaseUrl: string;
  /** AGENT_URL без хвостового слэша. */
  agentUrl: string;
  /** BACKEND_URL без хвостового слэша — для /static/. */
  backendUrl: string;
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const VIDEO_JOB_RE = new RegExp(`\\[VIDEO_JOB:(${UUID})\\]`, 'gi');
const AUDIO_RE = new RegExp(`\\{\\{audio:id=(${UUID})\\}\\}`, 'gi');
// Цель ссылки допускает один уровень парных скобок: имена вида
// «Договор (1).docx» на релее не кодируются, и `[^)]+` обрезал бы адрес.
const MD_IMAGE_RE = /!\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;
// (?<!!) — не картинка; просмотр назад, а не захват символа: иначе соседние
// ссылки `[a](x)[b](y)` теряли бы вторую.
const MD_LINK_RE = /(?<!!)\[([^\]]*)\]\(((?:[^()\n]|\([^()\n]*\))+)\)/g;
// Те же, что IMAGE_URL_REGEX и VIDEO_URL_REGEX во фронте (customMarkdown.tsx).
const BARE_IMAGE_RE = /(?<!\()https?:\/\/\S+?\.(?:png|jpe?g|webp|gif)(?:\?\S*)?/gi;
const BARE_VIDEO_RE = /(?<!\()https?:\/\/\S+?\.(?:mp4|webm)(?:\?\S*)?/gi;

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'm4a']);

export function kindByExt(ext: string): ChatFileKind {
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  return 'document';
}

/** Код в ответе — текст, а не ссылки: в чате там ничего не кликается. */
function stripCode(content: string): string {
  return content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
}

/** Цель ссылки без заголовка: `url "title"` → `url`. */
function linkTarget(raw: string): string {
  const t = raw.trim();
  const q = t.search(/\s+"/);
  return (q > 0 ? t.slice(0, q) : t).trim();
}

/** Ближайший слева заголовок `## …` — так бэк подписывает документ звонка. */
function headingBefore(content: string, index: number): string | null {
  const all = [...content.slice(0, index).matchAll(/^##\s+(.+)$/gm)];
  return all.length > 0 ? all[all.length - 1][1].trim() : null;
}

export function extractChatFiles(content: string, env: ExtractEnv): ExtractedFile[] {
  const text = stripCode(String(content ?? ''));
  const relayPrefix = `${env.agentUrl}/files/`;
  const ours = (url: string) =>
    (env.publicBaseUrl !== '' && url.startsWith(`${env.publicBaseUrl}/`)) ||
    url.startsWith(`${env.backendUrl}/static/`) ||
    url.startsWith(relayPrefix);

  const fromUrl = (url: string, index: number, kind?: ChatFileKind): ExtractedFile | null => {
    // Адреса релея сырые: `#` и `?` там — часть имени, а не якорь и запрос.
    const seg = url.startsWith(relayPrefix) ? relayFileName(url) : lastPathSegment(url);
    const ext = fileExt(seg);
    if (!kind && !ext) return null;
    let name = safeFileName(seg);
    if (/\/documents\/[^/]+\/[^/]+\.md$/i.test(url.split(/[?#]/)[0])) {
      const heading = headingBefore(text, index);
      if (heading) name = safeFileName(`${heading}.md`);
    }
    return { kind: kind ?? kindByExt(ext), source: 'url', url, name, ext, stored: !url.startsWith(relayPrefix) };
  };

  const found: { index: number; file: ExtractedFile }[] = [];
  for (const m of text.matchAll(VIDEO_JOB_RE)) {
    const id = m[1].toLowerCase();
    found.push({
      index: m.index ?? 0,
      file: { kind: 'video', source: 'video_job', refId: id, name: `video-${id.slice(0, 8)}.mp4`, ext: 'mp4', stored: true },
    });
  }
  for (const m of text.matchAll(AUDIO_RE)) {
    const id = m[1].toLowerCase();
    found.push({
      index: m.index ?? 0,
      file: { kind: 'audio', source: 'audio_clip', refId: id, name: `linkeon-speech-${id.slice(0, 8)}.mp3`, ext: 'mp3', stored: true },
    });
  }
  for (const m of text.matchAll(MD_IMAGE_RE)) {
    const url = linkTarget(m[2]);
    if (!/^https?:\/\//i.test(url)) continue;
    const f = fromUrl(url, m.index ?? 0, 'image');
    if (f) found.push({ index: m.index ?? 0, file: f });
  }
  for (const m of text.matchAll(MD_LINK_RE)) {
    const url = linkTarget(m[2]);
    if (!ours(url)) continue;
    const f = fromUrl(url, m.index ?? 0);
    if (f) found.push({ index: m.index ?? 0, file: f });
  }
  for (const [re, kind] of [[BARE_IMAGE_RE, 'image'], [BARE_VIDEO_RE, 'video']] as const) {
    for (const m of text.matchAll(re)) {
      const f = fromUrl(m[0], m.index ?? 0, kind);
      if (f) found.push({ index: m.index ?? 0, file: f });
    }
  }

  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: ExtractedFile[] = [];
  for (const { file } of found) {
    const key = file.url ?? `${file.source}:${file.refId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(file);
  }
  return out;
}
