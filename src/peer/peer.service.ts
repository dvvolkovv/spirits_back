import {
  Injectable, Logger, BadRequestException, ForbiddenException,
  NotFoundException, ConflictException, OnModuleInit,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { PgService } from '../common/services/pg.service';
import {
  ChatRequestRow, PeerConversationRow, PeerMessageRow,
  CreateChatRequestDto, SendMessageDto, ReportUserDto, LIMITS,
} from './peer.dto';

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

@Injectable()
export class PeerService implements OnModuleInit {
  private readonly logger = new Logger(PeerService.name);

  constructor(private readonly pg: PgService) {}

  async onModuleInit() {
    // Look in both src/ (dev) and dist/ (prod) locations
    const candidates = [
      path.join(__dirname, 'migrations', '001_peer_tables.sql'),
      path.join(__dirname, '..', '..', 'src', 'peer', 'migrations', '001_peer_tables.sql'),
    ];
    for (const p of candidates) {
      try {
        if (fs.existsSync(p)) {
          const sql = fs.readFileSync(p, 'utf8');
          await this.pg.query(sql);
          this.logger.log(`peer migration 001 applied from ${p}`);
          return;
        }
      } catch (e: any) {
        this.logger.error(`peer migration failed (${p}): ${e.message}`);
      }
    }
    this.logger.warn('peer migration sql not found, skipping');
  }

  // ==================== REQUESTS ====================

  async sendRequest(fromUserId: string, dto: CreateChatRequestDto): Promise<{ id: string; status: string }> {
    const toUserId = (dto.toUserId || '').trim();
    const intro = (dto.introMessage || '').trim();

    if (!toUserId) throw new BadRequestException('toUserId required');
    if (toUserId === fromUserId) throw new BadRequestException('cannot request yourself');
    if (!intro) throw new BadRequestException('intro message required');
    if (intro.length > LIMITS.INTRO_MAX) {
      throw new BadRequestException(`intro message too long (max ${LIMITS.INTRO_MAX})`);
    }

    // Target must exist
    const target = await this.pg.query('SELECT 1 FROM ai_profiles_consolidated WHERE user_id = $1', [toUserId]);
    if (target.rows.length === 0) throw new NotFoundException('target user not found');

    // Blocks
    const blocked = await this.pg.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [fromUserId, toUserId],
    );
    if (blocked.rows.length > 0) throw new ForbiddenException('blocked');

    // Already have a conversation?
    const [a, b] = orderedPair(fromUserId, toUserId);
    const existingConv = await this.pg.query(
      'SELECT id FROM peer_conversations WHERE user_a_id = $1 AND user_b_id = $2',
      [a, b],
    );
    if (existingConv.rows.length > 0) {
      throw new ConflictException({ error: 'conversation_exists', conversationId: existingConv.rows[0].id });
    }

    // Already pending from me to them?
    const existingPending = await this.pg.query(
      `SELECT id FROM chat_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [fromUserId, toUserId],
    );
    if (existingPending.rows.length > 0) {
      throw new ConflictException({ error: 'request_already_pending', requestId: existingPending.rows[0].id });
    }

    // If they sent me a pending request — auto-accept instead
    const reverse = await this.pg.query(
      `SELECT id FROM chat_requests WHERE from_user_id = $1 AND to_user_id = $2 AND status = 'pending'`,
      [toUserId, fromUserId],
    );
    if (reverse.rows.length > 0) {
      const acc = await this.acceptRequest(fromUserId, reverse.rows[0].id);
      return { id: reverse.rows[0].id, status: 'accepted_mutual', ...(acc as any) };
    }

    // Limit: pending outgoing
    const pendingCount = await this.pg.query(
      `SELECT count(*)::int AS n FROM chat_requests WHERE from_user_id = $1 AND status = 'pending'`,
      [fromUserId],
    );
    if ((pendingCount.rows[0]?.n ?? 0) >= LIMITS.MAX_PENDING_OUTGOING) {
      throw new ForbiddenException(`too many pending requests (max ${LIMITS.MAX_PENDING_OUTGOING})`);
    }

    // Limit: rate window
    const rateCount = await this.pg.query(
      `SELECT count(*)::int AS n FROM chat_requests
       WHERE from_user_id = $1 AND created_at > now() - ($2 || ' seconds')::interval`,
      [fromUserId, String(LIMITS.RATE_WINDOW_SEC)],
    );
    if ((rateCount.rows[0]?.n ?? 0) >= LIMITS.RATE_MAX_PER_WINDOW) {
      throw new ForbiddenException(`rate limited (max ${LIMITS.RATE_MAX_PER_WINDOW}/hour)`);
    }

    const ins = await this.pg.query(
      `INSERT INTO chat_requests (from_user_id, to_user_id, intro_message, status)
       VALUES ($1, $2, $3, 'pending') RETURNING id`,
      [fromUserId, toUserId, intro],
    );
    return { id: ins.rows[0].id, status: 'pending' };
  }

  async listIncoming(userId: string) {
    const res = await this.pg.query(
      `SELECT r.*, p.profile_data AS from_profile
       FROM chat_requests r
       LEFT JOIN ai_profiles_consolidated p ON p.user_id = r.from_user_id
       WHERE r.to_user_id = $1 AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [userId],
    );
    return res.rows.map((r) => this.enrichRequest(r, 'from'));
  }

  async listOutgoing(userId: string) {
    const res = await this.pg.query(
      `SELECT r.*, p.profile_data AS to_profile
       FROM chat_requests r
       LEFT JOIN ai_profiles_consolidated p ON p.user_id = r.to_user_id
       WHERE r.from_user_id = $1 AND r.status = 'pending'
       ORDER BY r.created_at DESC`,
      [userId],
    );
    return res.rows.map((r) => this.enrichRequest(r, 'to'));
  }

  async acceptRequest(userId: string, requestId: string): Promise<{ conversationId: string; status: string }> {
    const r = await this.pg.query(
      `SELECT * FROM chat_requests WHERE id = $1`,
      [requestId],
    );
    const req = r.rows[0];
    if (!req) throw new NotFoundException('request not found');
    if (req.to_user_id !== userId) throw new ForbiddenException('not your request');
    if (req.status !== 'pending') throw new ConflictException(`request is ${req.status}`);

    const [a, b] = orderedPair(req.from_user_id, req.to_user_id);
    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE chat_requests SET status='accepted', responded_at=now() WHERE id=$1`,
        [req.id],
      );
      const conv = await client.query(
        `INSERT INTO peer_conversations (user_a_id, user_b_id, request_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_a_id, user_b_id) DO UPDATE SET user_a_id = peer_conversations.user_a_id
         RETURNING id`,
        [a, b, req.id],
      );
      await client.query('COMMIT');
      return { conversationId: conv.rows[0].id, status: 'accepted' };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async declineRequest(userId: string, requestId: string): Promise<{ ok: true }> {
    const r = await this.pg.query(
      `SELECT * FROM chat_requests WHERE id = $1`,
      [requestId],
    );
    const req = r.rows[0];
    if (!req) throw new NotFoundException('request not found');
    if (req.to_user_id !== userId) throw new ForbiddenException('not your request');
    if (req.status !== 'pending') throw new ConflictException(`request is ${req.status}`);

    await this.pg.query(
      `UPDATE chat_requests SET status='declined', responded_at=now() WHERE id=$1`,
      [req.id],
    );
    return { ok: true };
  }

  async withdrawRequest(userId: string, requestId: string): Promise<{ ok: true }> {
    const r = await this.pg.query(
      `SELECT * FROM chat_requests WHERE id = $1`,
      [requestId],
    );
    const req = r.rows[0];
    if (!req) throw new NotFoundException('request not found');
    if (req.from_user_id !== userId) throw new ForbiddenException('not your request');
    if (req.status !== 'pending') throw new ConflictException(`request is ${req.status}`);

    await this.pg.query(
      `UPDATE chat_requests SET status='withdrawn', responded_at=now() WHERE id=$1`,
      [req.id],
    );
    return { ok: true };
  }

  async getPendingRequestBetween(fromUserId: string, toUserId: string): Promise<ChatRequestRow | null> {
    const r = await this.pg.query(
      `SELECT * FROM chat_requests
       WHERE ((from_user_id=$1 AND to_user_id=$2) OR (from_user_id=$2 AND to_user_id=$1))
         AND status='pending'
       ORDER BY created_at DESC LIMIT 1`,
      [fromUserId, toUserId],
    );
    return r.rows[0] ?? null;
  }

  async getConversationBetween(userA: string, userB: string): Promise<PeerConversationRow | null> {
    const [a, b] = orderedPair(userA, userB);
    const r = await this.pg.query(
      `SELECT * FROM peer_conversations WHERE user_a_id=$1 AND user_b_id=$2`,
      [a, b],
    );
    return r.rows[0] ?? null;
  }

  // ==================== CONVERSATIONS ====================

  async listConversations(userId: string) {
    const res = await this.pg.query(
      `SELECT c.*,
              CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END AS peer_user_id,
              p.profile_data AS peer_profile,
              (SELECT m.content FROM peer_messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message_content,
              (SELECT m.sender_id FROM peer_messages m
                 WHERE m.conversation_id = c.id
                 ORDER BY m.created_at DESC LIMIT 1) AS last_message_sender_id,
              (SELECT count(*)::int FROM peer_messages m
                 WHERE m.conversation_id = c.id
                   AND m.sender_id <> $1
                   AND m.read_at IS NULL) AS unread_count
       FROM peer_conversations c
       LEFT JOIN ai_profiles_consolidated p
         ON p.user_id = CASE WHEN c.user_a_id = $1 THEN c.user_b_id ELSE c.user_a_id END
       WHERE c.user_a_id = $1 OR c.user_b_id = $1
       ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
       LIMIT 200`,
      [userId],
    );
    return res.rows.map((r) => ({
      id: r.id,
      peerUserId: r.peer_user_id,
      peerName: this.nameFromProfile(r.peer_profile, r.peer_user_id),
      peerAvatar: r.peer_profile?.avatar_url ?? null,
      lastMessage: r.last_message_content
        ? { content: r.last_message_content, senderId: r.last_message_sender_id, createdAt: r.last_message_at }
        : null,
      unreadCount: r.unread_count ?? 0,
      createdAt: r.created_at,
      lastMessageAt: r.last_message_at,
    }));
  }

  async getConversation(userId: string, conversationId: string) {
    const r = await this.pg.query(
      `SELECT * FROM peer_conversations WHERE id = $1`, [conversationId],
    );
    const conv = r.rows[0];
    if (!conv) throw new NotFoundException('conversation not found');
    if (conv.user_a_id !== userId && conv.user_b_id !== userId) {
      throw new ForbiddenException('not your conversation');
    }
    const peerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;
    const p = await this.pg.query(
      `SELECT profile_data FROM ai_profiles_consolidated WHERE user_id = $1`, [peerId],
    );
    return {
      id: conv.id,
      peerUserId: peerId,
      peerName: this.nameFromProfile(p.rows[0]?.profile_data, peerId),
      peerAvatar: p.rows[0]?.profile_data?.avatar_url ?? null,
      createdAt: conv.created_at,
      lastMessageAt: conv.last_message_at,
    };
  }

  async listMessages(userId: string, conversationId: string, beforeIso?: string, limit = 50) {
    await this.assertMember(userId, conversationId);
    const n = Math.max(1, Math.min(200, limit));
    const params: any[] = [conversationId];
    let whereBefore = '';
    if (beforeIso) { params.push(beforeIso); whereBefore = `AND created_at < $2`; }
    const res = await this.pg.query(
      `SELECT * FROM peer_messages
       WHERE conversation_id = $1 ${whereBefore}
       ORDER BY created_at DESC
       LIMIT ${n}`,
      params,
    );
    return res.rows.reverse().map((m) => ({
      id: m.id,
      conversationId: m.conversation_id,
      senderId: m.sender_id,
      content: m.content,
      createdAt: m.created_at,
      readAt: m.read_at,
    }));
  }

  async sendMessage(userId: string, conversationId: string, dto: SendMessageDto) {
    const content = (dto.content || '').trim();
    if (!content) throw new BadRequestException('content required');
    if (content.length > LIMITS.MESSAGE_MAX) {
      throw new BadRequestException(`message too long (max ${LIMITS.MESSAGE_MAX})`);
    }
    const conv = await this.assertMember(userId, conversationId);
    const peerId = conv.user_a_id === userId ? conv.user_b_id : conv.user_a_id;

    // Block check (either direction blocks)
    const blocked = await this.pg.query(
      `SELECT 1 FROM user_blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)`,
      [userId, peerId],
    );
    if (blocked.rows.length > 0) throw new ForbiddenException('blocked');

    const client = await this.pg.getClient();
    try {
      await client.query('BEGIN');
      const ins = await client.query<PeerMessageRow>(
        `INSERT INTO peer_messages (conversation_id, sender_id, content)
         VALUES ($1, $2, $3)
         RETURNING *`,
        [conversationId, userId, content],
      );
      await client.query(
        `UPDATE peer_conversations SET last_message_at = $1 WHERE id = $2`,
        [ins.rows[0].created_at, conversationId],
      );
      await client.query('COMMIT');
      const m = ins.rows[0];
      return {
        id: m.id, conversationId: m.conversation_id, senderId: m.sender_id,
        content: m.content, createdAt: m.created_at, readAt: m.read_at,
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async markRead(userId: string, conversationId: string) {
    await this.assertMember(userId, conversationId);
    await this.pg.query(
      `UPDATE peer_messages SET read_at = now()
       WHERE conversation_id = $1 AND sender_id <> $2 AND read_at IS NULL`,
      [conversationId, userId],
    );
    return { ok: true };
  }

  async getUnreadSummary(userId: string): Promise<{ incomingRequests: number; unreadMessages: number }> {
    const [req, msg] = await Promise.all([
      this.pg.query(
        `SELECT count(*)::int AS n FROM chat_requests WHERE to_user_id=$1 AND status='pending'`,
        [userId],
      ),
      this.pg.query(
        `SELECT count(*)::int AS n FROM peer_messages m
         JOIN peer_conversations c ON c.id = m.conversation_id
         WHERE (c.user_a_id = $1 OR c.user_b_id = $1)
           AND m.sender_id <> $1
           AND m.read_at IS NULL`,
        [userId],
      ),
    ]);
    return {
      incomingRequests: req.rows[0]?.n ?? 0,
      unreadMessages: msg.rows[0]?.n ?? 0,
    };
  }

  // ==================== BLOCKS / REPORTS ====================

  async block(blockerId: string, blockedId: string) {
    if (blockerId === blockedId) throw new BadRequestException('cannot block yourself');
    await this.pg.query(
      `INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [blockerId, blockedId],
    );
    return { ok: true };
  }

  async unblock(blockerId: string, blockedId: string) {
    await this.pg.query(
      `DELETE FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [blockerId, blockedId],
    );
    return { ok: true };
  }

  async report(reporterId: string, dto: ReportUserDto) {
    const targetId = (dto.targetUserId || '').trim();
    const reason = (dto.reason || '').trim();
    if (!targetId) throw new BadRequestException('targetUserId required');
    if (targetId === reporterId) throw new BadRequestException('cannot report yourself');
    if (!reason) throw new BadRequestException('reason required');
    if (reason.length > 2000) throw new BadRequestException('reason too long');

    await this.pg.query(
      `INSERT INTO user_reports (reporter_id, target_id, reason, context_type, context_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [reporterId, targetId, reason, dto.contextType ?? null, dto.contextId ?? null],
    );
    return { ok: true };
  }

  // ==================== HELPERS ====================

  private async assertMember(userId: string, conversationId: string): Promise<PeerConversationRow> {
    const r = await this.pg.query(
      `SELECT * FROM peer_conversations WHERE id = $1`, [conversationId],
    );
    const c = r.rows[0];
    if (!c) throw new NotFoundException('conversation not found');
    if (c.user_a_id !== userId && c.user_b_id !== userId) {
      throw new ForbiddenException('not your conversation');
    }
    return c;
  }

  private enrichRequest(row: any, side: 'from' | 'to') {
    const profile = side === 'from' ? row.from_profile : row.to_profile;
    const userId = side === 'from' ? row.from_user_id : row.to_user_id;
    return {
      id: row.id,
      fromUserId: row.from_user_id,
      toUserId: row.to_user_id,
      introMessage: row.intro_message,
      status: row.status,
      createdAt: row.created_at,
      respondedAt: row.responded_at,
      peerUserId: userId,
      peerName: this.nameFromProfile(profile, userId),
      peerAvatar: profile?.avatar_url ?? null,
    };
  }

  private nameFromProfile(profile: any, userId: string): string {
    if (!profile) return this.maskPhone(userId);
    const n = profile.name || profile.full_name || profile.display_name || profile.nickname;
    if (n && typeof n === 'string') return n;
    return this.maskPhone(userId);
  }

  private maskPhone(userId: string): string {
    if (!userId) return 'Пользователь';
    const digits = userId.replace(/\D/g, '');
    if (digits.length < 6) return 'Пользователь';
    return `+${digits.slice(0, 1)} *** *** ${digits.slice(-2)}`;
  }
}
