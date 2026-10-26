/** Транслитерация для меток: в utm_campaign — только латиница, цифры и подчёркивание. */
const MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export const SLUG_MAX = 40;
/** Тот же формат разбирает vk-ads.service ([A-Za-z0-9_]+); CHECK в 001_shorts.sql — такой же. */
export const SLUG_PATTERN = /^[a-z0-9_]{1,40}$/;

export function slugBase(text: string): string {
  const latin = Array.from(String(text ?? '').toLowerCase())
    .map((ch) => (ch in MAP ? MAP[ch] : ch))
    .join('');
  return latin.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/** Слаг ролика: основа до 35 знаков и первые 4 знака id. */
export function shortSlug(text: string, id: string): string {
  const tail = String(id ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || '0000';
  const base = slugBase(text).slice(0, SLUG_MAX - tail.length - 1).replace(/_+$/, '') || 'short';
  return `${base}_${tail}`;
}
