// src/chat/chat-tools.ts
import { Injectable, Logger } from '@nestjs/common';
import { KlingService } from '../misc/kling.service';
import { MiscService } from '../misc/misc.service';
import { PgService } from '../common/services/pg.service';
import { VideoService, InsufficientTokensError } from '../video/video.service';
import { CreateVideoJobDto } from '../video/video.dto';
import { RoutineStore, ENERGY_PROMPT } from '../routine-push/routine-store.service';

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
    name: 'generate_banner',
    description:
      'Сгенерировать РЕКЛАМНЫЙ БАННЕР / афишу / обложку с ИДЕАЛЬНЫМ текстом. ОБЯЗАТЕЛЬНО используй этот инструмент (а НЕ generate_image), когда на картинке нужен читаемый текст: заголовок, слоган, цена, призыв к действию, надпись на русском. Почему: модели плохо рендерят кириллицу прямо в картинке (буквы «плывут»). Здесь фон генерится БЕЗ текста, а текст накладывается программно поверх — буквы всегда идеальные. Передавай ТОЛЬКО осмысленный текст в title/subtitle/cta (НЕ дублируй его в prompt — prompt описывает только фон/сцену). Cost: 5000 tokens (std) / 10000 (hd).',
    input_schema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Описание ТОЛЬКО фоновой сцены/стиля (без текста). Напр.: «тёплое летнее побережье на закате, мягкое боке, кинематографичный свет».' },
        title: { type: 'string', description: 'Главный заголовок (крупно). Коротко, до ~6 слов.' },
        subtitle: { type: 'string', description: 'Подзаголовок / пояснение (опц.).' },
        cta: { type: 'string', description: 'Призыв к действию — текст на кнопке-плашке (опц.). Напр. «Записаться», «Купить со скидкой».' },
        aspect_ratio: { type: 'string', enum: ['1:1', '3:4', '4:3', '9:16', '16:9'], default: '1:1', description: '9:16 — истории/Reels, 1:1 — пост, 16:9 — обложка/горизонт.' },
        position: { type: 'string', enum: ['top', 'center', 'bottom'], default: 'bottom', description: 'Где разместить текстовый блок.' },
        theme: { type: 'string', enum: ['dark', 'light'], default: 'dark', description: 'dark = светлый текст на тёмной подложке (универсально); light = тёмный текст на светлой.' },
        accent: { type: 'string', description: 'HEX-цвет плашки CTA, напр. «#2f8f4e» (опц.).' },
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
        sourceImageUrl: { type: 'string', description: 'URL of the image to edit. Pass the imageUrl field returned by a previous generate_image / edit_image / compose_image tool result (absolute https:// MinIO URL). Legacy /static/generated/... paths are also accepted for backward compatibility with older chat history.' },
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
          description: 'Array of 2-3 image URLs. Pass imageUrl fields from previous generate_image / edit_image / compose_image tool results (absolute https:// MinIO URLs). Legacy /static/generated/... paths also accepted for older chat history.',
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
        sourceImageUrl: { type: 'string', description: 'URL of the image to upscale. Pass the imageUrl from a previous tool result (absolute https:// MinIO URL). Legacy /static/generated/... also accepted.' },
      },
      required: ['sourceImageUrl'],
    },
  },
  {
    name: 'generate_video',
    description:
      'Генерация видео. ВАЖНО про взаимодействие:\n' +
      '• Если пользователь не указал движок/тип явно — СНАЧАЛА коротко предложи выбор: «Veo 3.1 — говорящая голова/речь/из портрета, до 60с» или «Kling — сцены и анимация». Не запускай генерацию вслепую, дождись выбора (или явного «на твоё усмотрение»).\n' +
      '• НИКОГДА не пиши и не придумывай ссылку на готовое видео сам — оно появляется у пользователя автоматически отдельной карточкой-плеером. Не вставляй URL вида /static/videos/... .\n' +
      '• Если инструмент вернул ошибку (например, дневной лимит Veo) — просто передай текст ошибки пользователю и НЕ давай никакой ссылки. Не выдумывай, что видео «готовится», если была ошибка.\n' +
      'ДВА движка — выбирай по задаче через поле model:\n' +
      '• Veo 3.1 (model="veo-3.1-fast", или "veo-3.1" для макс. качества) — БЕРИ ЕГО, когда пользователю нужна «говорящая голова» / человек, говорящий в камеру / видео из его ПОРТРЕТА / синхронная озвучка-реплика, особенно длиннее ~10с. Реплику/речь пиши ПРЯМО в prompt — Veo сам произносит её с синхронными губами (нативный звук, отдельный аудио-шаг не нужен). Одно непрерывное видео до 60с (targetDurationSec). Портрет — передай sourceImageUrl + mode="image2video" (без портрета — mode="text2video"). У Veo НЕ используются quality / cameraType / duration 5-10.\n' +
      '  ВАЖНО про длину речи: текст реплики должен СООТВЕТСТВОВАТЬ targetDurationSec. Ориентир — ~2–3 коротких предложения речи на каждые 8 секунд (≈20–25 слов / 8с). Для 24с дай ~6–9 предложений, для 16с — ~4–6. Если реплика короткая, а видео длинное — речь прозвучит один раз, а остаток будет естественная пауза (НЕ повтор). Поэтому либо напиши достаточно текста под нужную длину, либо подбери targetDurationSec под реальную длину реплики. Не проси длинное видео под одну короткую фразу.\n' +
      '• Kling (model="kling-v1-6" по умолчанию, "kling-v2-master" премиум) — универсальная генерация сцен/анимации без обязательной речи. До 10с одним вызовом; длиннее — targetDurationSec (5–60), под капотом base 10s + N×extend 5s + ffmpeg-склейка. Для mode="text2video" без sourceImageUrl сначала генерируется стилл через Nano Banana (+5000 токенов). Есть картинка — sourceImageUrl + mode="image2video".\n' +
      'Стоимость считается автоматически по движку и длине. Long-form (targetDurationSec) — только text2video / image2video.',
    input_schema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['text2video', 'image2video', 'extend', 'lipsync'] },
        prompt: { type: 'string' },
        model: { type: 'string', enum: ['kling-v1-6', 'kling-v2-master', 'veo-3.1-fast', 'veo-3.1'], default: 'kling-v1-6' },
        quality: { type: 'string', enum: ['std', 'pro'], default: 'std' },
        duration: { type: 'number', enum: [5, 10], default: 5 },
        targetDurationSec: {
          type: 'number',
          minimum: 5,
          maximum: 60,
          description: 'Final video length in seconds. Use when user wants > 10s; backend chains extends and concats. Only valid for text2video / image2video.',
        },
        sourceImageUrl: { type: 'string' },
        sourceImageUrls: {
          type: 'array',
          items: { type: 'string' },
          description: 'Veo image2video: до 3 URL референс-фото человека (разные ракурсы). Сходство лица заметно лучше с 3 фото, чем с 1 — проси у пользователя несколько фото для «видео из портрета».',
        },
        aspectRatio: {
          type: 'string',
          enum: ['16:9', '9:16'],
          description: 'Veo only. 9:16 — вертикаль для соцсетей/Reels/Shorts/Stories/TikTok; 16:9 — горизонталь. Если не задан, бэкенд авто-детектит вертикаль по словам в промпте. Спрашивай/ставь 9:16, когда пользователю нужно видео для телефона/соцсетей.',
        },
        resolution: {
          type: 'string',
          enum: ['720p', '1080p'],
          description: 'Veo only. 1080p — выше детализация (кожа/поры), дефолт. 720p — быстрее/легче. Extend-сегменты всегда 720p (ограничение Veo), поэтому 1080p эффективнее на роликах ≤8с.',
        },
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
  {
    name: 'manage_routine',
    description:
      'Настроить или выключить ЕЖЕДНЕВНОЕ проактивное сообщение от тебя пользователю (утренняя рутина: ты сам напишешь ему в заданный час каждый день). ' +
      'Вызывай, КОГДА пользователь просит регулярно / каждый день / по утрам напоминать, писать, присылать что-то (энергию дня, сводку, мотивацию, план и т.п.). ' +
      'Доставка — через push-уведомления. Если инструмент вернёт delivered_hint=true, значит у пользователя не включены уведомления — тактично попроси включить их в Настройках (тумблер «Уведомления на этом устройстве»), иначе рутина не дойдёт. ' +
      'ВАЖНО: не говори пользователю «настроил/буду присылать», ПОКА не вызвал этот инструмент и не получил ok:true. Не выдумывай эту возможность без вызова.\n' +
      '• action="enable" — создать/обновить рутину; "disable" — выключить.\n' +
      '• assistant — ТВОЁ имя как ассистента (например "Райя", "Михаил"): рутина будет идти от тебя.\n' +
      '• hour — локальный час отправки, 0..23 (по умолчанию 8 — утро). Если пользователь назвал время — передай его час.\n' +
      '• prompt — инструкция САМОМУ СЕБЕ: что именно генерировать и присылать каждый день (от первого лица, например «Дай короткую энергию дня и один фокус» или «Сделай сводку по моим задачам на день»). Если не задано — тёплая энергия дня.',
    input_schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['enable', 'disable'], default: 'enable' },
        assistant: { type: 'string', description: 'Твоё имя как ассистента (напр. "Райя"). По нему привязывается рутина.' },
        hour: { type: 'number', minimum: 0, maximum: 23, description: 'Локальный час отправки 0..23 (по умолчанию 8).' },
        prompt: { type: 'string', description: 'Что генерировать и присылать каждый день (инструкция себе). По умолчанию — энергия дня.' },
      },
      required: ['action'],
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
  | { ok: true; kind: 'routine'; enabled: boolean; hour: number; assistant: string; delivered_hint?: boolean }
  | { ok: false; error: string; [k: string]: any };

@Injectable()
export class ChatToolsService {
  private readonly logger = new Logger(ChatToolsService.name);

  constructor(
    private readonly kling: KlingService,
    private readonly misc: MiscService,
    private readonly pg: PgService,
    private readonly video: VideoService,
    private readonly routines: RoutineStore,
  ) {}

  async executeTool(userId: string, name: string, input: any): Promise<ToolResult> {
    try {
      if (name === 'manage_routine') {
        const action = input?.action === 'disable' ? 'disable' : 'enable';
        const who = String(input?.assistant ?? '').trim();
        // Резолвим ассистента (от кого рутина) по имени/display_name или числовому id.
        let assistantId: string | null = null;
        if (/^\d+$/.test(who)) {
          assistantId = who;
        } else if (who) {
          const a = await this.pg.query(
            `SELECT id FROM agents
              WHERE lower(COALESCE(display_name, name)) = lower($1) OR lower(name) = lower($1)
              LIMIT 1`,
            [who],
          );
          if (a.rows[0]) assistantId = String(a.rows[0].id);
        }
        if (!assistantId) {
          return { ok: false, error: 'Укажи assistant — своё имя ассистента (например "Райя"), чтобы привязать рутину к тебе.' };
        }
        const hour = Number.isFinite(input?.hour) ? Math.min(23, Math.max(0, Math.trunc(input.hour))) : 8;
        const prompt = String(input?.prompt ?? '').trim().slice(0, 1000) || ENERGY_PROMPT;
        const tz = (await this.routines.knownTz(userId)) || 'Europe/Moscow';
        const row = await this.routines.upsert(userId, assistantId, {
          enabled: action === 'enable',
          sendHour: hour,
          tz,
          prompt,
        });
        // Есть ли у пользователя подписка на push — иначе рутина не дойдёт.
        const subs = await this.pg.query('SELECT 1 FROM push_subscriptions WHERE user_id = $1 LIMIT 1', [userId]);
        return {
          ok: true,
          kind: 'routine',
          enabled: row.enabled,
          hour: row.sendHour,
          assistant: who,
          delivered_hint: action === 'enable' && subs.rowCount === 0,
        };
      }

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

      if (name === 'generate_banner') {
        const prompt = String(input?.prompt ?? '').slice(0, 2000);
        if (!prompt) return { ok: false, error: 'empty prompt' };
        const title = String(input?.title ?? '').slice(0, 200);
        const subtitle = String(input?.subtitle ?? '').slice(0, 300);
        const cta = String(input?.cta ?? '').slice(0, 120);
        if (!title && !subtitle && !cta) return { ok: false, error: 'banner requires at least title, subtitle or cta' };
        const quality = input?.quality === 'hd' ? 'hd' : 'std';
        const aspect_ratio = ['1:1', '3:4', '4:3', '9:16', '16:9'].includes(input?.aspect_ratio) ? input.aspect_ratio : '1:1';
        const position = ['top', 'center', 'bottom'].includes(input?.position) ? input.position : 'bottom';
        const theme = input?.theme === 'light' ? 'light' : 'dark';
        const accent = typeof input?.accent === 'string' ? input.accent : undefined;

        try {
          const result = await this.misc.generateBanner(userId, {
            prompt, title, subtitle, cta, quality, aspect_ratio, position, theme, accent,
          });
          const imageUrl = result?.images?.[0]?.url;
          if (!imageUrl) return { ok: false, error: 'banner generation failed' };
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
          return { ok: false, error: e?.message || 'banner generation failed' };
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
