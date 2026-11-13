/**
 * Общие части немедленной остановки продукта. Административная блокировка и
 * удаление аккаунта задают разные target/marked, но снятие работы и постановка
 * sleep обязаны оставаться одной механикой.
 *
 * errorExpression — только SQL-плейсхолдер или литерал, выбранный вызывающим
 * кодом; пользовательский текст сюда не передаётся.
 */
export function killActiveProvisionJobsCte(errorExpression: string): string {
  return `killed_jobs AS (
          UPDATE product_provision_jobs j
             SET status = 'failed', error = ${errorExpression}, finished_at = now()
            FROM target t
           WHERE j.product_id = t.id
             AND j.status IN ('queued','running')
          RETURNING j.id
       )`;
}

export function killActiveTurnsCte(errorExpression: string): string {
  return `killed_turns AS (
          UPDATE product_turns tr
             SET status = 'failed', error = ${errorExpression}, finished_at = now()
            FROM target t
           WHERE tr.product_id = t.id
             AND tr.status IN ('queued','running')
          RETURNING tr.id
       )`;
}

/**
 * Ссылка на killed_jobs закрепляет снятие старого активного задания перед
 * INSERT. Для account deletion ON CONFLICT допустим только с последующим
 * чтением фактического sleep и repair через ProductLifecycleService.
 */
export function queueForcedSleepCte(options: { onConflictDoNothing?: boolean } = {}): string {
  return `queued AS (
          INSERT INTO product_provision_jobs (product_id, kind, status)
          SELECT m.id, 'sleep', 'queued'
            FROM marked m
           WHERE (SELECT count(*) FROM killed_jobs) >= 0
          ${options.onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : ''}
          RETURNING product_id
       )`;
}
