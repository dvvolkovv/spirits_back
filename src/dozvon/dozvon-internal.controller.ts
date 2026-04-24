import { Controller, Post, Body, Headers, UnauthorizedException, Logger, Query, Req, BadRequestException } from '@nestjs/common';
import { Request } from 'express';
import { DozvonService } from './dozvon.service';
import { RecorderService } from './recorder.service';

@Controller('dozvon/internal')
export class DozvonInternalController {
  private readonly logger = new Logger(DozvonInternalController.name);

  constructor(
    private readonly dozvon: DozvonService,
    private readonly recorder: RecorderService,
  ) {}

  /**
   * Принимает MP3/OGG от Taler-recorder'а (:3100).
   * Recorder может отправлять либо multipart/form-data (file field), либо raw body.
   * Мы обрабатываем оба варианта: собираем request body целиком в Buffer.
   */
  @Post('recording-upload')
  async recordingUpload(
    @Query('callId') callIdRaw: string,
    @Req() req: Request,
  ) {
    const callId = Number(callIdRaw);
    if (!callId) throw new BadRequestException('callId required');

    const contentType = (req.headers['content-type'] || 'audio/mpeg') as string;

    // Raw buffer — Nest по умолчанию парсит json, обходим через data-event-стрим.
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });

    if (!buffer.length) {
      this.logger.warn(`[recording-upload] empty body for call=${callId}`);
      return { ok: false, reason: 'empty' };
    }

    // Если это multipart — извлекаем только audio-часть (грубо: первая бинарная секция).
    let audioBuf = buffer;
    if (contentType.startsWith('multipart/')) {
      const m = contentType.match(/boundary=([^;]+)/);
      if (m) {
        const boundary = `--${m[1]}`;
        const raw = buffer.toString('binary');
        const parts = raw.split(boundary);
        for (const p of parts) {
          if (/Content-Type:\s*audio\//i.test(p)) {
            const headerEnd = p.indexOf('\r\n\r\n');
            if (headerEnd > -1) {
              const bin = p.slice(headerEnd + 4, p.lastIndexOf('\r\n'));
              audioBuf = Buffer.from(bin, 'binary');
              break;
            }
          }
        }
      }
    }

    const url = await this.recorder.saveRecording(
      callId,
      audioBuf,
      contentType.startsWith('multipart/') ? 'audio/mpeg' : contentType,
    );
    await this.dozvon.attachRecording(callId, url);
    return { ok: true, url };
  }

  @Post('call-complete')
  async callComplete(
    @Headers('x-dozvon-secret') secret: string,
    @Body() body: any,
  ) {
    if (secret !== process.env.DOZVON_INTERNAL_SECRET) {
      throw new UnauthorizedException('Invalid internal secret');
    }
    return this.dozvon.handleCallComplete(body);
  }

  /**
   * Callback from the shared Taler ID outbound-call-agent.
   * Payload uses Taler format (camelCase, transcript as array) — adapt to Linkeon format.
   */
  @Post('taler-callback')
  async talerCallback(
    @Headers('x-outbound-secret') secret: string,
    @Body() body: {
      callId: string;
      campaignId: string;
      transcript: any;        // array of {role, content} turns
      summary: string;
      durationSec: number;
      status: string;
      recordingUrl?: string;
    },
  ) {
    if (secret !== process.env.OUTBOUND_CALLBACK_SECRET) {
      throw new UnauthorizedException('Invalid outbound secret');
    }

    // Agent шлёт transcript либо строкой, либо массивом turn-ов.
    // В массиве поле с текстом бывает content/text/message/value — берём первое непустое.
    const pickText = (t: any): string => {
      if (!t) return '';
      if (typeof t === 'string') return t;
      return (
        t.content ?? t.text ?? t.message ?? t.value ?? t.transcript ?? ''
      );
    };
    const pickRole = (t: any): string => t?.role ?? t?.speaker ?? t?.author ?? '';
    const transcriptStr = Array.isArray(body.transcript)
      ? body.transcript.map((t: any) => `${pickRole(t)}: ${pickText(t)}`.trim()).filter(Boolean).join('\n')
      : (typeof body.transcript === 'string' ? body.transcript : JSON.stringify(body.transcript));

    this.logger.debug?.(`[taler-callback] raw transcript sample: ${JSON.stringify(body.transcript).slice(0, 400)}`);

    // Map Taler statuses to Linkeon statuses
    const statusMap: Record<string, string> = {
      completed: 'done',
      failed: 'failed',
      no_answer: 'no_answer',
      busy: 'busy',
    };

    this.logger.log(`[taler-callback] call=${body.callId} status=${body.status} dur=${body.durationSec}s`);

    return this.dozvon.handleCallComplete({
      call_id: parseInt(body.callId, 10),
      campaign_id: parseInt(body.campaignId, 10),
      status: statusMap[body.status] || body.status || 'done',
      transcript: transcriptStr,
      summary: body.summary,
      recording_url: body.recordingUrl,
      duration_sec: body.durationSec,
    });
  }
}
