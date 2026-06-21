// src/chat/claude-agent.service.ts
import { Injectable, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import { SmmProducerToolsService, ToolContext } from '../smm/producer/smm-producer-tools.service';
import { SMM_PRODUCER_SYSTEM_PROMPT } from '../smm/producer/smm-producer.prompt';
import { SdkEventTranslator } from './claude-agent.event-translator';

// Persistent path so session resume survives reboots (tmpfs /tmp clears on reboot).
const SESSION_ROOT = path.join(
  process.env.HOME ?? '/home/dvolkov',
  '.linkeon-smm-sessions',
);

// Claude Code built-ins to disable — SMM Producer должен использовать только наши MCP tools.
const DISALLOWED_BUILTINS = [
  'Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Task', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'AskUserQuestion',
  'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'Monitor', 'PushNotification', 'RemoteTrigger', 'Skill', 'TodoWrite', 'ScheduleWakeup',
  'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate', 'TaskOutput', 'TaskStop',
  'ShareOnboardingGuide',
];


@Injectable()
export class ClaudeAgentService {
  private readonly logger = new Logger(ClaudeAgentService.name);

  constructor(
    private readonly pg: PgService,
    private readonly smmTools: SmmProducerToolsService,
  ) {}

  async streamSmmProducer(
    ctx: ToolContext,
    userMessage: string,
    chatSessionId: string,
    agentId: number,
    res: Response,
  ): Promise<void> {
    const cwd = path.join(SESSION_ROOT, ctx.userId);
    await fs.promises.mkdir(cwd, { recursive: true });

    // Pre-flight balance check (defense-in-depth — chat.service.ts also checks).
    const balRes = await this.pg.query(
      `SELECT tokens FROM ai_profiles_consolidated WHERE user_id = $1`,
      [ctx.userId],
    );
    const balance = Number(balRes.rows[0]?.tokens ?? 0);
    if (balance <= 0) {
      res.write(JSON.stringify({
        type: 'error',
        message: '⚠️ Недостаточно токенов для SMM-продюсера. Пополни баланс через /chat?view=tokens.',
      }) + '\n');
      res.end();
      return;
    }

    // Resume previous session if we have one
    const resumeId = await this.loadSessionId(ctx.userId);

    const mcpServer = this.buildMcpServer(ctx);
    const ctxBlock = `Контекст юзера: isAdmin=${ctx.isAdmin}.`;
    const systemPromptWithCtx = `${ctxBlock}\n\n${SMM_PRODUCER_SYSTEM_PROMPT}`;
    let newSessionId: string | undefined;
    let totalCostUsd = 0;
    let renderTokensCharged = 0;
    let assistantText = '';
    const translator = new SdkEventTranslator();

    try {
      for await (const event of query({
        prompt: userMessage,
        options: {
          model: 'claude-haiku-4-5',
          systemPrompt: systemPromptWithCtx,
          mcpServers: { 'smm-tools': mcpServer },
          disallowedTools: DISALLOWED_BUILTINS,
          cwd,
          resume: resumeId,
          permissionMode: 'bypassPermissions',
          includePartialMessages: true,
          settingSources: [],
        } as any,
      })) {
        // Capture session id from system init event
        if (event.type === 'system' && (event as any).subtype === 'init') {
          newSessionId = (event as any).session_id;
        }
        if (event.type === 'result') {
          totalCostUsd = (event as any).total_cost_usd ?? 0;
        }

        const events = translator.translate(event);
        for (const e of events) {
          // Buffer assistant text for history persistence
          if (e.type === 'item' && typeof (e as any).content === 'string') {
            assistantText += (e as any).content;
          }
          // Buffer SMM card markers so history reload restores ScenarioCard/SmmVideoPlayer.
          // Mirrors the frontend stream-handler logic (ChatInterface.tsx:970-1006).
          if (e.type === 'tool_result') {
            const r = (e as any).result;
            const toolName = (e as any).tool as string;
            if (toolName === 'generate_scenarios' && Array.isArray(r?.scenarios)) {
              for (const sc of r.scenarios) {
                if (sc?.id) assistantText += `\n\n{{smm_scenario:id=${sc.id}}}`;
              }
            } else if (toolName === 'approve_scenarios' && Array.isArray(r?.approved)) {
              for (const a of r.approved) {
                if (a?.videoId) {
                  assistantText += `\n\n{{smm_video:id=${a.videoId}}}`;
                  // Attribute render cost to this assistant message so the
                  // "X токенов" суффикс отражает полную стоимость (Claude API + рендер).
                  try {
                    const rRes = await this.pg.query(
                      `SELECT tokens_charged FROM smm_video WHERE id = $1`,
                      [a.videoId],
                    );
                    renderTokensCharged += Number(rRes.rows[0]?.tokens_charged ?? 0);
                  } catch { /* ignore — fallback to Claude-only cost */ }
                }
              }
            } else if (toolName === 'regenerate_scenario' && r?.scenarioId) {
              assistantText += `\n\n{{smm_scenario:id=${r.scenarioId}}}`;
            } else if (toolName === 'generate_banner' && r?.ok && r?.imageUrl) {
              // Прямой URL картинки авто-рендерится фронтом как инлайн-<img>
              // (IMAGE_URL_REGEX в customMarkdown). Кладём в текст — попадёт и в историю.
              // Окружаем переводами строк, чтобы текст модели не приклеился к URL.
              assistantText += `\n\n${r.imageUrl}\n\n`;
            } else if (toolName === 'connect_social') {
              if (r?.method === 'oauth' && r.authorizeUrl) {
                assistantText += `\n\n{{smm_social_connect_button:platform=${r.platform},authorize_url=${r.authorizeUrl}}}`;
              } else if (r?.method === 'manual' && r.platform === 'telegram') {
                assistantText += `\n\n{{smm_social_connect_telegram}}`;
              }
            }
          }
          // Inject Linkeon-token deduction into the end event so frontend
          // shows "X токенов" suffix on the assistant message bubble.
          // Total = Claude API cost + render charges this turn.
          if (e.type === 'end') {
            const linkeonTokens = Math.ceil(totalCostUsd * 100_000) + renderTokensCharged;
            if (linkeonTokens > 0) {
              (e as any).usage = { total: linkeonTokens, costUsd: totalCostUsd };
            }
          }
          res.write(JSON.stringify(e) + '\n');
        }
      }
    } catch (err: any) {
      this.logger.error(`Claude Agent SDK failed: ${err.message}`);
      res.write(JSON.stringify({ type: 'error', message: err.message }) + '\n');
    }

    // Persist session id for resume
    if (newSessionId && newSessionId !== resumeId) {
      await this.saveSessionId(ctx.userId, newSessionId);
    }

    // Persist assistant response to chat history (with Linkeon-token count
    // so history reload shows the same "X токенов" suffix).
    if (assistantText.trim()) {
      const tokensUsed = Math.ceil(totalCostUsd * 100_000) + renderTokensCharged;
      try {
        await this.pg.query(
          `INSERT INTO custom_chat_history (session_id, sender_type, agent, content, message_type, tokens_used)
           VALUES ($1, 'ai', $2, $3, 'text', $4)`,
          [chatSessionId, agentId, assistantText, tokensUsed],
        );
      } catch (e: any) {
        this.logger.warn(`Failed to persist SMM assistant response: ${e.message}`);
      }
    }

    // Token billing: convert SDK total_cost_usd to Linkeon tokens.
    // Placeholder rate: $1 = 100k tokens (~$200/mo Claude Max → 20M tokens/mo budget).
    if (totalCostUsd > 0) {
      const tokensToDeduct = Math.ceil(totalCostUsd * 100_000);
      try {
        await this.pg.query(
          `UPDATE ai_profiles_consolidated
              SET tokens = GREATEST(0, tokens - $1),
                  updated_at = now()
            WHERE user_id = $2`,
          [tokensToDeduct, ctx.userId],
        );
        // Write a completed row to token_consumption_tasks so SMM-producer
        // shows up in admin/usage/assistants stats (which JOINs agents on
        // this table). Tokens were already deducted directly above; status
        // = 'completed' so the regular cron (TokenAccountingService) skips
        // this row.
        try {
          const execId = Math.floor(Math.random() * 2_000_000_000);
          await this.pg.query(
            `INSERT INTO token_consumption_tasks
              (execution_id, user_id, status, agent_id, input_tokens, output_tokens,
               tokens_to_consume, created_at, completed_at, updated_at)
             VALUES ($1, $2, 'completed', $3, 0, 0, $4, now(), now(), now())`,
            [execId, ctx.userId, agentId, tokensToDeduct],
          );
        } catch (e: any) {
          this.logger.warn(`Failed to log SMM usage row: ${e.message}`);
        }
        this.logger.log(
          `SMM agent billing: user=${ctx.userId} cost=$${totalCostUsd.toFixed(4)} deducted=${tokensToDeduct}`,
        );
      } catch (e: any) {
        this.logger.error(`Failed to deduct SMM tokens for ${ctx.userId}: ${e.message}`);
      }
    }

    res.end();
  }

  private buildMcpServer(ctx: ToolContext): any {
    const handle = async (name: string, args: any) => {
      const result = await this.smmTools.handle(name, args, ctx);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    };

    const tools = [
      tool(
        'generate_scenarios',
        "Generate N short-video scenarios for SMM. Use mode='topic' if user gave a topic, 'trends' for trending topics, 'auto' otherwise. count defaults to 3. " +
        "For admin users you can pass premium_genre ('surreal'|'pov'|'cinematic') to render scenarios in a premium style with kling 2.0 + nano-banana keyframes. Omit for классика.",
        {
          mode: z.enum(['topic', 'trends', 'auto']),
          count: z.number().int().min(1).max(10),
          topic: z.string().optional(),
          premium_genre: z.enum(['surreal', 'pov', 'cinematic']).optional(),
        },
        async (args: any) => handle('generate_scenarios', args),
      ),
      tool(
        'regenerate_scenario',
        "Regenerate a single rejected scenario in the same campaign with a different angle.",
        {
          scenario_id: z.string(),
          feedback: z.string().optional(),
        },
        async (args: any) => handle('regenerate_scenario', args),
      ),
      tool(
        'approve_scenarios',
        "Approve one or more scenarios — kicks off the render pipeline. Returns approved videoIds.",
        {
          scenario_ids: z.array(z.string()).min(1),
        },
        async (args: any) => handle('approve_scenarios', args),
      ),
      tool(
        'reject_scenario',
        "Reject a scenario — final, no regeneration.",
        {
          scenario_id: z.string(),
          reason: z.string().optional(),
        },
        async (args: any) => handle('reject_scenario', args),
      ),
      tool(
        'approve_video',
        "Approve a rendered video — marks it ready for publication.",
        {
          video_id: z.string(),
        },
        async (args: any) => handle('approve_video', args),
      ),
      tool(
        'reject_video',
        "Reject a rendered video — marks it as discarded.",
        {
          video_id: z.string(),
          reason: z.string().optional(),
        },
        async (args: any) => handle('reject_video', args),
      ),
      tool(
        'list_scenarios',
        "List the user's recent SMM campaigns and their scenarios. Use when user asks 'что у меня в работе?'",
        {
          campaign_id: z.string().optional(),
        },
        async (args: any) => handle('list_scenarios', args),
      ),
      tool(
        'connect_social',
        "Returns a link the user opens in a browser to authorize Linkeon to publish on a social platform. For Telegram, returns manual setup instructions.",
        {
          platform: z.enum(['telegram', 'vk', 'youtube', 'tiktok', 'instagram']),
        },
        async (args: any) => handle('connect_social', args),
      ),
      tool(
        'schedule_publication',
        "Schedule a video to publish to platforms. scheduled_time accepts ISO timestamp, 'завтра в 18', 'через час', 'сейчас', or null for immediate.",
        {
          video_id: z.string(),
          platforms: z.array(z.enum(['telegram', 'vk', 'youtube', 'tiktok', 'instagram'])).min(1),
          scheduled_time: z.string().optional(),
          caption: z.string().optional(),
        },
        async (args: any) => handle('schedule_publication', args),
      ),
      tool(
        'cancel_publication',
        "Cancel a scheduled publication (status must be 'scheduled', not yet started).",
        {
          publication_id: z.string(),
        },
        async (args: any) => handle('cancel_publication', args),
      ),
      tool(
        'list_publications',
        "List the user's recent publications (last 50), optionally filtered by status or videoId.",
        {
          status: z.enum(['scheduled', 'publishing', 'published', 'failed', 'cancelled']).optional(),
          video_id: z.string().optional(),
        },
        async (args: any) => handle('list_publications', args),
      ),
      tool(
        'set_creator_campaign_settings',
        'Сохранить настройки кампании внешнего автора: CTA-ссылка, пол голоса, жанр. ВЫЗЫВАЙ ПЕРВЫМ для не-админских юзеров — до generate_scenarios.',
        {
          cta_handle: z.string(),
          cta_label: z.string().optional(),
          voice_gender: z.enum(['male', 'female']),
          genre: z.enum(['dialog', 'monologue', 'fact_explanation']).optional(),
        },
        async (args: any) => handle('set_creator_campaign_settings', args),
      ),
      tool(
        'generate_banner',
        'Сгенерировать СТАТИЧНЫЙ баннер/афишу/обложку поста с идеальным текстом (для соцсетей, постов, превью). Фон генерится БЕЗ текста, а заголовок/подзаголовок/CTA накладываются программно — кириллица всегда ровная. Используй, когда пользователь просит баннер, афишу, картинку-пост, обложку с надписью (НЕ видео). Описывай в prompt только фон/сцену без текста; текст — в title/subtitle/cta.',
        {
          prompt: z.string(),
          title: z.string().optional(),
          subtitle: z.string().optional(),
          cta: z.string().optional(),
          aspect_ratio: z.enum(['1:1', '3:4', '4:3', '9:16', '16:9']).optional(),
          position: z.enum(['top', 'center', 'bottom']).optional(),
          theme: z.enum(['dark', 'light']).optional(),
          accent: z.string().optional(),
          quality: z.enum(['std', 'hd']).optional(),
        },
        async (args: any) => handle('generate_banner', args),
      ),
    ];

    return createSdkMcpServer({
      name: 'smm-tools',
      version: '1.0.0',
      tools,
    });
  }

  private async loadSessionId(userId: string): Promise<string | undefined> {
    const r = await this.pg.query(
      `SELECT profile_data->>'smm_sdk_session_id' AS sid
         FROM ai_profiles_consolidated WHERE user_id = $1`,
      [userId],
    );
    return r.rows[0]?.sid ?? undefined;
  }

  private async saveSessionId(userId: string, sessionId: string): Promise<void> {
    await this.pg.query(
      `UPDATE ai_profiles_consolidated
          SET profile_data = COALESCE(profile_data, '{}'::jsonb) || $1::jsonb,
              updated_at = now()
        WHERE user_id = $2`,
      [JSON.stringify({ smm_sdk_session_id: sessionId }), userId],
    );
  }
}
