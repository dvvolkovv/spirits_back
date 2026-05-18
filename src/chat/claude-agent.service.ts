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
import { translateSdkEvent } from './claude-agent.event-translator';

const SESSION_ROOT = '/tmp/linkeon-smm-sessions';

// Claude Code built-ins to disable — SMM Producer должен использовать только наши MCP tools.
const DISALLOWED_BUILTINS = [
  'Bash', 'Edit', 'Read', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch',
  'Task', 'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'AskUserQuestion',
  'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'CronList',
  'Monitor', 'PushNotification', 'RemoteTrigger', 'Skill', 'TodoWrite', 'ScheduleWakeup',
];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unusedTool = tool;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _unusedZ = z;

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

        const ndjson = translateSdkEvent(event);
        if (ndjson) {
          const events = Array.isArray(ndjson) ? ndjson : [ndjson];
          for (const e of events) {
            res.write(JSON.stringify(e) + '\n');
          }
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

  private buildMcpServer(_ctx: ToolContext): any {
    // Stub — Task 2 fills this in.
    return createSdkMcpServer({
      name: 'smm-tools',
      version: '1.0.0',
      tools: [],
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
