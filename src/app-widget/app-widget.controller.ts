import { Controller, Get, UseGuards } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { JwtGuard } from '../common/guards/jwt.guard';
import { CurrentUser } from '../common/decorators/user.decorator';

/**
 * Контент домашнего виджета нативного приложения [Натив 4].
 *
 * Приложение при открытии дёргает GET /webhook/app-widget/content и кладёт
 * ответ в нативное хранилище (SharedPreferences); Kotlin-виджет рисует
 * сохранённое. Токен не покидает приложение, в виджете нет сетевого кода.
 *
 * Возвращаем ТОЛЬКО реально существующие данные (этика: не выдавать статику
 * за персонализацию): последний ассистент + линия контекста из истории;
 * energyLine — лишь если у юзера реально включена энерго-рутина (тогда это
 * последняя доставленная реплика Райи, а не выдуманный текст).
 */
function snippet(s: string, n = 90): string {
  if (!s) return '';
  const t = s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')     // ![](картинка)
    .replace(/\{\{[^}]*\}\}/g, '')             // {{button:...}} / {{link:...}}
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [текст](url) → текст
    .replace(/[#*_`>]/g, '')                   // markdown-символы
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

@Controller('app-widget')
export class AppWidgetController {
  constructor(private readonly pg: PgService) {}

  @Get('content')
  @UseGuards(JwtGuard)
  async content(@CurrentUser() user: any) {
    const userId = String(user.userId);

    // Последний ассистент + последняя реплика (по всем сессиям юзера).
    let assistantId: string | null = null;
    let assistantName: string | null = null;
    let contextLine = '';
    const last = await this.pg.query(
      `SELECT agent, content
         FROM custom_chat_history
        WHERE session_id LIKE ($1 || '\\_%') ESCAPE '\\'
        ORDER BY created_at DESC
        LIMIT 1`,
      [userId],
    );
    if (last.rows[0]) {
      contextLine = snippet(last.rows[0].content || '');
      const agentName = last.rows[0].agent;
      if (agentName) {
        const a = await this.pg.query(
          `SELECT id::text AS id, COALESCE(display_name, name) AS display_name
             FROM agents WHERE name = $1 LIMIT 1`,
          [agentName],
        );
        if (a.rows[0]) {
          assistantId = a.rows[0].id;
          assistantName = a.rows[0].display_name;
        }
      }
    }

    // Энергия дня — только при реально включённой энерго-рутине.
    let energyLine: string | null = null;
    const er = await this.pg.query(
      `SELECT 1 FROM routine_pushes WHERE user_id = $1 AND kind = 'energy_of_day' LIMIT 1`,
      [userId],
    );
    if (er.rows[0]) {
      const e = await this.pg.query(
        `SELECT content FROM custom_chat_history
          WHERE session_id = $1 || '_14' AND sender_type <> 'human'
          ORDER BY created_at DESC LIMIT 1`,
        [userId],
      );
      if (e.rows[0]) energyLine = snippet(e.rows[0].content || '', 100);
    }

    return {
      assistantId,
      assistantName,
      contextLine,
      energyLine,
      hasEnergy: !!energyLine,
    };
  }
}
