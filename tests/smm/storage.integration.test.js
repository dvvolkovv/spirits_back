/**
 * Integration test: StorageService against real MinIO.
 *
 * Requires:
 *   - MinIO reachable on $MINIO_ENDPOINT (use SSH tunnel for local dev)
 *   - MINIO_ACCESS_KEY / MINIO_SECRET_KEY / MINIO_BUCKET_VIDEOS in env
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const { StorageService } = require(
  path.join(__dirname, '..', '..', 'dist', 'src', 'common', 'services', 'storage.service'),
);

const storage = new StorageService();
storage.onModuleInit();

const BUCKET = process.env.MINIO_BUCKET_VIDEOS;
const KEY = `test/storage-smoke-${Date.now()}.txt`;

module.exports = {
  'storage: upload returns public URL': async () => {
    const url = await storage.upload({
      bucket: BUCKET,
      key: KEY,
      body: Buffer.from('hello storage'),
      contentType: 'text/plain',
    });
    const expectedPrefix = process.env.MINIO_PUBLIC_URL + '/' + BUCKET + '/';
    if (!url.startsWith(expectedPrefix)) {
      throw new Error(`Expected URL to start with ${expectedPrefix}, got: ${url}`);
    }
  },

  'storage: download returns same bytes': async () => {
    const buf = await storage.download({ bucket: BUCKET, key: KEY });
    if (buf.toString('utf8') !== 'hello storage') {
      throw new Error(`Expected 'hello storage', got: ${buf.toString('utf8')}`);
    }
  },

  'storage: list returns the key': async () => {
    const keys = await storage.list({ bucket: BUCKET, prefix: 'test/' });
    if (!keys.includes(KEY)) {
      throw new Error(`Expected ${KEY} in list, got: ${JSON.stringify(keys)}`);
    }
  },

  'storage: delete removes the object': async () => {
    await storage.delete({ bucket: BUCKET, key: KEY });
    let thrown = null;
    try {
      await storage.download({ bucket: BUCKET, key: KEY });
    } catch (e) {
      thrown = e;
    }
    if (!thrown) throw new Error('Expected error on download after delete');
    if (!String(thrown.message).match(/NoSuchKey|not found|404|The specified key does not exist/i)) {
      throw new Error(`Expected NoSuchKey error, got: ${thrown.message}`);
    }
  },
};
