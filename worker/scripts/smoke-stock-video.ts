// worker/scripts/smoke-stock-video.ts
import { searchStockVideo, downloadStockVideo } from '../src/media/stock-video';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const query = process.argv.slice(2).join(' ') || 'sunset ocean';
  const match = await searchStockVideo({ query });
  if (!match) { console.error('No match'); process.exit(2); }
  console.log(`Match: ${match.url} (${match.durationSec}s ${match.width}x${match.height})`);
  const outDir = path.join(os.tmpdir(), `smm-stock-smoke-${Date.now()}`);
  const file = await downloadStockVideo(match.downloadUrl, outDir, 'sample');
  console.log(`Saved to: ${file}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
