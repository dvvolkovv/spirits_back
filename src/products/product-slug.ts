import * as crypto from 'crypto';
import { SLUG_RE } from './provisioning.service';

/** Потолок длины — тот же, что у SLUG_RE (1–40). */
export const SLUG_MAX = 40;
const SUFFIX_LEN = 6;
const SUFFIX_ABC = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Та же таблица, что в форме Студии (spirits_front NewProductForm.tsx):
 * слаг, придуманный ассистентом, не должен отличаться от слага из кнопки.
 * Строки «й» и «ё» здесь мёртвые — NFD раскладывает их раньше, — но таблица
 * держится в одном виде с формой.
 */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  і: 'i', ї: 'yi', є: 'ye', ґ: 'g', ў: 'u',
};

/** Название → слаг. Пусто, если от названия не осталось ни буквы. */
export function slugifyName(name: string): string {
  const latin = Array.from(String(name ?? '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, ''))
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('');
  return latin
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

export function randomSuffix(): string {
  return Array.from(crypto.randomBytes(SUFFIX_LEN), (b) => SUFFIX_ABC[b % SUFFIX_ABC.length]).join('');
}

/** Основа из имени и хвост; без основы — `<вид>-<хвост>`. Как deriveBotSlug формы. */
export function slugWithSuffix(name: string, suffix: string, kind: 'site' | 'bot'): string {
  const room = SLUG_MAX - suffix.length - 1;
  const base = slugifyName(name).slice(0, room).replace(/-+$/g, '');
  return base ? `${base}-${suffix}` : `${kind}-${suffix}`;
}

/**
 * Кандидаты слага сайта по порядку. Слаг сайта — это его адрес, поэтому
 * сначала чистая основа; хвост — когда она занята или негодна.
 */
export function siteSlugCandidates(name: string, suffix: () => string = randomSuffix): string[] {
  const base = slugifyName(name);
  const out: string[] = [];
  if (base && SLUG_RE.test(base)) out.push(base);
  for (let i = 0; i < 3; i++) out.push(slugWithSuffix(name, suffix(), 'site'));
  return out;
}
