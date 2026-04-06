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
        `SELECT id, user_id, input_tokens, output_tokens, model_id
         FROM token_consumption_tasks
         WHERE status = 'pending'
         LIMIT 50`,
      );

      for (const task of tasks.rows) {
        try {
          // Get pricing for model
          const pricing = await this.pg.query(
            `SELECT input_price, output_price FROM llm_pricing WHERE model_id = $1 LIMIT 1`,
            [task.model_id],
          );

          let tokensToDeduct = 0;
          if (pricing.rows.length > 0) {
            const { input_price, output_price } = pricing.rows[0];
            // price is per 1M tokens
            tokensToDeduct = Math.ceil(
              (task.input_tokens * Number(input_price) + task.output_tokens * Number(output_price)) / 1,
            );
          } else {
            // Fallback: 1 token per output token
            tokensToDeduct = task.output_tokens || 1;
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
            `UPDATE token_consumption_tasks SET status = 'done', tokens = $1 WHERE id = $2`,
            [tokensToDeduct, task.id],
          );
        } catch (e) {
          this.logger.error(`Task ${task.id} failed: ${e.message}`);
          await this.pg.query(
            `UPDATE token_consumption_tasks SET status = 'error' WHERE id = $1`,
            [task.id],
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
