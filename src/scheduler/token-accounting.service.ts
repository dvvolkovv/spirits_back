import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PgService } from '../common/services/pg.service';
import { Neo4jService } from '../neo4j/neo4j.service';

@Injectable()
export class TokenAccountingService {
  private readonly logger = new Logger(TokenAccountingService.name);
  private isRunning = false;

  constructor(
    private readonly pg: PgService,
    @Optional() private readonly neo4j: Neo4jService,
  ) {}

  // Clean up desires older than 30 days — runs daily at 3:00 AM
  @Cron('0 3 * * *')
  async cleanupOldDesires() {
    if (!this.neo4j) return;
    try {
      const session = (this.neo4j as any).getSession();
      if (!session) return;
      const result = await session.run(
        `MATCH (p:Profile)-[r:HAS_DESIRE]->(d:Desire)
         WHERE r.created_at < datetime() - duration('P30D')
         DELETE r
         RETURN count(r) as deleted`,
      );
      const deleted = result.records[0]?.get('deleted')?.toNumber() || 0;
      if (deleted > 0) {
        this.logger.log(`Cleaned up ${deleted} desires older than 30 days`);
      }
      await session.close();
    } catch (e) {
      this.logger.error(`cleanupOldDesires error: ${e.message}`);
    }
  }

  @Cron('*/5 * * * * *') // every 5 seconds
  async processTokenTasks() {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      const tasks = await this.pg.query(
        `SELECT t.id, t.user_id, t.input_tokens, t.output_tokens, t.tokens_to_consume,
                t.agent_id, t.metadata, a.name AS agent_name
         FROM token_consumption_tasks t
         LEFT JOIN agents a ON a.id = t.agent_id
         WHERE t.status = 'pending'
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
          const { description, metadata } = this.explainCharge(task);
          try {
            await this.pg.query(
              `SELECT consume_user_tokens($1, $2, $3, $4)`,
              [task.user_id, tokensToDeduct, description, metadata],
            );
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

  /**
   * «За что списали» — строкой и фактами рядом с самим списанием.
   *
   * consume_user_tokens принимает description и metadata с самого начала, и
   * покупки ими пользуются («Пополнение: premium» + payment_id). Чат-путь звал
   * процедуру двумя аргументами, поэтому все consumed-строки лежали с NULL: в
   * базе ход на 862 673 токена выглядел так же, как соседний на 3 170, и
   * разбор 2026-08-10 свёлся к чтению pm2-логов и транскриптов релея.
   *
   * Пользователю это пока не показывается: /tokens/history сознательно отдаёт
   * только начисления (расход виден в чате под каждым сообщением), а лента на
   * десятки тысяч consumed-строк была бы шумом. Читатель этих полей —
   * поддержка и админка, которым иначе нечем ответить на «за что списали».
   *
   * Длительность приписываем только там, где она о чём-то говорит. «0 мин» у
   * каждой второй строки — шум, который обесценит признак ровно в тех случаях,
   * ради которых он и заводится.
   */
  private explainCharge(task: any): { description: string; metadata: string | null } {
    const facts = task.metadata && typeof task.metadata === 'object' ? task.metadata : null;
    const who = task.agent_name ? `ассистента «${task.agent_name}»` : 'ассистента';
    const minutes = Math.round(Number(facts?.durationMs ?? 0) / 60_000);
    const description = minutes >= 1
      ? `Ответ ${who}, ${minutes} мин работы`
      : `Ответ ${who}`;
    return { description, metadata: facts ? JSON.stringify(facts) : null };
  }
}
