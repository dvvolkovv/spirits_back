/**
 * HTML → текст для модели (инструмент open_page). Свой небольшой разборщик:
 * сторонних библиотек разбора HTML в проекте нет, а тянуть их ради чтения
 * текста не стоит. Задача — не браузер, а читаемый текст: заголовки, абзацы,
 * списки, таблицы и ссылки; всё невидимое (скрипты, стили, svg, шаблоны,
 * рамки, начинка head) выкидывается вместе с содержимым.
 *
 * Разбор за один проход по строке, без регулярных выражений с откатами по
 * всему документу: страница может весить мегабайты.
 */

export interface PageLink {
  text: string;
  url: string;
}

export interface HtmlPage {
  title: string;
  description: string;
  /** Текст страницы целиком (обрезка — clipText, у вызывающего). */
  text: string;
  /** До maxLinks абсолютных http(s)-ссылок, уникальных, с текстом. */
  links: PageLink[];
  /** В HTML есть <script>: пустая страница, скорее всего, собирается в браузере. */
  hasScripts: boolean;
}

export const PAGE_MAX_LINKS = 50;
const LINK_TEXT_MAX = 120;

// ───────────────────────── сущности ─────────────────────────

/** Частые именованные сущности. Незнакомые остаются как есть. */
const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  ldquo: '“', rdquo: '”', bdquo: '„', lsquo: '‘', rsquo: '’', sbquo: '‚', prime: '′', Prime: '″',
  mdash: '—', ndash: '–', minus: '−', hellip: '…', bull: '•', middot: '·', shy: '­',
  thinsp: ' ', ensp: ' ', emsp: ' ', zwnj: '‌', zwj: '‍', lrm: '‎', rlm: '‏',
  copy: '©', reg: '®', trade: '™', sect: '§', para: '¶', deg: '°', plusmn: '±', times: '×', divide: '÷',
  micro: 'µ', not: '¬', macr: '¯', uml: '¨', acute: '´', cedil: '¸', ordf: 'ª', ordm: 'º', brvbar: '¦',
  iexcl: '¡', iquest: '¿', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤', dagger: '†', Dagger: '‡', permil: '‰',
  larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', lArr: '⇐', rArr: '⇒', hArr: '⇔',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', equiv: '≡', infin: '∞', sum: '∑', radic: '√', check: '✓',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ', ccedil: 'ç',
  egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì', iacute: 'í', icirc: 'î', iuml: 'ï',
  ntilde: 'ñ', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', yuml: 'ÿ', szlig: 'ß',
  Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä', Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç',
  Egrave: 'È', Eacute: 'É', Ecirc: 'Ê', Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö', Oslash: 'Ø', Ugrave: 'Ù',
  Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
};

const ENTITY_RE = /&(?:#(\d{1,8});?|#[xX]([0-9a-fA-F]{1,7});?|([a-zA-Z][a-zA-Z0-9]{1,31});)/g;

function fromCode(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
  return String.fromCodePoint(code);
}

/** Именованные (частые, с «;») и числовые сущности; один проход — &amp;lt; даёт «&lt;». */
export function decodeEntities(s: string): string {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(ENTITY_RE, (whole, dec?: string, hex?: string, name?: string) => {
    if (dec !== undefined) return fromCode(parseInt(dec, 10));
    if (hex !== undefined) return fromCode(parseInt(hex, 16));
    // hasOwnProperty: «&constructor;» не должен достать метод прототипа.
    return name !== undefined && Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : whole;
  });
}

// ───────────────────────── теги ─────────────────────────

/** Выкидываются вместе с содержимым: невидимое, служебное и мусорное для текста. */
const SKIP = new Set([
  'script', 'style', 'noscript', 'svg', 'template', 'iframe', 'title', 'textarea',
  'select', 'datalist', 'canvas', 'video', 'audio', 'object', 'noembed', 'noframes',
]);

/** Перевод строки до и после. */
const BLOCK = new Set([
  'address', 'article', 'aside', 'body', 'center', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'hr', 'html', 'legend',
  'li', 'main', 'menu', 'nav', 'option', 'search', 'section', 'summary', 'tbody', 'thead', 'tfoot', 'caption',
]);

/** Пустая строка до и после. */
const PARAGRAPH = new Set(['p', 'blockquote', 'pre', 'table']);

const TAG_RE = /<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/y;
const ATTR_RE = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  if (!raw) return out;
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw))) {
    const name = m[1].toLowerCase();
    if (name in out) continue;
    out[name] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

const closeReCache = new Map<string, RegExp>();
/** Закрывающий тег элемента: `</name` и дальше пробел, `/` или `>`. */
function closeRe(name: string): RegExp {
  let re = closeReCache.get(name);
  if (!re) {
    re = new RegExp(`</${name}(?=[\\s/>])`, 'ig');
    closeReCache.set(name, re);
  }
  return re;
}

/** Конец тега, начиная с `from`: «>» вне кавычек значения атрибута. -1 — тег не закрыт. */
function tagEnd(html: string, from: number): number {
  let quote = '';
  let prev = '';
  for (let j = from; j < html.length; j++) {
    const c = html[j];
    if (quote) {
      if (c === quote) quote = '';
      continue;
    }
    // Кавычка открывает значение только сразу после «=»: в `a=x'y` она часть значения.
    if ((c === '"' || c === "'") && prev === '=') {
      quote = c;
      continue;
    }
    if (c === '>') return j;
    if (c !== ' ' && c !== '\t' && c !== '\n' && c !== '\r') prev = c;
  }
  return -1;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

// ───────────────────────── вывод ─────────────────────────

class Out {
  private parts: string[] = [];
  /** Сколько «\n» подряд в конце вывода. */
  private nl = 0;
  private started = false;
  private last = '';

  private push(s: string): void {
    if (!s) return;
    this.parts.push(s);
    this.last = s[s.length - 1];
    let k = 0;
    while (k < s.length && s[s.length - 1 - k] === '\n') k++;
    this.nl = k === s.length ? this.nl + k : k;
    if (k < s.length) this.started = true;
  }

  private dropTrailingSpace(): void {
    const i = this.parts.length - 1;
    if (i >= 0 && this.last === ' ') {
      this.parts[i] = this.parts[i].replace(/ +$/, '');
      if (!this.parts[i]) this.parts.pop();
      const p = this.parts[this.parts.length - 1] ?? '';
      this.last = p[p.length - 1] ?? '';
    }
  }

  /** Обычный текст: пробелы сжаты, в начале строки — без ведущего пробела. */
  text(raw: string): void {
    let s = raw.replace(/\s+/g, ' ');
    if (!s) return;
    if (this.last === '' || this.last === '\n' || this.last === ' ') s = s.replace(/^ /, '');
    this.push(s);
  }

  /** Текст как есть (pre) и служебные префиксы. */
  raw(s: string): void {
    this.push(s);
  }

  get atLineStart(): boolean {
    return this.last === '' || this.last === '\n';
  }

  /** Не меньше n переводов строки в конце; в начале вывода — ни одного. */
  breakLines(n: number): void {
    if (!this.started) return;
    this.dropTrailingSpace();
    while (this.nl < n) this.push('\n');
  }

  /** br: перевод строки всегда, даже второй подряд. */
  lineBreak(): void {
    if (!this.started) return;
    this.dropTrailingSpace();
    this.push('\n');
  }

  result(): string {
    return this.parts
      .join('')
      .split('\n')
      .map((l) => l.replace(/\s+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }
}

// ───────────────────────── разбор ─────────────────────────

function absoluteHttp(href: string, base: string): string | null {
  const h = href.trim();
  if (!h) return null;
  try {
    const u = new URL(h, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.href;
  } catch {
    return null;
  }
}

function withoutHash(url: string): string {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.href;
  } catch {
    return url;
  }
}

export function htmlToPage(html: string, pageUrl: string, opts: { maxLinks?: number } = {}): HtmlPage {
  const maxLinks = opts.maxLinks ?? PAGE_MAX_LINKS;
  const out = new Out();
  const n = html.length;
  const self = withoutHash(pageUrl);
  let base = pageUrl;

  let title = '';
  let ogTitle = '';
  let description = '';
  let ogDescription = '';

  const links = new Map<string, string>();
  let link: { url: string | null; text: string[]; fallback: string } | null = null;
  const closeLink = () => {
    if (!link) return;
    const text = collapse(link.text.join(' ')) || link.fallback;
    if (link.url && link.url !== self) {
      const had = links.get(link.url);
      if (had === undefined || (!had && text)) links.set(link.url, text.slice(0, LINK_TEXT_MAX));
    }
    link = null;
  };

  let inHead = false;
  let preDepth = 0;
  let listDepth = 0;
  let cells = 0;
  /** Префикс заголовка или пункта списка — выводится перед первым текстом элемента. */
  let prefix = '';

  const emitText = (rawText: string) => {
    if (inHead || !rawText) return;
    const decoded = decodeEntities(rawText);
    if (preDepth > 0) {
      const s = decoded.replace(/ /g, ' ');
      if (!s) return;
      if (prefix) {
        out.raw(prefix);
        prefix = '';
      }
      out.raw(s);
      link?.text.push(s);
      return;
    }
    if (!/\S/.test(decoded)) {
      out.text(' ');
      return;
    }
    if (prefix) {
      out.raw(prefix);
      prefix = '';
    }
    out.text(decoded);
    link?.text.push(decoded);
  };

  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      emitText(html.slice(i));
      break;
    }
    if (lt > i) emitText(html.slice(i, lt));

    // Комментарий, doctype, CDATA, инструкции разбора.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt + 2);
      i = end < 0 ? n : end + 1;
      continue;
    }

    TAG_RE.lastIndex = lt;
    const m = TAG_RE.exec(html);
    if (!m) {
      emitText('<');
      i = lt + 1;
      continue;
    }
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const end = tagEnd(html, lt + m[0].length);
    if (end < 0) break; // оборванный тег в конце документа
    const attrsRaw = html.slice(lt + m[0].length, end);
    const selfClosed = /\/\s*$/.test(attrsRaw);
    i = end + 1;

    if (!closing && SKIP.has(name)) {
      if (name === 'svg' && selfClosed) continue;
      const re = closeRe(name);
      re.lastIndex = i;
      const close = re.exec(html);
      const contentEnd = close ? close.index : n;
      if (name === 'title' && !title) title = collapse(decodeEntities(html.slice(i, contentEnd)));
      if (!close) {
        i = n;
        break;
      }
      const after = tagEnd(html, close.index + 2 + name.length);
      i = after < 0 ? n : after + 1;
      continue;
    }

    if (name === 'head') {
      inHead = !closing;
      continue;
    }
    if (name === 'body' && !closing) inHead = false;

    if (name === 'meta' && !closing) {
      const a = parseAttrs(attrsRaw);
      const key = (a.name || a.property || '').toLowerCase();
      const content = collapse(a.content ?? '');
      if (content) {
        if (key === 'description' && !description) description = content;
        else if ((key === 'og:description' || key === 'twitter:description') && !ogDescription) ogDescription = content;
        else if ((key === 'og:title' || key === 'twitter:title') && !ogTitle) ogTitle = content;
      }
      continue;
    }
    if (name === 'base' && !closing) {
      const href = parseAttrs(attrsRaw).href;
      const abs = href ? absoluteHttp(href, pageUrl) : null;
      if (abs) base = abs;
      continue;
    }
    if (inHead) continue;

    if (name === 'a') {
      closeLink();
      if (!closing) {
        const a = parseAttrs(attrsRaw);
        link = { url: a.href !== undefined ? absoluteHttp(a.href, base) : null, text: [], fallback: collapse(a['aria-label'] || a.title || '') };
      }
      continue;
    }
    if (name === 'img' && !closing) {
      if (link && !link.fallback) link.fallback = collapse(parseAttrs(attrsRaw).alt || '');
      continue;
    }
    if (name === 'br' && !closing) {
      out.lineBreak();
      continue;
    }

    const heading = /^h([1-6])$/.exec(name);
    if (heading) {
      out.breakLines(2);
      prefix = closing ? '' : `${'#'.repeat(Number(heading[1]))} `;
      continue;
    }
    if (name === 'ul' || name === 'ol') {
      if (closing) listDepth = Math.max(0, listDepth - 1);
      out.breakLines(listDepth > 0 ? 1 : 2);
      if (!closing) listDepth++;
      prefix = '';
      continue;
    }
    if (name === 'li') {
      out.breakLines(1);
      prefix = closing ? '' : `${'  '.repeat(Math.max(0, listDepth - 1))}- `;
      continue;
    }
    if (name === 'tr') {
      out.breakLines(1);
      cells = 0;
      continue;
    }
    if (name === 'td' || name === 'th') {
      if (!closing) {
        if (cells > 0) out.raw(out.atLineStart ? '| ' : ' | ');
        cells++;
      }
      continue;
    }
    if (name === 'pre') {
      out.breakLines(2);
      if (closing) preDepth = Math.max(0, preDepth - 1);
      else {
        preDepth++;
        // Браузер съедает перевод строки сразу после <pre>.
        if (html[i] === '\n') i++;
        else if (html[i] === '\r' && html[i + 1] === '\n') i += 2;
      }
      continue;
    }
    if (PARAGRAPH.has(name)) {
      out.breakLines(2);
      continue;
    }
    if (BLOCK.has(name)) {
      out.breakLines(1);
      continue;
    }
    // Прочие (строчные) теги — без следа в тексте.
  }
  closeLink();

  const list: PageLink[] = [];
  for (const [url, text] of links) {
    if (!text) continue;
    list.push({ text, url });
    if (list.length >= maxLinks) break;
  }

  return {
    title: title || ogTitle,
    description: description || ogDescription,
    text: out.result(),
    links: list,
    hasScripts: /<script\b/i.test(html),
  };
}

// ───────────────────────── обрезка ─────────────────────────

/**
 * Не длиннее max символов. Режет по концу строки, если он в последних 20%,
 * иначе по пробелу в последних 10%, иначе ровно по max; суррогатную пару не рвёт.
 */
export function clipText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  let cut = text.slice(0, max);
  const nl = cut.lastIndexOf('\n');
  const sp = cut.lastIndexOf(' ');
  if (nl >= max * 0.8) cut = cut.slice(0, nl);
  else if (sp >= max * 0.9) cut = cut.slice(0, sp);
  const lastCode = cut.charCodeAt(cut.length - 1);
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}
