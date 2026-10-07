import { AgentsService } from '../agents/agents.service';
import { PgService } from '../common/services/pg.service';

/** Коллега в системном промпте ассистента — имя и описание на языке пользователя. */
export interface Coworker {
  display_name: string;
  description: string;
}

/**
 * Кого ассистент может представить пользователю как коллегу и на кого
 * предложить переключиться.
 *
 * Только тех, кого пользователь может выбрать сам, — фильтр тот же, что у
 * экрана выбора (AgentsService.getAgents): активные и не служебные. Без него
 * выключенные ассистенты (Герман, Юлия) и служебная строка голосового цикла
 * «Линкеон» попадали в системный промпт каждого ассистента с припиской
 * «предложи переключиться на него» — на того, кого в списке выбора нет.
 *
 * Один запрос на оба пути сборки промпта — релей (buildRelayStablePrefix) и
 * Машу. Раньше у каждого была своя копия, и разошлись они ровно на фильтрах:
 * у релея проверялось только описание, у Маши не проверялось ничего.
 *
 * Строка без описания коллегой не считается: представить её нечем.
 * Имя и описание — из agent_translations на языке пользователя, иначе
 * ассистент предложит «Машу» кириллицей посреди испанского ответа.
 */
export async function loadCoworkers(
  pg: Pick<PgService, 'query'>,
  selfId: number,
  locale: string,
): Promise<Coworker[]> {
  const res = await pg.query(
    `SELECT COALESCE(t.display_name, a.display_name, a.name) AS display_name,
            COALESCE(t.description, a.description)           AS description
       FROM agents a
       LEFT JOIN agent_translations t
              ON t.entity_type = 'agent'
             AND t.entity_id   = a.id::text
             AND t.locale      = $2
      WHERE a.id <> $1
        AND a.is_active
        AND a.name <> ALL($3::text[])
        AND a.description IS NOT NULL
      ORDER BY a.id`,
    [selfId, locale, AgentsService.SERVICE_AGENTS],
  );
  return res.rows;
}
