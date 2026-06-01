import { Injectable, Logger, OnModuleInit, BadRequestException, NotFoundException } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import * as fs from 'fs';
import * as path from 'path';

export type BacklogStatus = 'proposed' | 'approved' | 'in_progress' | 'done' | 'rejected';
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
}

export interface BacklogComment {
  id: string;
  item_id: string;
  author_id: string | null;
  content: string;
  created_at: string;
}

const ALLOWED_STATUSES: BacklogStatus[] = ['proposed', 'approved', 'in_progress', 'done', 'rejected'];
const ALLOWED_COMPLEXITY: BacklogComplexity[] = ['low', 'medium', 'high'];

@Injectable()
export class BacklogService implements OnModuleInit {
  private readonly logger = new Logger(BacklogService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    const candidates = [
      path.join(__dirname, 'migrations', '001_backlog.sql'),
      path.join(__dirname, '..', '..', 'src', 'backlog', 'migrations', '001_backlog.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          await this.pg.query(fs.readFileSync(p, 'utf8'));
          this.logger.log(`backlog migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`backlog migration 001 failed (${p}): ${e.message}`);
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

    params.push(id);
    const r = await this.pg.query(
      `UPDATE backlog_items
          SET ${fields.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
        RETURNING *`,
      params,
    );
    if (!r.rows[0]) throw new NotFoundException('backlog item not found');
    return r.rows[0] as BacklogItem;
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
