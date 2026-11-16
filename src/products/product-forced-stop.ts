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

/**
 * Ход убивается БЕЗ оглядки на его признаки жизни — этим блокировка
 * и отличается от сна (см. докблок класса BlockService в block.service.ts).
 * 'queued' здесь наравне с 'running': ход, который ещё не забрал раннер,
 * всё равно держит замок product_turns_one_active и всё равно уехал бы в
 * контейнер, если бы гашение сорвалось.
 */
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
 * Ссылка на killed_jobs (`WHERE (SELECT count(*) FROM killed_jobs) >= 0`)
 * существует ради ПОРЯДКА, а не ради значения: см. «ПОРЯДОК ЧАСТЕЙ ЗАКРЕПЛЁН
 * ССЫЛКОЙ, А НЕ НАДЕЖДОЙ — ЭТО ИЗМЕРЕНО» в докблоке block() в
 * block.service.ts. Без неё вставка исполняется раньше снятия и падает
 * с 23505 — product_provision_jobs_one_active, частичный УНИКАЛЬНЫЙ индекс по
 * product_id при status IN ('queued','running'), не пускает второе активное
 * задание.
 *
 * У административного гашения ON CONFLICT DO NOTHING здесь НЕТ намеренно: он
 * превратил бы чужую гонку из отката всего оператора в блокированный продукт
 * с работающим контейнером — полное обоснование в разделе «ON CONFLICT DO
 * NOTHING ЗДЕСЬ НЕТ, И ЭТО РЕШЕНИЕ, А НЕ ЗАБЫВЧИВОСТЬ» докблока block() в
 * block.service.ts. Для account deletion ON CONFLICT допустим только с
 * последующим чтением фактического sleep и repair через
 * ProductLifecycleService (product-account-deletion.service.ts).
 *
 * skipWhenSleepConfirmed — для account deletion: продукт мог быть архивирован
 * ОБЫЧНЫМ удалением раньше, и его sleep уже подтверждён ('done', создан не
 * старше текущей архивации). Ставить поверх подтверждённого сна новый queued
 * нельзя: контейнер уже погашен, а новый sleep означал бы «остановка не
 * подтверждена» при том, что она подтверждена. Подзапрос к products читает
 * снимок начала оператора: у только что архивируемого продукта archived_at ещё
 * NULL, сравнение NULL — и вставка продолжается, как раньше.
 */
export function queueForcedSleepCte(options: {
  onConflictDoNothing?: boolean;
  skipWhenSleepConfirmed?: boolean;
} = {}): string {
  return `queued AS (
          INSERT INTO product_provision_jobs (product_id, kind, status)
          SELECT m.id, 'sleep', 'queued'
            FROM marked m
           WHERE (SELECT count(*) FROM killed_jobs) >= 0
           ${options.skipWhenSleepConfirmed ? `AND NOT EXISTS (
                 SELECT 1 FROM product_provision_jobs dj
                  WHERE dj.product_id = m.id AND dj.kind = 'sleep' AND dj.status = 'done'
                    AND dj.created_at >= (SELECT archived_at FROM products WHERE id = m.id)
               )` : ''}
           ${options.onConflictDoNothing ? 'ON CONFLICT DO NOTHING' : ''}
          RETURNING product_id
       )`;
}
