/** Соединение пула или клиент открытой транзакции. */
type Tx = { query(sql: string, params?: any[]): Promise<{ rows: any[] }> };

/**
 * Возвращена ли уже стоимость видеозадачи.
 *
 * Стоимость задачи возвращают два места, и оба пишут 'refund' в
 * token_transactions:
 *   - VideoService.failAndRefund при провале — metadata.job_id;
 *   - перезапуск из поддержки (SupportService.performRerun) сразу возвращает
 *     списание новой задачи — metadata.new_job_id.
 * Спрашивать надо оба ключа: перезапущенная задача, упав, иначе вернула бы
 * свою стоимость второй раз, а перезапуск перезапуска — стоимость первой.
 *
 * jobId — канонический id из video_jobs (нижний регистр): metadata — текст, и
 * сравнение с ним регистр не прощает.
 */
export async function jobCostRefunded(tx: Tx, userId: string, jobId: string): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM token_transactions
      WHERE user_id = $1 AND transaction_type = 'refund'
        AND (metadata->>'job_id' = $2 OR metadata->>'new_job_id' = $2)
      LIMIT 1`,
    [userId, jobId],
  );
  return r.rows.length > 0;
}
