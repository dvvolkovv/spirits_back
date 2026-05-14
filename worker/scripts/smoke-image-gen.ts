// worker/scripts/smoke-image-gen.ts
import { generateImage, writeImageToFile } from '../src/media/image-gen';
import * as os from 'os';
import * as path from 'path';

async function main() {
  const prompt = process.argv.slice(2).join(' ') ||
    'Молодая женщина читает книгу на диване, уютная атмосфера, кинематографичный кадр';
  const outDir = path.join(os.tmpdir(), `smm-img-smoke-${Date.now()}`);
  const bytes = await generateImage({ prompt, aspectRatio: '9:16' });
  const out = await writeImageToFile(bytes, outDir, 'sample');
  console.log(`Saved ${bytes.length} bytes to: ${out}`);
}
main().catch((e) => { console.error(e.message || e); process.exit(1); });
