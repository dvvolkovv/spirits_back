import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { s3Storage } from './storage';

const cfg = { endpoint: 'http://127.0.0.1:9000', accessKey: 'a', secretKey: 's', bucket: 'linkeon-smm-videos' };

test('файл уходит в бакет под ключом, с типом; скачивается в файл', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-storage-'));
  const sent: any[] = [];
  const client = {
    send: async (cmd: any) => {
      sent.push(cmd);
      return cmd instanceof GetObjectCommand ? { Body: Readable.from([Buffer.from('видео')]) } : {};
    },
  };
  const storage = s3Storage(cfg, client);
  fs.writeFileSync(path.join(dir, 'video.mp4'), 'байты');

  await storage.put('shorts/x/video.mp4', path.join(dir, 'video.mp4'), 'video/mp4');
  assert.ok(sent[0] instanceof PutObjectCommand);
  // После assert.ok TypeScript сужает sent[0] до PutObjectCommand, а Body там — union
  // потоковых типов; в тесте это Buffer.
  const input = sent[0].input as { Bucket?: string; Key?: string; ContentType?: string; Body?: Buffer };
  assert.deepEqual(
    [input.Bucket, input.Key, input.ContentType, input.Body?.toString()],
    ['linkeon-smm-videos', 'shorts/x/video.mp4', 'video/mp4', 'байты'],
  );

  await storage.get('shorts/x/video.mp4', path.join(dir, 'got.mp4'));
  assert.ok(sent[1] instanceof GetObjectCommand);
  assert.equal(fs.readFileSync(path.join(dir, 'got.mp4'), 'utf8'), 'видео');
  fs.rmSync(dir, { recursive: true, force: true });
});
