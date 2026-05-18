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

const SESSION_ROOT = '/tmp/linkeon-smm-sessions';

// Claude Code built-ins to disable — SMM Producer должен использовать только наши MCP tools.
const DISALLOWED_BUILTINS = [
  'Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Task', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'AskUserQuestion',
  'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'Monitor', 'PushNotification', 'RemoteTrigger', 'Skill', 'TodoWrite', 'ScheduleWakeup',
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
    res: Response,
  ): Promise<void> {
    const cwd = path.join(SESSION_ROOT, ctx.userId);
    await fs.promises.mkdir(cwd, { recursive: true });

    // Resume previous session if we have one
    const resumeId = await this.loadSessionId(ctx.userId);

    const mcpServer = this.buildMcpServer(ctx);
    let newSessionId: string | undefined;
    let totalCostUsd = 0;
    const translator = new SdkEventTranslator();

    try {
      for await (const event of query({
        prompt: userMessage,
        options: {
          model: 'claude-haiku-4-5',
          systemPrompt: SMM_PRODUCER_SYSTEM_PROMPT,
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

    // Token accounting hook — placeholder until Task 5
    if (totalCostUsd > 0) {
      this.logger.log(`SMM agent cost for user ${ctx.userId}: $${totalCostUsd.toFixed(4)}`);
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
        "Generate N short-video scenarios for SMM. Use mode='topic' if user gave a topic, 'trends' for trending topics, 'auto' otherwise. count defaults to 3.",
        {
          mode: z.enum(['topic', 'trends', 'auto']),
          count: z.number().int().min(1).max(10),
          topic: z.string().optional(),
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
