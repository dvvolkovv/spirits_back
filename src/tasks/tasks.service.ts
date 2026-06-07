import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import { PgService } from '../common/services/pg.service';
import { shouldSkipTaskExtraction } from './extract-prefilter';

function cosineSim(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  summary: string;
  claudemd: string;
  claudemd_locked: boolean;
  status: 'active' | 'archived' | 'done';
  last_active_at: string;
  embedding: number[] | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class TasksService implements OnModuleInit {
  private readonly logger = new Logger(TasksService.name);

  // Активная задача автоматически переходит в архив, если по ней не было
  // событий 60 дней. Архивные хранятся вечно — recall их вытаскивает по
  // semantic search, если юзер «помнишь когда-то...».
  private readonly ACTIVE_TTL_DAYS = 60;

  constructor(@Optional() private readonly pg?: PgService) {}

  async onModuleInit() {
    if (!this.pg) return;
    const candidates = [
      path.join(__dirname, 'migrations', '001_tasks.sql'),
      path.join(__dirname, '..', '..', 'src', 'tasks', 'migrations', '001_tasks.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`tasks migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`tasks migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('tasks migration sql not found, skipping');
  }

  // ─────────────────────────────────────────────────────────────────────
  // PUBLIC API
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Главная точка интеграции: вызывается из chat.service.ts после persist
   * каждой пары human+ai (setImmediate, асинхронно — не блокирует ответ).
   *
   * Делает ОДИН LLM-вызов (Haiku 4.5) — отдаёт диалог + список активных
   * задач юзера → LLM решает:
   *   - match существующая → append event + обновить summary
   *   - new → создать task с title/summary/claudemd
   *   - ничего — реплика про задачу не была
   *
   * Цена: ~$0.001/turn. Не блокирует ответ юзеру (всё в setImmediate).
   */
  async extractFromTurn(
    userId: string,
    agentId: string,
    userMessage: string,
    assistantMessage: string,
  ): Promise<void> {
    if (!this.pg) return;
    if (shouldSkipTaskExtraction(userMessage)) return;
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) return;

    try {
      const active = await this.listActive(userId);
      const decision = await this.askLLMForDecision(
        userId, agentId, userMessage, assistantMessage, active,
      );
      if (!decision) return;
      await this.applyDecision(userId, parseInt(agentId, 10) || null, decision);
    } catch (e: any) {
      this.logger.warn(`extractFromTurn failed for ${userId}/${agentId}: ${e?.message}`);
    }
  }

  /** Список активных задач юзера (для context injection и для LLM-промпта). */
  async listActive(userId: string): Promise<TaskRow[]> {
    if (!this.pg) return [];
    const res = await this.pg.query(
      `SELECT * FROM tasks
       WHERE user_id = $1 AND status = 'active'
       ORDER BY last_active_at DESC
       LIMIT 30`,
      [userId],
    );
    return res.rows;
  }

  /** Cron: переводит активные задачи без событий >60 дней в архив. */
  async archiveStale(): Promise<number> {
    if (!this.pg) return 0;
    const r = await this.pg.query(
      `UPDATE tasks
         SET status = 'archived', updated_at = now()
         WHERE status = 'active'
           AND last_active_at < now() - interval '${this.ACTIVE_TTL_DAYS} days'
       RETURNING id`,
    );
    if (r.rows.length > 0) {
      this.logger.log(`archived ${r.rows.length} stale tasks (no activity >${this.ACTIVE_TTL_DAYS}d)`);
    }
    return r.rows.length;
  }

  /** Полная инфа по задаче + последние N событий (для admin drawer и для LLM tool get_task). */
  async getTaskFull(taskId: string, eventsLimit = 20): Promise<{ task: TaskRow; events: any[] } | null> {
    if (!this.pg) return null;
    const tRes = await this.pg.query(`SELECT * FROM tasks WHERE id = $1`, [taskId]);
    if (!tRes.rows.length) return null;
    const eRes = await this.pg.query(
      `SELECT id, kind, content, agent_id, created_at FROM task_events
         WHERE task_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [taskId, eventsLimit],
    );
    return { task: tRes.rows[0], events: eRes.rows.reverse() };
  }

  /**
   * Готовый текстовый блок для инжекта в system_prompt любого ассистента.
   *
   * Состоит из двух частей:
   *   1. «Активные задачи» — топ-5 active по релевантности к текущей реплике
   *      (или по recency, если embedding юзер-реплики не получилось посчитать).
   *   2. «Архивные задачи (возможно, связанные)» — топ-3 archived с cosine
   *      similarity ≥ ARCHIVE_RECALL_THRESHOLD к текущей реплике. Это и есть
   *      авто-recall старых проектов («помнишь, год назад мы делали X?»).
   *
   * Если задач нет вовсе — пустая строка, ничего не инжектится.
   */
  async buildContextForPrompt(userId: string, userMessage: string = ''): Promise<string> {
    if (!this.pg) return '';

    const TOP_ACTIVE = 5;
    const TOP_ARCHIVE = 3;
    const ARCHIVE_RECALL_THRESHOLD = 0.62; // 0..1 — эмпирически: ниже шум, выше пропуски

    const active = await this.listActive(userId);
    let archived: TaskRow[] = [];
    if (this.pg) {
      const res = await this.pg.query(
        `SELECT * FROM tasks WHERE user_id = $1 AND status = 'archived' LIMIT 500`,
        [userId],
      );
      archived = res.rows;
    }

    if (active.length === 0 && archived.length === 0) return '';

    // One embedding call для ранжирования обоих списков. Если ключ OpenAI
    // не настроен — qVec=null, активные берём по recency, archived recall
    // не делаем (без embedding'а ничего не сматчишь).
    const qVec = userMessage ? await this.embed(userMessage) : null;

    // Активные
    let selectedActive: TaskRow[];
    if (active.length <= TOP_ACTIVE) {
      selectedActive = active;
    } else if (qVec) {
      const scored = active.map(t => ({
        t,
        score: t.embedding ? cosineSim(qVec, t.embedding) : -1,
      }));
      scored.sort((a, b) => b.score - a.score);
      selectedActive = scored.slice(0, TOP_ACTIVE).map(s => s.t);
    } else {
      selectedActive = active.slice(0, TOP_ACTIVE);
    }

    // Архивные (recall) — только если есть embedding юзер-реплики
    let selectedArchive: Array<{ t: TaskRow; score: number }> = [];
    if (qVec && archived.length > 0) {
      const scored = archived
        .filter(t => t.embedding)
        .map(t => ({ t, score: cosineSim(qVec, t.embedding!) }));
      scored.sort((a, b) => b.score - a.score);
      selectedArchive = scored
        .filter(x => x.score >= ARCHIVE_RECALL_THRESHOLD)
        .slice(0, TOP_ARCHIVE);
    }

    const parts: string[] = [];

    if (selectedActive.length > 0) {
      const lines = selectedActive
        .map((t, i) => {
          const summary = (t.summary || '').trim() || '(описание пусто)';
          return `${i + 1}. ${t.title}\n   ${summary}`;
        })
        .join('\n');
      parts.push(
        `--- Активные задачи пользователя ---\n${lines}\n\nЕсли реплика пользователя относится к одной из этих задач — продолжай разговор с учётом этого контекста.`,
      );
    }

    if (selectedArchive.length > 0) {
      const lines = selectedArchive
        .map((x, i) => {
          const summary = (x.t.summary || '').trim() || '(описание пусто)';
          const dateLabel = x.t.last_active_at ? ` · последняя активность ${new Date(x.t.last_active_at).toISOString().slice(0, 10)}` : '';
          return `${i + 1}. ${x.t.title}${dateLabel}\n   ${summary}`;
        })
        .join('\n');
      parts.push(
        `--- Архивные задачи (возможно, связанные с этим запросом) ---\n${lines}\n\nЕсли пользователь явно ссылается на одну из этих архивных задач («помнишь когда мы…», «то что было год назад…») — можешь поднять её контекст. Иначе не упоминай их без необходимости, чтобы не отвлекать от текущего разговора.`,
      );
    }

    return parts.length > 0 ? parts.join('\n\n') + '\n' : '';
  }

  /** Список задач юзера для admin UI (все статусы). */
  async listForAdmin(userId: string): Promise<TaskRow[]> {
    if (!this.pg) return [];
    const res = await this.pg.query(
      `SELECT id, user_id, title, summary, status, claudemd_locked, last_active_at, created_at
         FROM tasks WHERE user_id = $1
         ORDER BY (status = 'active') DESC, last_active_at DESC LIMIT 200`,
      [userId],
    );
    return res.rows;
  }

  /**
   * Список задач юзера для пользовательского UI (раздел «Задачи» в /profile).
   * Возвращает только поля, нужные UI: без claudemd (это для агентов, не для юзера в MVP).
   * Сортировка: active сверху, потом по last_active_at desc.
   */
  async listForUser(userId: string): Promise<Array<{
    id: string;
    title: string;
    status: 'active' | 'archived' | 'done';
    summary: string | null;
    last_active_at: string | null;
  }>> {
    if (!this.pg) return [];
    const res = await this.pg.query(
      `SELECT id, title, status, summary, last_active_at
         FROM tasks
         WHERE user_id = $1
         ORDER BY (status = 'active') DESC, last_active_at DESC
         LIMIT 200`,
      [userId],
    );
    return res.rows;
  }

  /**
   * Детали задачи для user-эндпоинта: проверяет владение,
   * джойнит события с agent_name, не возвращает claudemd.
   */
  async getTaskFullForUser(
    taskId: string,
    userId: string,
    eventsLimit = 20,
  ): Promise<{
    task: {
      id: string;
      title: string;
      summary: string | null;
      status: 'active' | 'archived' | 'done';
      last_active_at: string | null;
    };
    events: Array<{
      id: string;
      content: string;
      agent_id: number | null;
      agent_name: string | null;
      created_at: string;
    }>;
  } | null> {
    if (!this.pg) return null;
    const tRes = await this.pg.query(
      `SELECT id, title, summary, status, last_active_at
         FROM tasks
         WHERE id = $1 AND user_id = $2`,
      [taskId, userId],
    );
    if (!tRes.rows.length) return null;
    const task = tRes.rows[0];
    const eRes = await this.pg.query(
      `SELECT e.id, e.content, e.agent_id, COALESCE(a.display_name, a.name) AS agent_name, e.created_at
         FROM task_events e
         LEFT JOIN agents a ON a.id = e.agent_id
         WHERE e.task_id = $1
         ORDER BY e.created_at DESC
         LIMIT $2`,
      [taskId, eventsLimit],
    );
    return {
      task: {
        id: task.id,
        title: task.title,
        summary: task.summary,
        status: task.status,
        last_active_at: task.last_active_at,
      },
      events: eRes.rows.reverse(),
    };
  }

  /**
   * Меняет статус задачи. Проверяет владение через WHERE user_id.
   * Возвращает обновлённую запись или null, если задача не принадлежит юзеру.
   */
  async setStatus(
    taskId: string,
    userId: string,
    status: 'active' | 'archived' | 'done',
  ): Promise<{
    id: string;
    title: string;
    summary: string | null;
    status: 'active' | 'archived' | 'done';
    last_active_at: string | null;
  } | null> {
    if (!['active', 'archived', 'done'].includes(status)) {
      throw new Error(`invalid status: ${status}`);
    }
    if (!this.pg) return null;
    const res = await this.pg.query(
      `UPDATE tasks
         SET status = $1, updated_at = now()
         WHERE id = $2 AND user_id = $3
         RETURNING id, title, summary, status, last_active_at`,
      [status, taskId, userId],
    );
    return res.rows.length ? res.rows[0] : null;
  }

  // ─────────────────────────────────────────────────────────────────────
  // INTERNALS
  // ─────────────────────────────────────────────────────────────────────

  /**
   * Спрашивает LLM: что делать с этим turn'ом?
   * Возвращает структурированное решение:
   *   { action: 'none' }
   *   { action: 'append', taskId, eventContent, newSummary? }
   *   { action: 'create', title, summary, claudemd, firstEventContent }
   *
   * При action='append' опционально присылается newClaudemd, если LLM
   * решил что «обстоятельства поменялись, переписываю manual».
   * Поле игнорируется если у задачи claudemd_locked = true.
   */
  private async askLLMForDecision(
    userId: string,
    agentId: string,
    userMessage: string,
    assistantMessage: string,
    activeTasks: TaskRow[],
  ): Promise<any | null> {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const activeBlock = activeTasks.length === 0
      ? '(нет активных задач)'
      : activeTasks
          .map((t, i) => `${i + 1}. id=${t.id}\n   title: ${t.title}\n   summary: ${t.summary || '(пусто)'}`)
          .join('\n\n');

    const prompt = `Ты — помощник, который ведёт операционную память пользователя на платформе my.linkeon.io.

После каждого диалога с любым ассистентом ты анализируешь реплики и решаешь — относится ли разговор к одной из текущих задач пользователя, или зарождается новая.

ТЕКУЩИЕ АКТИВНЫЕ ЗАДАЧИ пользователя:
${activeBlock}

ПОСЛЕДНЯЯ РЕПЛИКА ПОЛЬЗОВАТЕЛЯ (агент id=${agentId}):
"""
${userMessage.slice(0, 3000)}
"""

ОТВЕТ АССИСТЕНТА:
"""
${assistantMessage.slice(0, 3000)}
"""

Реши одно из:
- **none** — реплика бытовая, не про какую-либо задачу (типа «привет», «спасибо», «как дела», общие вопросы без проекта/обязательств/конкретики).
- **append** — это про существующую задачу из списка выше. Укажи taskId, кратко опиши что произошло (eventContent), и обнови summary одним-двумя предложениями ("где мы сейчас"). Опционально перепиши claudemd если обстоятельства задачи поменялись принципиально.
- **create** — это начало новой задачи. Дай ей короткий title (3-7 слов), summary (1-2 предложения), claudemd (полная инструкция: цель, контекст, участники, ключевые ограничения; до 1500 символов), и firstEventContent.

ПРАВИЛА:
- Задача — это операционный контекст с явной целью или продолжающимся вопросом. НЕ ценность, НЕ убеждение, НЕ интерес. Примеры задач: «Запуск Telegram-бота», «Развод с компаньоном», «Подбор школы для сына», «Налоги за 2026», «Переезд в Канаду». Примеры НЕ-задач: «обсуждение философии», «вопрос про погоду», «уточняющий вопрос про текущую задачу из списка» (это append, не create).
- Лучше **none**, чем создать пустую/мусорную задачу. Порог создания — высокий.
- При **append**: если разговор был совсем поверхностный («ага», «понял», «спасибо»), верни none — добавлять нечего.
- При **create**: title в именительном падеже, без местоимений и без «нужно/хочу». Просто короткое название проекта.

Верни ТОЛЬКО валидный JSON. Без markdown-обёрток и без сопроводительной прозы.

Схема:
{"action": "none"}
ИЛИ
{"action": "append", "taskId": "uuid", "eventContent": "...", "newSummary": "...", "newClaudemd": "..." (опционально)}
ИЛИ
{"action": "create", "title": "...", "summary": "...", "claudemd": "...", "firstEventContent": "..."}`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });
    const text = msg.content?.[0]?.text || '';
    const parsed = this.parseJsonTolerant(text);
    if (!parsed?.action) return null;
    if (!['none', 'append', 'create'].includes(parsed.action)) return null;
    if (parsed.action === 'none') return null; // ничего делать не надо
    return parsed;
  }

  private async applyDecision(userId: string, agentId: number | null, decision: any): Promise<void> {
    if (!this.pg) return;

    if (decision.action === 'create') {
      const title = String(decision.title || '').trim().slice(0, 150);
      const summary = String(decision.summary || '').trim().slice(0, 500);
      const claudemd = String(decision.claudemd || '').trim().slice(0, 4000);
      const firstEvent = String(decision.firstEventContent || decision.summary || '').trim().slice(0, 2000);
      if (!title) return;

      const embedding = await this.embed(`${title}\n${summary}\n${claudemd}`);
      const ins = await this.pg.query(
        `INSERT INTO tasks (user_id, title, summary, claudemd, embedding, last_active_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, now(), now())
         RETURNING id`,
        [userId, title, summary, claudemd, embedding],
      );
      const newId = ins.rows[0].id;
      if (firstEvent) {
        await this.pg.query(
          `INSERT INTO task_events (task_id, kind, content, agent_id) VALUES ($1, 'milestone', $2, $3)`,
          [newId, firstEvent, agentId],
        );
      }
      this.logger.log(`task created: ${newId} (${title}) for ${userId}`);
      return;
    }

    if (decision.action === 'append') {
      const taskId = String(decision.taskId || '').trim();
      if (!taskId) return;

      // Validate task exists + still belongs to this user.
      const own = await this.pg.query(
        `SELECT id, claudemd_locked FROM tasks WHERE id = $1 AND user_id = $2`,
        [taskId, userId],
      );
      if (!own.rows.length) {
        this.logger.warn(`append: task ${taskId} not found/owned by ${userId}, skipping`);
        return;
      }
      const claudemdLocked = own.rows[0].claudemd_locked === true;

      const eventContent = String(decision.eventContent || '').trim().slice(0, 2000);
      const newSummary = String(decision.newSummary || '').trim().slice(0, 500);
      const newClaudemd = !claudemdLocked && decision.newClaudemd
        ? String(decision.newClaudemd).trim().slice(0, 4000)
        : null;

      if (eventContent) {
        await this.pg.query(
          `INSERT INTO task_events (task_id, kind, content, agent_id) VALUES ($1, 'note', $2, $3)`,
          [taskId, eventContent, agentId],
        );
      }

      // Re-embed if any major field changed.
      let newEmbedding: number[] | null = null;
      if (newSummary || newClaudemd) {
        const tRes = await this.pg.query(`SELECT title, summary, claudemd FROM tasks WHERE id = $1`, [taskId]);
        const t = tRes.rows[0];
        newEmbedding = await this.embed(`${t.title}\n${newSummary || t.summary}\n${newClaudemd || t.claudemd}`);
      }

      const updates: string[] = ['last_active_at = now()', 'updated_at = now()'];
      const params: any[] = [];
      if (newSummary) {
        updates.push(`summary = $${params.length + 1}`);
        params.push(newSummary);
      }
      if (newClaudemd) {
        updates.push(`claudemd = $${params.length + 1}`);
        params.push(newClaudemd);
      }
      if (newEmbedding) {
        updates.push(`embedding = $${params.length + 1}`);
        params.push(newEmbedding);
      }
      params.push(taskId);
      await this.pg.query(`UPDATE tasks SET ${updates.join(', ')} WHERE id = $${params.length}`, params);
    }
  }

  /** OpenAI text-embedding-3-large, 256-dim (та же модель/размерность, что и в Neo4j profile-embedding для консистентности). */
  private async embed(text: string): Promise<number[] | null> {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey || !text?.trim()) return null;
    try {
      const r = await axios.post(
        'https://api.openai.com/v1/embeddings',
        { model: 'text-embedding-3-large', input: text.slice(0, 8000), dimensions: 256 },
        { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 15000 },
      );
      return r.data?.data?.[0]?.embedding || null;
    } catch (e: any) {
      this.logger.warn(`embed failed: ${e?.message}`);
      return null;
    }
  }

  /**
   * Толерантный JSON-парсер (повтор Neo4jService.extractJsonObject — модель
   * иногда возвращает с markdown-обёрткой или прозой вокруг).
   */
  private parseJsonTolerant(text: string): any | null {
    if (!text) return null;
    let s = text.trim();
    if (s.startsWith('```')) {
      s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
    }
    try { return JSON.parse(s); } catch {}
    const start = s.indexOf('{');
    if (start === -1) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
        }
      }
    }
    return null;
  }
}
