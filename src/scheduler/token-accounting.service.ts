import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';

@Injectable()
export class TokenAccountingService {
  private readonly logger = new Logger(TokenAccountingService.name);
  private isRunning = false;

  constructor(private readonly pg: PgService) {}

  @Cron('*/5 * * * * *') // every 5 seconds
  async processTokenTasks() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const tasks = await this.pg.query(
        `SELECT id, user_id, input_tokens, output_tokens, tokens_to_consume, agent_id
         FROM token_consumption_tasks
         WHERE status = 'pending'
         LIMIT 50`,
      );

      for (const task of tasks.rows) {
        try {
          let tokensToDeduct = Number(task.tokens_to_consume) || 0;

          // If tokens_to_consume not set, calculate from input/output tokens
          if (tokensToDeduct === 0) {
            const agentId = task.agent_id;
            if (agentId) {
              const pricing = await this.pg.query(
                `SELECT input_price, output_price FROM llm_pricing WHERE agent_id = $1 LIMIT 1`,
                [agentId],
              ).catch(() => ({ rows: [] }));

              if (pricing.rows.length > 0) {
                const { input_price, output_price } = pricing.rows[0];
                tokensToDeduct = Math.ceil(
                  task.input_tokens * Number(input_price) + task.output_tokens * Number(output_price),
                );
              }
            }
            // Fallback: 1 token per total token
            if (tokensToDeduct === 0) {
              tokensToDeduct = (task.input_tokens || 0) + (task.output_tokens || 0) || 1;
            }
          }

          // Try stored procedure first, fallback to direct update
          try {
            await this.pg.query(`SELECT consume_user_tokens($1, $2)`, [task.user_id, tokensToDeduct]);
          } catch {
            await this.pg.query(
              `UPDATE ai_profiles_consolidated
               SET tokens = GREATEST(0, tokens - $1), updated_at = now()
               WHERE user_id = $2`,
              [tokensToDeduct, task.user_id],
            );
          }

          await this.pg.query(
            `UPDATE token_consumption_tasks
             SET status = 'completed', tokens_to_consume = $1, completed_at = now(), updated_at = now()
             WHERE id = $2`,
            [tokensToDeduct, task.id],
          );
        } catch (e) {
          this.logger.error(`Task ${task.id} failed: ${e.message}`);
          await this.pg.query(
            `UPDATE token_consumption_tasks SET status = 'failed', error_message = $1, updated_at = now() WHERE id = $2`,
            [e.message, task.id],
          );
        }
      }
    } catch (e) {
      this.logger.error(`Token accounting error: ${e.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
