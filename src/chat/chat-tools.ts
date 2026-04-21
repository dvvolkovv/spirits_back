// src/chat/chat-tools.ts
import { Injectable, Logger } from '@nestjs/common';
import { KlingService } from '../misc/kling.service';
import { PgService } from '../common/services/pg.service';
import { VideoService, InsufficientTokensError } from '../video/video.service';
import { CreateVideoJobDto } from '../video/video.dto';

export const CHAT_TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate a single image from a text prompt. Use whenever the user asks for an image, picture, or illustration (Russian "нарисуй", "сгенерируй картинку", "изображение").',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16'], default: '1:1' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'generate_video',
    description:
      'Generate a short 5-10s video using Kling. Use when the user asks for a video / animation / "оживи" an image / "сделай видео".',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text2video', 'image2video', 'extend', 'lipsync'] },
        prompt: { type: 'string' },
        model: { type: 'string', enum: ['kling-v1-6', 'kling-v2-master'], default: 'kling-v1-6' },
        quality: { type: 'string', enum: ['std', 'pro'], default: 'std' },
        duration: { type: 'number', enum: [5, 10], default: 5 },
        sourceImageUrl: { type: 'string' },
        sourceVideoId: { type: 'string' },
        cameraType: {
          type: 'string',
          enum: ['simple', 'down_back', 'forward_up', 'right_turn_forward', 'left_turn_forward'],
        },
        cameraConfig: { type: 'object' },
        negativePrompt: { type: 'string' },
      },
      required: ['mode'],
    },
  },
];

export type ToolResult =
  | { ok: true; kind: 'image'; imageUrl: string; tokensSpent: number }
  | { ok: true; kind: 'video'; jobId: string; status: string; tokensSpent: number }
  | { ok: false; error: string; [k: string]: any };

const IMAGE_TOKEN_COST = 5000;

@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  constructor(
    private readonly kling: KlingService,
    private readonly pg: PgService,
    private readonly video: VideoService,
  ) {}

  async executeTool(userId: string, name: string, input: any): Promise<ToolResult> {
    try {
      if (name === 'generate_image') {
        const prompt = String(input?.prompt ?? '').slice(0, 2000);
        if (!prompt) return { ok: false, error: 'empty prompt' };
        const aspectRatio = typeof input?.aspect_ratio === 'string' ? input.aspect_ratio : '1:1';

        // Balance check before the expensive call
        const balRes = await this.pg.query(
          'SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1',
          [userId],
        );
        const balance = Number((balRes.rows[0] as any)?.tokens ?? 0);
        if (balance < IMAGE_TOKEN_COST) {
          return { ok: false, error: 'insufficient_tokens', balance, required: IMAGE_TOKEN_COST };
        }

        const result = await this.kling.generateImage(prompt, aspectRatio);
        if (!result) return { ok: false, error: 'image generation failed' };

        await this.pg.query(
          'UPDATE ai_profiles_consolidated SET tokens = tokens - $1, updated_at = now() WHERE user_id = $2',
          [IMAGE_TOKEN_COST, userId],
        );
        return { ok: true, kind: 'image', imageUrl: result.url, tokensSpent: IMAGE_TOKEN_COST };
      }

      if (name === 'generate_video') {
        const dto = input as CreateVideoJobDto;
        const r = await this.video.createJob(userId, dto);
        return { ok: true, kind: 'video', jobId: r.jobId, status: r.status, tokensSpent: r.tokensSpent };
      }

      return { ok: false, error: `unknown tool: ${name}` };
    } catch (e: any) {
      this.logger.warn(`executeTool(${name}) failed: ${e.message}`);
      if (e instanceof InsufficientTokensError) {
        return { ok: false, error: 'insufficient_tokens', balance: e.balance, required: e.required };
      }
      return { ok: false, error: e?.message || 'tool execution failed' };
    }
  }
}
