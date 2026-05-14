// worker/scripts/smoke-api-client.ts
import { apiClient } from '../src/api-client';

async function main() {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error('usage: ts-node scripts/smoke-api-client.ts <videoId>');
    process.exit(1);
  }
  const ctx = await apiClient.getRenderContext(videoId);
  console.log('Got context:', JSON.stringify(ctx, null, 2).slice(0, 600));
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
