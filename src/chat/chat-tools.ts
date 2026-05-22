// src/chat/chat-tools.ts
import { Injectable, Logger } from '@nestjs/common';
import { KlingService } from '../misc/kling.service';
import { MiscService } from '../misc/misc.service';
import { PgService } from '../common/services/pg.service';
import { VideoService, InsufficientTokensError } from '../video/video.service';
import { CreateVideoJobDto } from '../video/video.dto';

export const CHAT_TOOLS = [
  {
    name: 'generate_image',
    description:
      'Generate a single image from a text prompt using Google Imagen 4.0 Ultra (primary) with Nano Banana 2 / Nano Banana Pro (Gemini 3.1 Flash Image / Gemini 3 Pro Image) as fallback. Use whenever the user asks for an image, picture, or illustration (Russian "нарисуй", "сгенерируй картинку", "изображение"). Cost: 5000 tokens (std → Nano Banana 2) or 10000 tokens (hd → Nano Banana Pro, 4K, лучше рендерит текст/кириллицу).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        quality: { type: 'string', enum: ['std', 'hd'], default: 'std' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'edit_image',
    description:
      'Edit / modify an existing image using Nano Banana 2 (std) or Nano Banana Pro (hd, 4K). Use when the user wants to change, fix, or iterate on a previously generated image — "сделай небо закатным", "убери фон", "добавь шапку", "сделай его рыжим", "замени надпись на X". Pass sourceImageUrl from the previous generate_image / edit_image tool result (imageUrl field). Cost: 5000 tokens (std) or 10000 tokens (hd).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'What to change in the image (in the user\'s language).' },
        sourceImageUrl: { type: 'string', description: 'URL of the image to edit. Must be either /static/generated/... (previously generated on this platform) or an absolute https:// URL.' },
        quality: { type: 'string', enum: ['std', 'hd'], default: 'std' },
      },
      required: ['prompt', 'sourceImageUrl'],
    },
  },
  {
    name: 'compose_image',
    description:
      'Combine 2-3 source images into one new image using Nano Banana 2 (std) or Nano Banana Pro (hd, 4K). Use when the user wants to merge, combine, or compose multiple images — "возьми моё фото и посади меня на этот трон", "соедини товар с этим фоном", "объедини эти две картинки". Pass 2-3 URLs in sourceImageUrls (order matters — first is usually the primary subject). Cost: 5000 tokens (std) or 10000 tokens (hd).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Describe how to combine the images (in the user\'s language). Be specific about which element from which image goes where.' },
        sourceImageUrls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 3,
          description: 'Array of 2-3 image URLs. Can be /static/generated/... from previous tool results, or absolute https:// URLs.',
        },
        quality: { type: 'string', enum: ['std', 'hd'], default: 'std' },
      },
      required: ['prompt', 'sourceImageUrls'],
    },
  },
  {
    name: 'upscale_image',
    description:
      'Enhance image quality using Nano Banana Pro — sharpens details, reduces noise, preserves content identically. Use when the user asks "улучши качество", "сделай чётче", "убери шум", "enhance". Note: pixel resolution stays the same; detail fidelity is what improves. Cost: 10000 tokens.',
    input_schema: {
      type: 'object',
      properties: {
        sourceImageUrl: { type: 'string', description: 'URL of the image to upscale. /static/generated/... or absolute https://.' },
      },
      required: ['sourceImageUrl'],
    },
  },
  {
    name: 'generate_video',
    description:
      'Generate a short 5-10s video using Kling. Use when the user asks for a video / animation / "оживи" an image / "сделай видео". ВАЖНО: для mode="text2video" без sourceImageUrl мы сначала автоматически генерируем стилл-кадр через Nano Banana 2 (Imagen 4.0 Ultra primary), а потом анимируем его в image2video — это даёт стабильно лучше композицию, чем «голый» text2video Kling. Итоговая стоимость = картинка 5000 + видео по обычной image2video-сетке (например, kling-v1-6 std 5s → 5000 + 25000 = 30000). Если у тебя уже есть подходящая картинка (из предыдущего generate_image / edit_image / compose_image), передай её как sourceImageUrl и mode="image2video" — это избавит от лишней генерации.',
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
  | {
      ok: true;
      kind: 'video';
      jobId: string;
      status: string;
      tokensSpent: number;
      stillImageUrl?: string;
      imageTokensSpent?: number;
    }
  | { ok: false; error: string; [k: string]: any };

@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  constructor(
    private readonly kling: KlingService,
    private readonly misc: MiscService,
    private readonly pg: PgService,
    private readonly video: VideoService,
  ) {}

  async executeTool(userId: string, name: string, input: any): Promise<ToolResult> {
    try {
      if (name === 'generate_image') {
        const prompt = String(input?.prompt ?? '').slice(0, 2000);
        if (!prompt) return { ok: false, error: 'empty prompt' };
        const quality = input?.quality === 'hd' ? 'hd' : 'std';

        // Delegate to MiscService.generateImage — it runs Imagen 4.0 Ultra (primary) with
        // Nano Banana 2 (std) / Nano Banana Pro (hd) as fallback, handles balance/deduction
        // and history. Throws on insufficient funds or model failure.
        try {
          const result = await this.misc.generateImage(userId, { prompt, quality });
          const imageUrl = result?.images?.[0]?.url;
          if (!imageUrl) return { ok: false, error: 'image generation failed' };
          return { ok: true, kind: 'image', imageUrl, tokensSpent: Number(result.tokensSpent || 0) };
        } catch (e: any) {
          if (/недостаточно|insufficient/i.test(e?.message || '')) {
            const bal = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1', [userId]);
            return {
              ok: false, error: 'insufficient_tokens',
              balance: Number(bal.rows[0]?.tokens || 0),
              required: quality === 'hd' ? 10000 : 5000,
            };
          }
          return { ok: false, error: e?.message || 'image generation failed' };
        }
      }

      if (name === 'edit_image') {
        const prompt = String(input?.prompt ?? '').slice(0, 2000);
        const sourceImageUrl = String(input?.sourceImageUrl ?? '').trim();
        if (!prompt) return { ok: false, error: 'empty prompt' };
        if (!sourceImageUrl) return { ok: false, error: 'sourceImageUrl required' };
        const quality = input?.quality === 'hd' ? 'hd' : 'std';

        try {
          const result = await this.misc.editImage(userId, { prompt, sourceImageUrl, quality });
          const imageUrl = result?.images?.[0]?.url;
          if (!imageUrl) return { ok: false, error: 'image edit failed' };
          return { ok: true, kind: 'image', imageUrl, tokensSpent: Number(result.tokensSpent || 0) };
        } catch (e: any) {
          if (/недостаточно|insufficient/i.test(e?.message || '')) {
            const bal = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1', [userId]);
            return {
              ok: false, error: 'insufficient_tokens',
              balance: Number(bal.rows[0]?.tokens || 0),
              required: quality === 'hd' ? 10000 : 5000,
            };
          }
          return { ok: false, error: e?.message || 'image edit failed' };
        }
      }

      if (name === 'compose_image') {
        const prompt = String(input?.prompt ?? '').slice(0, 2000);
        const sourceImageUrls = Array.isArray(input?.sourceImageUrls)
          ? input.sourceImageUrls.map((u: any) => String(u || '').trim()).filter(Boolean)
          : [];
        if (!prompt) return { ok: false, error: 'empty prompt' };
        if (sourceImageUrls.length < 2) return { ok: false, error: 'compose_image requires at least 2 sourceImageUrls' };
        if (sourceImageUrls.length > 3) return { ok: false, error: 'compose_image supports at most 3 sourceImageUrls' };
        const quality = input?.quality === 'hd' ? 'hd' : 'std';

        try {
          const result = await this.misc.composeImage(userId, { prompt, sourceImageUrls, quality });
          const imageUrl = result?.images?.[0]?.url;
          if (!imageUrl) return { ok: false, error: 'image compose failed' };
          return { ok: true, kind: 'image', imageUrl, tokensSpent: Number(result.tokensSpent || 0) };
        } catch (e: any) {
          if (/недостаточно|insufficient/i.test(e?.message || '')) {
            const bal = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1', [userId]);
            return {
              ok: false, error: 'insufficient_tokens',
              balance: Number(bal.rows[0]?.tokens || 0),
              required: quality === 'hd' ? 10000 : 5000,
            };
          }
          return { ok: false, error: e?.message || 'image compose failed' };
        }
      }

      if (name === 'upscale_image') {
        const sourceImageUrl = String(input?.sourceImageUrl ?? '').trim();
        if (!sourceImageUrl) return { ok: false, error: 'sourceImageUrl required' };

        try {
          const result = await this.misc.upscaleImage(userId, { sourceImageUrl });
          const imageUrl = result?.images?.[0]?.url;
          if (!imageUrl) return { ok: false, error: 'upscale failed' };
          return { ok: true, kind: 'image', imageUrl, tokensSpent: Number(result.tokensSpent || 0) };
        } catch (e: any) {
          if (/недостаточно|insufficient/i.test(e?.message || '')) {
            const bal = await this.pg.query('SELECT tokens FROM ai_profiles_consolidated WHERE user_id=$1', [userId]);
            return { ok: false, error: 'insufficient_tokens', balance: Number(bal.rows[0]?.tokens || 0), required: 10000 };
          }
          return { ok: false, error: e?.message || 'upscale failed' };
        }
      }

      if (name === 'generate_video') {
        // Auto-chain (text2video → image+image2video) теперь живёт в VideoService.createJob,
        // чтобы и UI-форма /webhook/video/jobs, и MCP-инструмент отрабатывали одинаково.
        const dto = input as CreateVideoJobDto;
        const r = await this.video.createJob(userId, dto);
        return {
          ok: true,
          kind: 'video',
          jobId: r.jobId,
          status: r.status,
          tokensSpent: r.tokensSpent,
          ...(r.stillImageUrl ? { stillImageUrl: r.stillImageUrl, imageTokensSpent: r.imageTokensSpent ?? 0 } : {}),
        };
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
