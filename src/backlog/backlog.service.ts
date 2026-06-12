import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { ClaudeCliService } from '../common/services/claude-cli.service';
import * as fs from 'fs';
import * as path from 'path';

export type BacklogStatus = 'proposed' | 'approved' | 'in_progress' | 'waiting' | 'done' | 'rejected';
export type BacklogComplexity = 'low' | 'medium' | 'high';

export interface BacklogItem {
  id: string;
  title: string;
  analysis_md: string;
  effort: string | null;
  complexity: BacklogComplexity | null;
  costs: string | null;
  status: BacklogStatus;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  comments_count?: number;
  from_ticket_id?: string | null;
}

export interface BacklogComment {
  id: string;
  item_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
}

const ALLOWED_STATUSES: BacklogStatus[] = ['proposed', 'approved', 'in_progress', 'waiting', 'done', 'rejected'];
const ALLOWED_COMPLEXITY: BacklogComplexity[] = ['low', 'medium', 'high'];

@Injectable()
export class BacklogService implements OnModuleInit {
  private readonly logger = new Logger(BacklogService.name);

  constructor(
    private readonly pg: PgService,
    private readonly claude: ClaudeCliService,
  ) {}

  async onModuleInit() {
    for (const file of ['001_backlog.sql', '002_from_ticket.sql', '003_waiting_status.sql']) {
      const candidates = [
        path.join(__dirname, 'migrations', file),
        path.join(__dirname, '..', '..', 'src', 'backlog', 'migrations', file),
      ];
      for (const p of candidates) {
        try {
          if (fs.existsSync(p)) {
            await this.pg.query(fs.readFileSync(p, 'utf8'));
            this.logger.log(`backlog migration ${file} applied from ${p}`);
            break;
          }
        } catch (e: any) {
          this.logger.error(`backlog migration ${file} failed (${p}): ${e.message}`);
        }
      }
    }
  }

  async list(): Promise<BacklogItem[]> {
    // Newest-first ordering with comments_count rolled in so the list view
    // doesn't need a per-item round-trip.
    const res = await this.pg.query(
      `SELECT i.*,
              (SELECT COUNT(*) FROM backlog_comments c WHERE c.item_id = i.id)::int AS comments_count
         FROM backlog_items i
         ORDER BY
           CASE i.status
             WHEN 'in_progress' THEN 0
             WHEN 'approved'    THEN 1
             WHEN 'proposed'    THEN 2
             WHEN 'done'        THEN 3
             WHEN 'rejected'    THEN 4
           END,
           i.updated_at DESC`,
    );
    return res.rows as BacklogItem[];
  }

  async get(id: string): Promise<{ item: BacklogItem; comments: BacklogComment[] }> {
    const itemRes = await this.pg.query(`SELECT * FROM backlog_items WHERE id = $1`, [id]);
    const item = itemRes.rows[0] as BacklogItem | undefined;
    if (!item) throw new NotFoundException('backlog item not found');
    const cRes = await this.pg.query(
      `SELECT * FROM backlog_comments WHERE item_id = $1 ORDER BY created_at ASC`,
      [id],
    );
    return { item, comments: cRes.rows as BacklogComment[] };
  }

  async create(authorId: string, data: {
    title: string;
    analysis_md?: string;
    effort?: string;
    complexity?: BacklogComplexity;
    costs?: string;
    status?: BacklogStatus;
  }): Promise<BacklogItem> {
    const title = String(data.title || '').trim();
    if (!title) throw new BadRequestException('title required');
    const status = data.status && ALLOWED_STATUSES.includes(data.status) ? data.status : 'proposed';
    const complexity = data.complexity && ALLOWED_COMPLEXITY.includes(data.complexity) ? data.complexity : null;

    const res = await this.pg.query(
      `INSERT INTO backlog_items (title, analysis_md, effort, complexity, costs, status, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        title,
        data.analysis_md ?? '',
        data.effort ?? null,
        complexity,
        data.costs ?? null,
        status,
        authorId,
      ],
    );
    return res.rows[0] as BacklogItem;
  }

  // Build a backlog item from a support ticket conversation.
  // Reads the ticket + visible messages, asks Claude to summarize the
  // product gap into {title, analysis_md, complexity}, inserts a `proposed`
  // backlog item with a soft reference back to the ticket so we can later
  // notify the user when the feature ships.
  async createFromTicket(adminUserId: string, ticketId: string): Promise<BacklogItem> {
    const ticketRes = await this.pg.query(
      `SELECT id, user_id, topic FROM support_tickets WHERE id = $1`,
      [ticketId],
    );
    const ticket = ticketRes.rows[0] as { id: string; user_id: string; topic: string | null } | undefined;
    if (!ticket) throw new NotFoundException('ticket not found');

    const msgsRes = await this.pg.query(
      `SELECT sender_type, content, created_at
         FROM support_messages
        WHERE ticket_id = $1 AND visible_to_user = true
        ORDER BY created_at ASC`,
      [ticketId],
    );
    const messages = msgsRes.rows as Array<{ sender_type: string; content: string; created_at: string }>;
    if (messages.length === 0) throw new BadRequestException('ticket has no visible messages to summarize');

    const conversation = messages
      .map((m) => `[${m.sender_type.toUpperCase()}] ${String(m.content).slice(0, 2000)}`)
      .join('\n\n')
      .slice(0, 12000);

    const prompt = [
      'You are a product analyst on the my.linkeon.io support team.',
      'Read the support conversation below and summarize the underlying product gap — what feature is missing or broken — into a backlog item for the engineering team.',
      '',
      'Return ONLY valid JSON, no prose around it, with exactly these three fields:',
      '{',
      '  "title": "<short Russian feature title, 4-10 words>",',
      '  "analysis_md": "<markdown body in Russian. Three sections: ## Запрос пользователя, ## Что нужно сделать, ## Контекст из тикета>",',
      '  "complexity": "low" | "medium" | "high"',
      '}',
      '',
      'Conversation:',
      conversation,
    ].join('\n');

    let parsed: { title?: string; analysis_md?: string; complexity?: string } = {};
    try {
      const { text } = await this.claude.textWithCost(prompt, {
        model: 'claude-haiku-4-5',
        timeoutMs: 60_000,
      });
      // Claude sometimes wraps JSON in ```json ... ``` fences — strip.
      const cleaned = text.trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```\s*$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (e: any) {
      this.logger.warn(`createFromTicket: Claude parse failed (${e.message}), inserting a stub`);
      parsed = {
        title: ticket.topic || `Запрос от пользователя ${ticket.user_id}`,
        analysis_md: '## Запрос пользователя\n\n_Автоматическая сводка не получилась. Сырая переписка:_\n\n```\n' +
          conversation.slice(0, 4000) +
          '\n```',
        complexity: 'medium',
      };
    }

    const title = String(parsed.title || '').trim() || `Запрос из тикета ${ticketId.slice(0, 8)}`;
    const analysis = String(parsed.analysis_md || '').trim();
    const complexityIn = String(parsed.complexity || '').toLowerCase();
    const complexity: BacklogComplexity | null = ALLOWED_COMPLEXITY.includes(complexityIn as BacklogComplexity)
      ? complexityIn as BacklogComplexity
      : null;

    const ins = await this.pg.query(
      `INSERT INTO backlog_items
         (title, analysis_md, complexity, status, created_by, from_ticket_id)
       VALUES ($1, $2, $3, 'proposed', $4, $5)
       RETURNING *`,
      [title, analysis, complexity, adminUserId, ticketId],
    );
    return ins.rows[0] as BacklogItem;
  }

  async update(id: string, data: Partial<{
    title: string;
    analysis_md: string;
    effort: string | null;
    complexity: BacklogComplexity | null;
    costs: string | null;
    status: BacklogStatus;
  }>): Promise<BacklogItem> {
    const fields: string[] = [];
    const params: any[] = [];
    const push = (col: string, val: any) => {
      params.push(val);
      fields.push(`${col} = $${params.length}`);
    };

    if (data.title !== undefined) {
      const t = String(data.title || '').trim();
      if (!t) throw new BadRequestException('title cannot be empty');
      push('title', t);
    }
    if (data.analysis_md !== undefined) push('analysis_md', data.analysis_md);
    if (data.effort !== undefined) push('effort', data.effort);
    if (data.complexity !== undefined) {
      if (data.complexity !== null && !ALLOWED_COMPLEXITY.includes(data.complexity)) {
        throw new BadRequestException(`invalid complexity: ${data.complexity}`);
      }
      push('complexity', data.complexity);
    }
    if (data.costs !== undefined) push('costs', data.costs);
    if (data.status !== undefined) {
      if (!ALLOWED_STATUSES.includes(data.status)) {
        throw new BadRequestException(`invalid status: ${data.status}`);
      }
      push('status', data.status);
    }

    if (fields.length === 0) {
      // Touch updated_at even on no-op so the move-to-top sort behaves.
      const r = await this.pg.query(
        `UPDATE backlog_items SET updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      if (!r.rows[0]) throw new NotFoundException('backlog item not found');
      return r.rows[0] as BacklogItem;
    }

    // Snapshot the pre-update status so we can detect a transition to 'done'
    // and trigger the auto-notify-user-on-done flow below.
    const before = await this.pg.query(
      `SELECT status, title, from_ticket_id FROM backlog_items WHERE id = $1`,
      [id],
    );
    const prev = before.rows[0] as { status: BacklogStatus; title: string; from_ticket_id: string | null } | undefined;

    params.push(id);
    const r = await this.pg.query(
      `UPDATE backlog_items
          SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!r.rows[0]) throw new NotFoundException('backlog item not found');
    const updated = r.rows[0] as BacklogItem;

    // Phase-2 auto-notify: backlog item born from a ticket transitions to
    // done → drop a system-style message into the originating ticket so the
    // user gets a heads-up that the feature they asked for is now live.
    // We insert directly into support_messages to avoid a backlog→support
    // module dependency.
    if (
      prev && prev.from_ticket_id &&
      prev.status !== 'done' && updated.status === 'done'
    ) {
      try {
        const note = `🎉 Запрошенная вами доработка теперь доступна: «${updated.title}». Если что-то не работает или есть пожелания — напишите в ответ.`;
        await this.pg.query(
          `INSERT INTO support_messages (ticket_id, sender_type, sender_id, content)
           VALUES ($1, 'owner', $2, $3)`,
          [prev.from_ticket_id, 'backlog-automation', note],
        );
        await this.pg.query(
          `UPDATE support_tickets SET last_message_at = now(), updated_at = now() WHERE id = $1`,
          [prev.from_ticket_id],
        );
        this.logger.log(`Notified ticket ${prev.from_ticket_id} of backlog ${id} completion`);
      } catch (e: any) {
        this.logger.warn(`Failed to notify ticket ${prev.from_ticket_id}: ${e.message}`);
      }
    }

    return updated;
  }

  async remove(id: string): Promise<{ ok: true }> {
    const r = await this.pg.query(`DELETE FROM backlog_items WHERE id = $1 RETURNING id`, [id]);
    if (!r.rows[0]) throw new NotFoundException('backlog item not found');
    return { ok: true };
  }

  async addComment(itemId: string, authorId: string, content: string): Promise<BacklogComment> {
    const c = String(content || '').trim();
    if (!c) throw new BadRequestException('content required');
    const check = await this.pg.query(`SELECT 1 FROM backlog_items WHERE id = $1`, [itemId]);
    if (!check.rows[0]) throw new NotFoundException('backlog item not found');
    const res = await this.pg.query(
      `INSERT INTO backlog_comments (item_id, author_id, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [itemId, authorId, c],
    );
    // Bump parent updated_at so an active discussion floats the item up.
    await this.pg.query(`UPDATE backlog_items SET updated_at = now() WHERE id = $1`, [itemId]);
    return res.rows[0] as BacklogComment;
  }

  async deleteComment(commentId: string): Promise<{ ok: true }> {
    const r = await this.pg.query(`DELETE FROM backlog_comments WHERE id = $1 RETURNING id`, [commentId]);
    if (!r.rows[0]) throw new NotFoundException('comment not found');
    return { ok: true };
  }
}
