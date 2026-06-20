/**
 * Программное наложение текста на сгенерённый фон.
 *
 * Зачем: модели (Imagen / Nano Banana) плохо рендерят кириллицу — буквы
 * «плывут». Поэтому фон генерим БЕЗ текста, а заголовок/подзаголовок/CTA
 * рисуем здесь через canvas с бандл-шрифтом Montserrat (полный charset,
 * кириллица + латиница) — буквы получаются идеальными.
 */
import { createCanvas, loadImage, GlobalFonts, SKRSContext2D } from '@napi-rs/canvas';
import * as path from 'path';
import * as fs from 'fs';

const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
const FONT_TITLE = 'LinkeonBannerBold';
const FONT_SUB = 'LinkeonBannerRegular';
const FONT_CTA = 'LinkeonBannerSemiBold';

let fontsReady = false;
function ensureFonts(): void {
  if (fontsReady) return;
  const reg = (file: string, family: string) => {
    const p = path.join(FONT_DIR, file);
    if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, family);
  };
  reg('Montserrat-Bold.ttf', FONT_TITLE);
  reg('Montserrat-Regular.ttf', FONT_SUB);
  reg('Montserrat-SemiBold.ttf', FONT_CTA);
  fontsReady = true;
}

export type BannerPosition = 'top' | 'center' | 'bottom';
export type BannerTheme = 'dark' | 'light';

export interface BannerOverlayOptions {
  title?: string;
  subtitle?: string;
  cta?: string;
  position?: BannerPosition;
  theme?: BannerTheme; // dark = светлый текст на тёмной подложке (дефолт), light = наоборот
  accent?: string; // hex цвета CTA-плашки
}

function wrapLines(ctx: SKRSContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let cur = '';
    for (const w of words) {
      const test = cur ? `${cur} ${w}` : w;
      if (ctx.measureText(test).width <= maxWidth || !cur) cur = test;
      else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Подобрать кегль так, чтобы заголовок уместился в maxLines строк. */
function fitTitle(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  startSize: number,
  minSize: number,
  maxLines: number,
): { size: number; lines: string[] } {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${size}px ${FONT_TITLE}`;
    const lines = wrapLines(ctx, text, maxWidth);
    if (lines.length <= maxLines) return { size, lines };
    size -= Math.max(2, Math.round(size * 0.06));
  }
  ctx.font = `${minSize}px ${FONT_TITLE}`;
  return { size: minSize, lines: wrapLines(ctx, text, maxWidth) };
}

/**
 * Накладывает текст на фон. На вход — буфер фоновой картинки (PNG/JPEG),
 * на выход — PNG-буфер готового баннера.
 */
export async function renderBannerOverlay(
  bgBuffer: Buffer,
  opts: BannerOverlayOptions,
): Promise<Buffer> {
  ensureFonts();
  const img = await loadImage(bgBuffer);
  const W = img.width;
  const H = img.height;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, W, H);

  const title = (opts.title || '').trim();
  const subtitle = (opts.subtitle || '').trim();
  const cta = (opts.cta || '').trim();
  if (!title && !subtitle && !cta) {
    return canvas.toBuffer('image/png');
  }

  const position: BannerPosition = opts.position || 'bottom';
  const theme: BannerTheme = opts.theme || 'dark';
  const accent = /^#[0-9a-fA-F]{6}$/.test(opts.accent || '') ? (opts.accent as string) : '#2f8f4e';
  const textColor = theme === 'dark' ? '#ffffff' : '#101418';
  const subColor = theme === 'dark' ? 'rgba(255,255,255,0.88)' : 'rgba(16,20,24,0.82)';

  const pad = Math.round(W * 0.06);
  const maxTextWidth = W - pad * 2;

  // --- кегли, масштабируемые от ширины ---
  const titleStart = Math.round(W / 11);
  const titleMin = Math.round(W / 22);
  const fit = title
    ? fitTitle(ctx, title, maxTextWidth, titleStart, titleMin, 4)
    : { size: 0, lines: [] as string[] };
  const titleSize = fit.size;
  const titleLineH = Math.round(titleSize * 1.12);

  const subSize = Math.round(Math.max(titleSize * 0.42, W / 30));
  ctx.font = `${subSize}px ${FONT_SUB}`;
  const subLines = subtitle ? wrapLines(ctx, subtitle, maxTextWidth) : [];
  const subLineH = Math.round(subSize * 1.25);

  const ctaSize = Math.round(Math.max(subSize * 1.0, W / 28));
  const ctaPadX = Math.round(ctaSize * 0.9);
  const ctaPadY = Math.round(ctaSize * 0.55);
  ctx.font = `${ctaSize}px ${FONT_CTA}`;
  const ctaTextW = cta ? ctx.measureText(cta).width : 0;
  const ctaH = cta ? ctaSize + ctaPadY * 2 : 0;

  // --- высота текстового блока ---
  const gapAfterTitle = title && (subLines.length || cta) ? Math.round(titleSize * 0.4) : 0;
  const gapAfterSub = subLines.length && cta ? Math.round(subSize * 0.9) : 0;
  const blockH =
    fit.lines.length * titleLineH +
    gapAfterTitle +
    subLines.length * subLineH +
    gapAfterSub +
    ctaH;

  // --- вертикальная привязка ---
  let blockTop: number;
  if (position === 'top') blockTop = pad;
  else if (position === 'center') blockTop = Math.round((H - blockH) / 2);
  else blockTop = H - pad - blockH;

  // --- подложка-скрим для читаемости ---
  const scrimColor = theme === 'dark' ? '0,0,0' : '255,255,255';
  const scrimPadTop = Math.round(H * 0.14);
  const scrimTop = Math.max(0, blockTop - scrimPadTop);
  const scrimBottom = Math.min(H, blockTop + blockH + Math.round(H * 0.06));
  const grad = ctx.createLinearGradient(0, scrimTop, 0, scrimBottom);
  if (position === 'top') {
    grad.addColorStop(0, `rgba(${scrimColor},0.72)`);
    grad.addColorStop(1, `rgba(${scrimColor},0)`);
  } else if (position === 'bottom') {
    grad.addColorStop(0, `rgba(${scrimColor},0)`);
    grad.addColorStop(1, `rgba(${scrimColor},0.78)`);
  } else {
    grad.addColorStop(0, `rgba(${scrimColor},0)`);
    grad.addColorStop(0.5, `rgba(${scrimColor},0.62)`);
    grad.addColorStop(1, `rgba(${scrimColor},0)`);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, scrimTop, W, scrimBottom - scrimTop);

  // --- рисуем текст ---
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  let y = blockTop;

  if (fit.lines.length) {
    ctx.font = `${titleSize}px ${FONT_TITLE}`;
    ctx.fillStyle = textColor;
    ctx.shadowColor = theme === 'dark' ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.4)';
    ctx.shadowBlur = Math.round(titleSize * 0.12);
    ctx.shadowOffsetY = Math.round(titleSize * 0.03);
    for (const line of fit.lines) {
      ctx.fillText(line, pad, y);
      y += titleLineH;
    }
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;
    y += gapAfterTitle;
  }

  if (subLines.length) {
    ctx.font = `${subSize}px ${FONT_SUB}`;
    ctx.fillStyle = subColor;
    for (const line of subLines) {
      ctx.fillText(line, pad, y);
      y += subLineH;
    }
    y += gapAfterSub;
  }

  if (cta) {
    const btnW = ctaTextW + ctaPadX * 2;
    const radius = Math.round(ctaH / 2);
    roundRect(ctx, pad, y, btnW, ctaH, radius);
    ctx.fillStyle = accent;
    ctx.fill();
    ctx.font = `${ctaSize}px ${FONT_CTA}`;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(cta, pad + ctaPadX, y + ctaH / 2 + Math.round(ctaSize * 0.04));
    ctx.textBaseline = 'top';
  }

  return canvas.toBuffer('image/png');
}

function roundRect(ctx: SKRSContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
