// worker/src/media/stock-video.ts
import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { config } from '../config';
import { logger } from '../logger';

export interface StockSearchInput {
  query: string;
  maxDurationSec?: number;
  minHeight?: number;
}

export interface StockVideoMatch {
  id: number;
  url: string;
  durationSec: number;
  width: number;
  height: number;
  downloadUrl: string;
}

export async function searchStockVideo(input: StockSearchInput): Promise<StockVideoMatch | null> {
  const apiKey = config.media.pexelsApiKey;
  if (!apiKey) throw new Error('PEXELS_API_KEY not configured');

  const r = await axios.get('https://api.pexels.com/videos/search', {
    headers: { Authorization: apiKey },
    params: { query: input.query, orientation: 'portrait', size: 'medium', per_page: 10 },
    timeout: 15000,
    validateStatus: () => true,
  });
  if (r.status !== 200) {
    throw new Error(`Pexels ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  const maxDur = input.maxDurationSec ?? 10;
  const minH = input.minHeight ?? 1080;

  // Collect all suitable matches so we can randomise the pick — Pexels orders
  // results by relevance and always returning videos[0] makes regenerated
  // clips byte-identical (same TTS + same stock = same final mp4).
  const candidates: StockVideoMatch[] = [];
  for (const v of (r.data.videos || [])) {
    if (v.duration > maxDur) continue;
    const portrait = (v.video_files || []).filter((f: any) =>
      f.width && f.height && f.height >= minH && f.height >= f.width,
    );
    if (portrait.length === 0) continue;
    portrait.sort((a: any, b: any) => a.height - b.height);
    const file = portrait[0];
    candidates.push({
      id: v.id,
      url: v.url,
      durationSec: v.duration,
      width: file.width,
      height: file.height,
      downloadUrl: file.link,
    });
  }
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  logger.debug({ query: input.query, candidates: candidates.length, pickedId: pick.id }, 'stock video picked');
  return pick;
}

export async function downloadStockVideo(url: string, outDir: string, basename: string): Promise<string> {
  await fs.mkdir(outDir, { recursive: true });
  const filename = path.join(outDir, `${basename}.mp4`);
  const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000 });
  await fs.writeFile(filename, Buffer.from(r.data));
  logger.debug({ filename, bytes: r.data.byteLength }, 'stock video downloaded');
  return filename;
}
