import { Injectable, Logger } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';

@Injectable()
export class KlingService {
  private readonly logger = new Logger(KlingService.name);
  private readonly ak = process.env.KLING_ACCESS_KEY || '';
  private readonly sk = process.env.KLING_SECRET_KEY || '';

  private getToken(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iss: this.ak, exp: now + 1800, nbf: now - 5 },
      this.sk,
      { algorithm: 'HS256', header: { alg: 'HS256', typ: 'JWT' } as any },
    );
  }

  async generateImage(prompt: string, aspectRatio = '1:1'): Promise<{ url: string } | null> {
    if (!this.ak || !this.sk) {
      this.logger.warn('Kling credentials not set');
      return null;
    }

    try {
      // Create task
      const token = this.getToken();
      const createResp = await axios.post(
        'https://api.klingai.com/v1/images/generations',
        { model: 'kling-v1', prompt, n: 1, aspect_ratio: aspectRatio },
        { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 },
      );

      const taskId = createResp.data?.data?.task_id;
      if (!taskId) {
        this.logger.error(`Kling create failed: ${JSON.stringify(createResp.data)}`);
        return null;
      }

      this.logger.log(`Kling task created: ${taskId}`);

      // Poll for result (max 60 seconds, every 3 seconds)
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));

        const pollToken = this.getToken();
        const pollResp = await axios.get(
          `https://api.klingai.com/v1/images/generations/${taskId}`,
          { headers: { Authorization: `Bearer ${pollToken}` }, timeout: 15000 },
        );

        const status = pollResp.data?.data?.task_status;
        if (status === 'succeed') {
          const images = pollResp.data?.data?.task_result?.images;
          if (images?.length > 0) {
            this.logger.log(`Kling image ready: ${taskId}`);
            return { url: images[0].url };
          }
        } else if (status === 'failed') {
          this.logger.error(`Kling task failed: ${taskId} - ${pollResp.data?.data?.task_status_msg}`);
          return null;
        }
        // else: submitted/processing — continue polling
      }

      this.logger.error(`Kling task timeout: ${taskId}`);
      return null;
    } catch (e) {
      this.logger.error(`Kling error: ${e.response?.data ? JSON.stringify(e.response.data) : e.message}`);
      return null;
    }
  }
}
