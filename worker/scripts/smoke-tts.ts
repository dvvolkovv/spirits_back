// worker/scripts/smoke-tts.ts
import { synthesize, writeSynthResultToFile } from '../src/tts';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const tier = (process.argv[2] || 'economy') as 'economy' | 'premium';
  const text = process.argv.slice(3).join(' ') ||
    'Привет, я твой ИИ-психолог. Расскажи, что тебя беспокоит.';
  const outDir = path.join(os.tmpdir(), `smm-tts-smoke-${Date.now()}`);
  const res = await synthesize({ tier, speaker: 'assistant', role: 'psy', text });
  const out = await writeSynthResultToFile(res, outDir, 'sample');
  console.log(`Saved ${res.bytes.length} bytes (${res.format}) to: ${out}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
