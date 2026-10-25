import { Injectable } from '@nestjs/common';
import { PgService } from '../common/services/pg.service';
import { TEST_USERS, TEST_USER_PATTERN } from '../common/test-users';
import { isCrisisConversation } from './crisis';
import type { Week } from './insights-week';
import { emptySignals, type Collected, type Conversation, type Signals, type Turn } from './insights.types';

export const MAX_CONVERSATIONS = 400;
export const CUSTOM_ASSISTANT = 'свой ассистент';

/**
 * «Живой пользователь»: не тестовый, не админ, не удалённый. Параметры $3
 * (тестовые номера) и $4 (маска) — общие для всех запросов сбора.
 */
export function liveUserSql(col: string): string {
  return `${col} <> ALL ($3::text[]) AND ${col} !~ $4
    AND NOT EXISTS (SELECT 1 FROM ai_profiles_consolidated ap WHERE ap.user_id = ${col} AND ap.isadmin)
    AND NOT EXISTS (SELECT 1 FROM user_id du WHERE du.internal_id = ${col} AND du.state = 'deleted')`;
}

/** Серии из двух и больше реплик человека подряд и реплики из одного «?». */
export function silenceSignals(turns: readonly Turn[]): { unansweredRuns: number; silentQuestionMarks: number } {
  let runs = 0;
  let marks = 0;
  let streak = 0;
  for (const t of turns) {
    if (t.role !== 'user') {
      streak = 0;
      continue;
    }
    streak += 1;
    if (streak === 2) runs += 1;
    if (/^[\s?？!.…]*[?？][\s?？!.…]*$/u.test(t.text)) marks += 1;
  }
  return { unansweredRuns: runs, silentQuestionMarks: marks };
}

type Head = Omit<Conversation, 'turns'>;

function group<R>(rows: readonly R[], keyOf: (r: R) => string, head: (r: R) => Head, turn: (r: R) => Turn): Conversation[] {
  const map = new Map<string, Conversation>();
  for (const row of rows) {
    const k = keyOf(row);
    let c = map.get(k);
    if (!c) {
      c = { ...head(row), turns: [] };
      map.set(k, c);
    }
    const t = turn(row);
    if (t.text.trim()) c.turns.push(t);
  }
  return [...map.values()];
}

@Injectable()
export class InsightsCollectService {
  constructor(private readonly pg: PgService) {}

  async collect(week: Week, maxConversations = MAX_CONVERSATIONS): Promise<Collected> {
    const p: unknown[] = [week.start, week.end, TEST_USERS, TEST_USER_PATTERN];
    const agents = await this.agentNames();
    const signals = emptySignals();
    const all = [
      ...(await this.web(p, agents)),
      ...(await this.telegram(p, agents, signals)),
      ...(await this.support(p)),
      ...(await this.calls(p, agents, signals)),
    ];
    signals.emptyOrFailedTurns = await this.badTurns(p);
    const kept: Conversation[] = [];
    for (const c of all) {
      if (!c.turns.some((t) => t.role === 'user')) continue;
      if (isCrisisConversation(c.turns)) {
        signals.crisisConversations += 1;
        continue;
      }
      const s = silenceSignals(c.turns);
      signals.unansweredRuns += s.unansweredRuns;
      signals.silentQuestionMarks += s.silentQuestionMarks;
      kept.push(c);
    }
    const userTurns = (c: Conversation) => c.turns.filter((t) => t.role === 'user').length;
    const conversations =
      kept.length > maxConversations ? [...kept].sort((a, b) => userTurns(b) - userTurns(a)).slice(0, maxConversations) : kept;
    const names = await this.names([...new Set(conversations.map((c) => c.userId))]);
    return { conversations, signals, names };
  }

  private async web(p: unknown[], agents: Map<string, string>): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT h.session_id, split_part(h.session_id, '_', 1) AS user_id, split_part(h.session_id, '_', 2) AS assistant_ref,
              h.sender_type, h.content
         FROM custom_chat_history h
        WHERE h.created_at >= $1 AND h.created_at < $2 AND h.message_type = 'text'
          AND ${liveUserSql(`split_part(h.session_id, '_', 1)`)}
        ORDER BY h.session_id, h.created_at, h.id`,
      p,
    );
    return group(
      r.rows,
      (row: any) => row.session_id,
      (row: any) => ({
        key: `web:${row.session_id}`,
        source: 'web',
        userId: row.user_id,
        assistant: String(row.assistant_ref).startsWith('custom:')
          ? CUSTOM_ASSISTANT
          : agents.get(String(row.assistant_ref)) ?? 'ассистент',
      }),
      (row: any) => ({ role: row.sender_type === 'human' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
  }

  /**
   * Telegram: личка и группы, где за всё время писал только владелец. В
   * остальных группах пишут посторонние без согласия — их текст не уходит
   * никуда, считаются только сигналы.
   */
  private async telegram(p: unknown[], agents: Map<string, string>, signals: Signals): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT c.id::text AS config_id, c.owner_user_id AS user_id, c.tg_chat_id::text AS chat_id,
              c.preset_agent_id, c.custom_agent_id::text AS custom_agent_id, m.role, m.content
         FROM tg_bot_messages m JOIN tg_bot_configs c ON c.id = m.config_id
        WHERE m.created_at >= $1 AND m.created_at < $2 AND m.role IN ('user', 'assistant')
          AND ${liveUserSql('c.owner_user_id')}
        ORDER BY c.id, m.created_at, m.id`,
      p,
    );
    if (!r.rows.length) return [];
    const chatOf = new Map<string, number>(r.rows.map((x: any) => [x.config_id, Number(x.chat_id)]));
    const groupIds = [...chatOf].filter(([, chat]) => chat < 0).map(([id]) => id);
    const ownerOnly = new Set<string>();
    if (groupIds.length) {
      const w = await this.pg.query(
        `SELECT m.config_id::text AS config_id,
                bool_and(m.tg_user_id IS NOT NULL AND i.tg_user_id IS NOT NULL AND m.tg_user_id = i.tg_user_id) AS only_owner
           FROM tg_bot_messages m
           JOIN tg_bot_configs c ON c.id = m.config_id
           LEFT JOIN tg_user_identities i ON i.linkeon_user_id = c.owner_user_id
          WHERE m.role = 'user' AND m.config_id = ANY ($1::uuid[])
          GROUP BY m.config_id`,
        [groupIds],
      );
      for (const row of w.rows) if (row.only_owner) ownerOnly.add(row.config_id);
    }
    const convs = group(
      r.rows,
      (row: any) => row.config_id,
      (row: any) => ({
        key: `tg:${row.config_id}`,
        source: 'tg',
        userId: row.user_id,
        assistant: row.custom_agent_id ? CUSTOM_ASSISTANT : agents.get(String(row.preset_agent_id)) ?? 'ассистент',
      }),
      (row: any) => ({ role: row.role === 'user' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
    const out: Conversation[] = [];
    for (const c of convs) {
      const id = c.key.slice('tg:'.length);
      if ((chatOf.get(id) ?? 0) > 0 || ownerOnly.has(id)) {
        out.push(c);
        continue;
      }
      signals.thirdPartyGroupsSkipped += 1;
      const s = silenceSignals(c.turns);
      signals.unansweredRuns += s.unansweredRuns;
      signals.silentQuestionMarks += s.silentQuestionMarks;
    }
    return out;
  }

  private async support(p: unknown[]): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT t.id::text AS ticket_id, t.user_id, s.sender_type, s.content
         FROM support_messages s JOIN support_tickets t ON t.id = s.ticket_id
        WHERE s.created_at >= $1 AND s.created_at < $2 AND s.visible_to_user
          AND s.sender_type IN ('user', 'ai', 'owner') AND ${liveUserSql('t.user_id')}
        ORDER BY t.id, s.created_at, s.id`,
      p,
    );
    return group(
      r.rows,
      (row: any) => row.ticket_id,
      (row: any) => ({ key: `support:${row.ticket_id}`, source: 'support', userId: row.user_id, assistant: 'Поддержка' }),
      (row: any) => ({ role: row.sender_type === 'user' ? 'user' : 'assistant', text: String(row.content ?? '') }),
    );
  }

  /** Звонок ассистенту один на один — расшифровка; встреча с людьми — только сигналы. */
  private async calls(p: unknown[], agents: Map<string, string>, signals: Signals): Promise<Conversation[]> {
    const r = await this.pg.query(
      `SELECT v.id::text AS call_id, v.user_id, v.agent_id::text AS agent_id, v.provider, v.status, v.transcript
         FROM voice_calls v
        WHERE v.started_at >= $1 AND v.started_at < $2 AND ${liveUserSql('v.user_id')}`,
      p,
    );
    const out: Conversation[] = [];
    for (const row of r.rows) {
      if (row.provider !== 'linkeon') {
        signals.meetingsTotal += 1;
        if (row.status !== 'completed') signals.meetingsFailed += 1;
        continue;
      }
      const items: any[] = Array.isArray(row.transcript) ? row.transcript : [];
      const turns: Turn[] = items
        .filter((t) => typeof t?.text === 'string' && t.text.trim())
        .map((t) => ({ role: t.role === 'user' ? 'user' : 'assistant', text: t.text }));
      if (turns.length) {
        out.push({
          key: `call:${row.call_id}`,
          source: 'call',
          userId: row.user_id,
          assistant: `${agents.get(String(row.agent_id)) ?? 'ассистент'} (звонок)`,
          turns,
        });
      }
    }
    return out;
  }

  private async badTurns(p: unknown[]): Promise<number> {
    const r = await this.pg.query(
      `SELECT count(*)::int AS bad FROM events e
        WHERE e.name = 'chat_quality' AND e.ts >= $1 AND e.ts < $2 AND e.user_id IS NOT NULL
          AND (COALESCE((e.props->>'empty')::boolean, false) OR COALESCE((e.props->>'failed')::boolean, false))
          AND ${liveUserSql('e.user_id')}`,
      p,
    );
    return Number(r.rows[0]?.bad ?? 0);
  }

  private async agentNames(): Promise<Map<string, string>> {
    const r = await this.pg.query(`SELECT id::text AS id, COALESCE(NULLIF(display_name, ''), name) AS name FROM agents`);
    return new Map(r.rows.map((x: any) => [String(x.id), String(x.name)]));
  }

  /** Имена для обезличивания: профиль, Telegram, часть почты до @. */
  private async names(userIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (!userIds.length) return out;
    const r = await this.pg.query(
      `SELECT a.user_id, a.email, a.profile_data->>'name' AS name, a.profile_data->>'family_name' AS family_name,
              a.profile_data->>'user_nickname' AS nick, i.tg_first_name, i.tg_username
         FROM ai_profiles_consolidated a LEFT JOIN tg_user_identities i ON i.linkeon_user_id = a.user_id
        WHERE a.user_id = ANY ($1::text[])`,
      [userIds],
    );
    for (const row of r.rows) {
      const list = [row.name, row.family_name, row.nick, row.tg_first_name, row.tg_username, String(row.email || '').split('@')[0]]
        .map((s) => String(s || '').trim())
        .filter((s) => Array.from(s).length >= 3);
      out.set(row.user_id, [...new Set(list)]);
    }
    return out;
  }
}
