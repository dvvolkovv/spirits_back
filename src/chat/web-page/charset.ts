import { TextDecoder } from 'util';

/**
 * Байты ответа → строка (инструмент open_page). Порядок, как у браузера, в
 * упрощённом виде:
 *   1. BOM (UTF-8, UTF-16) — главнее всего;
 *   2. charset из Content-Type;
 *   3. для HTML — пролог `<?xml encoding>` и `<meta charset>` /
 *      `<meta http-equiv content="…; charset=…">` в первых 4 КБ; для XML — пролог;
 *   4. utf-8.
 * Незнакомая или неподдерживаемая метка пропускается (дальше по списку, в
 * конце — utf-8). Русские сайты до сих пор нередко отдают windows-1251 и
 * KOI8-R — их декодирует TextDecoder (полный ICU есть в штатных сборках node).
 */

export type BodyKind = 'html' | 'xml' | 'other';

const PRESCAN_BYTES = 4096;

export function charsetFromContentType(contentType: string | undefined): string | null {
  const m = /;\s*charset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s;,]+))/i.exec(contentType || '');
  const v = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim();
  return v || null;
}

function bomCharset(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return 'utf-8';
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return 'utf-16be';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return 'utf-16le';
  return null;
}

function xmlDeclCharset(head: string): string | null {
  return /^\s*<\?xml\b[^>]*?\bencoding\s*=\s*["']([a-zA-Z0-9_.:-]+)["']/i.exec(head)?.[1] ?? null;
}

function metaCharset(head: string): string | null {
  return /<meta\b[^>]*?\bcharset\s*=\s*["']?\s*([a-zA-Z0-9_.:-]+)/i.exec(head)?.[1] ?? null;
}

/** null — метка незнакома или это «replacement» (iso-2022-kr и т.п.: вся страница стала бы одним «�»). */
function decoderFor(label: string): TextDecoder | null {
  try {
    const d = new TextDecoder(label.trim().toLowerCase());
    return d.encoding === 'replacement' ? null : d;
  } catch {
    return null;
  }
}

export function decodeBody(buf: Buffer, contentType: string | undefined, kind: BodyKind): { text: string; charset: string } {
  const bom = bomCharset(buf);
  // TextDecoder сам срезает BOM своей кодировки (ignoreBOM: false по умолчанию).
  const decode = (d: TextDecoder) => ({ text: d.decode(buf), charset: d.encoding });
  if (bom) return decode(new TextDecoder(bom));

  const header = charsetFromContentType(contentType);
  const fromHeader = header ? decoderFor(header) : null;
  if (fromHeader) return decode(fromHeader);

  if (kind !== 'other') {
    const head = buf.subarray(0, PRESCAN_BYTES).toString('latin1');
    const xml = xmlDeclCharset(head);
    const fromXml = xml ? decoderFor(xml) : null;
    if (fromXml) return decode(fromXml);
    if (kind === 'html') {
      const meta = metaCharset(head);
      const fromMeta = meta ? decoderFor(meta) : null;
      // Документ, который прочитался как ASCII до <meta>, не может быть в
      // UTF-16: браузер в этом случае берёт utf-8 — и мы тоже.
      if (fromMeta && !fromMeta.encoding.startsWith('utf-16')) return decode(fromMeta);
    }
  }
  return decode(new TextDecoder('utf-8'));
}
