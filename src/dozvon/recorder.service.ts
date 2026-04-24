import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import axios from 'axios';

/**
 * Запись звонка через Taler recorder на http://167.172.181.34:3100.
 *
 *  start(call_id, roomName):
 *    POST /record { roomName, callbackUrl, withAi: false } — recorder начинает писать MP3,
 *    после stop-record отправит файл на callbackUrl POST multipart/form-data (или JSON).
 *
 *  stop(roomName):
 *    POST /stop-record { roomName } — recorder сохраняет MP3, выполняет callback.
 *
 * Если recorder не вернёт файл — звонок всё равно прошёл, просто без записи.
 */
const RECORDER_URL = process.env.RECORDER_URL || 'http://167.172.181.34:3100';

@Injectable()
export class RecorderService {
  private readonly logger = new Logger(RecorderService.name);
  private get storageDir(): string {
    return process.env.DOZVON_RECORDINGS_DIR ||
           path.join(process.cwd(), 'public', 'dozvon');
  }
  private get publicBase(): string {
    return process.env.DOZVON_RECORDINGS_BASE_URL ||
           `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/static/dozvon`;
  }

  constructor(private readonly pg: PgService) {}

  async start(callId: number, roomName: string): Promise<void> {
    try {
      const callbackUrl = `${process.env.BACKEND_URL || 'https://my.linkeon.io'}/webhook/dozvon/internal/recording-upload?callId=${callId}`;
      const res = await axios.post(
        `${RECORDER_URL}/record`,
        { roomName, withAi: false, callbackUrl, uploadUrl: callbackUrl, backendUrl: callbackUrl },
        { timeout: 5000 },
      );
      this.logger.log(`[Recorder] start room=${roomName}: ${res.status} ${JSON.stringify(res.data).slice(0, 120)}`);
    } catch (e: any) {
      this.logger.warn(`[Recorder] start room=${roomName} failed: ${e.message}`);
    }
  }

  async stop(roomName: string): Promise<void> {
    try {
      await axios.post(
        `${RECORDER_URL}/stop-record`,
        { roomName },
        { timeout: 5000 },
      );
      this.logger.log(`[Recorder] stop room=${roomName}`);
    } catch (e: any) {
      this.logger.warn(`[Recorder] stop room=${roomName} failed: ${e.message}`);
    }
  }

  /** Сохраняет присланный MP3 в public/dozvon/ и апдейтит call.recording_url. */
  async saveRecording(callId: number, buffer: Buffer, contentType: string): Promise<string> {
    const ext = contentType.includes('wav') ? 'wav' :
                contentType.includes('ogg') ? 'ogg' : 'mp3';
    fs.mkdirSync(this.storageDir, { recursive: true });
    const filename = `call_${callId}.${ext}`;
    const filepath = path.join(this.storageDir, filename);
    fs.writeFileSync(filepath, buffer);
    const url = `${this.publicBase}/${filename}`;
    await this.pg.query(
      `UPDATE dozvon_calls SET recording_url = $1 WHERE id = $2`,
      [url, callId],
    );
    this.logger.log(`[Recorder] saved call=${callId} size=${buffer.length} → ${url}`);
    return url;
  }
}
